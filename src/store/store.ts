import { type Db, transaction } from '../db.js';
import { BruceError, clamp, newId, nowMs, parseJson } from '../util.js';
import {
  AGENT_STATUSES,
  HUMAN_ID,
  LIMITS,
  RESERVED_IDS,
  SYSTEM_ID,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  type Agent,
  type AgentFilter,
  type AgentInput,
  type AgentPatch,
  type AgentStatus,
  type ClaimResult,
  type PendingCounts,
  type Presence,
  type QueueStats,
  type QueueStatsAgents,
  type Session,
  type SessionInput,
  type SessionPatch,
  type SendInput,
  type Skill,
  type Task,
  type TaskEvent,
  type TaskEventType,
  type TaskFilter,
  type TaskStatus,
} from './types.js';

type Row = Record<string, unknown>;
type SqlValue = string | number | null;

/** Emitted after every committed mutation so waiters and subscribers can react immediately. */
export interface StoreChange {
  taskIds: string[];
  agentIds: string[];
}

export interface StoreOptions {
  now?: () => number;
}

export interface UnregisterResult {
  removed: boolean;
  requeued: number;
  canceled: number;
}

export interface SweepResult {
  requeued: number;
  dead_lettered: number;
  expired: number;
}

export class BruceStore {
  private readonly now: () => number;
  private readonly listeners = new Set<(change: StoreChange) => void>();
  private lastSweep = 0;

  constructor(
    public readonly db: Db,
    options: StoreOptions = {},
  ) {
    this.now = options.now ?? nowMs;
  }

  // ---------------------------------------------------------------- change events

  onChange(listener: (change: StoreChange) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(taskIds: Iterable<string | null | undefined>, agentIds: Iterable<string | null | undefined>): void {
    const change: StoreChange = {
      taskIds: [...new Set([...taskIds].filter((x): x is string => !!x))],
      agentIds: [...new Set([...agentIds].filter((x): x is string => !!x))],
    };
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // listeners must never break a committed mutation
      }
    }
  }

  // ---------------------------------------------------------------- agents

  /**
   * Register a new agent or update an existing one. For an existing agent only the fields provided
   * change (so an agent can re-register cheaply at the start of every session).
   * `asHuman` marks calls from the dashboard/CLI, which alone may switch require_approval off. `createOnly` refuses
   * (code `conflict`) instead of updating when the id is taken - for a caller that checked first that it may only
   * create this agent, so an agent registered by someone else in between is never changed.
   */
  registerAgent(input: AgentInput, options: { asHuman?: boolean; createOnly?: boolean } = {}): { agent: Agent; created: boolean } {
    const id = normalizeAgentId(input.id);
    const exists = transaction(this.db, () => {
      if (this.getAgentRow(id)) {
        if (options.createOnly) {
          throw new BruceError('conflict', `Agent "${id}" was registered by another session just now.`, 'Retry the call.');
        }
        const { id: _ignored, ...patch } = input;
        this.applyPatch(id, patch, options.asHuman === true);
        return true;
      }
      const profile = validateProfile(input, true);
      const now = this.now();
      this.db
        .prepare(
          `INSERT INTO agents (id, name, description, platform, instructions, skills, tags, accept_from, max_concurrent,
             require_approval, owner, workspace, version, metadata, status, status_message, registered_at, updated_at,
             last_seen_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          profile.name ?? id,
          profile.description ?? '',
          profile.platform ?? 'other',
          profile.instructions!,
          JSON.stringify(profile.skills ?? []),
          JSON.stringify(profile.tags ?? []),
          JSON.stringify(profile.accept_from ?? ['*']),
          profile.max_concurrent_tasks ?? 3,
          profile.require_approval ? 1 : 0,
          profile.owner ?? null,
          profile.workspace ?? null,
          profile.version ?? null,
          JSON.stringify(profile.metadata ?? {}),
          profile.status ?? 'online',
          profile.status_message ?? null,
          now,
          now,
          now,
        );
      return false;
    });
    this.emit([], [id]);
    return { agent: this.requireAgent(id), created: !exists };
  }

  /** Change some profile fields of a registered agent. */
  updateAgent(rawId: string, patch: AgentPatch, options: { asHuman?: boolean } = {}): Agent {
    const id = normalizeAgentIdLoose(rawId);
    transaction(this.db, () => {
      if (!this.getAgentRow(id)) throw unknownAgent(id);
      this.applyPatch(id, patch, options.asHuman === true);
    });
    this.emit([], [id]);
    return this.requireAgent(id);
  }

  private applyPatch(id: string, patch: AgentPatch, asHuman: boolean): void {
    const profile = validateProfile(patch, false);
    const sets: string[] = [];
    const values: SqlValue[] = [];
    const set = (column: string, value: SqlValue) => {
      sets.push(`${column}=?`);
      values.push(value);
    };
    if (profile.name !== undefined) set('name', profile.name);
    if (profile.description !== undefined) set('description', profile.description);
    if (profile.platform !== undefined) set('platform', profile.platform);
    if (profile.instructions !== undefined) set('instructions', profile.instructions);
    if (profile.skills !== undefined) set('skills', JSON.stringify(profile.skills));
    if (profile.tags !== undefined) set('tags', JSON.stringify(profile.tags));
    if (profile.accept_from !== undefined) set('accept_from', JSON.stringify(profile.accept_from));
    if (profile.max_concurrent_tasks !== undefined) set('max_concurrent', profile.max_concurrent_tasks);
    if (profile.require_approval !== undefined) {
      const current = rowToAgent(this.getAgentRow(id)!).require_approval;
      if (current && !profile.require_approval && !asHuman) {
        throw new BruceError(
          'not_allowed',
          'Only the human can turn off require_approval (use the Bruce Comm dashboard or CLI).',
        );
      }
      set('require_approval', profile.require_approval ? 1 : 0);
      if (profile.require_approval && !current) {
        // Unapproved queued agent work (also work reserved for a resume) now needs the human, or it could never be
        // claimed. Tasks in progress are held when they come back to the queue (see HOLD_SQL).
        this.db
          .prepare(
            `UPDATE tasks SET status='awaiting_approval', requires_approval=1, updated_at=?
             WHERE to_agent=? AND status='queued' AND approved_by IS NULL AND from_agent<>?`,
          )
          .run(this.now(), id, HUMAN_ID);
      }
    }
    if (profile.owner !== undefined) set('owner', profile.owner ?? null);
    if (profile.workspace !== undefined) set('workspace', profile.workspace ?? null);
    if (profile.version !== undefined) set('version', profile.version ?? null);
    if (profile.metadata !== undefined) set('metadata', JSON.stringify(profile.metadata));
    if (profile.status !== undefined) set('status', profile.status);
    if (profile.status_message !== undefined) set('status_message', profile.status_message ?? null);
    const now = this.now();
    set('updated_at', now);
    set('last_seen_at', now);
    this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id=?`).run(...values, id);
  }

  /**
   * Remove an agent. Work it was holding is handed back: skill-routed / open tasks are re-queued for
   * other agents (or failed when that was their last attempt); tasks addressed only to this agent are canceled because
   * nobody else can take them. An agent that requires approval can only be removed by the human (`asHuman`: dashboard,
   * REST, CLI) - otherwise any agent could unregister it and register it again without the approval gate.
   */
  unregisterAgent(rawId: string, options: { asHuman?: boolean } = {}): UnregisterResult {
    const id = normalizeAgentId(rawId);
    const now = this.now();
    const touched: string[] = [];
    const result = transaction(this.db, () => {
      const agentRow = this.getAgentRow(id);
      if (!agentRow) return { removed: false, requeued: 0, canceled: 0 };
      if (rowToAgent(agentRow).require_approval && options.asHuman !== true) {
        throw new BruceError(
          'not_allowed',
          `Only the human can remove "${id}": its tasks require the human's approval (use the Bruce Comm dashboard or CLI).`,
        );
      }
      let requeued = 0;
      let canceled = 0;
      const rows = this.db
        .prepare(
          `SELECT * FROM tasks WHERE status IN ('awaiting_approval','queued','working','input_required') AND (to_agent = ? OR assignee = ?)`,
        )
        .all(id, id) as Row[];
      for (const row of rows) {
        const task = rowToTask(row);
        touched.push(task.id);
        if (task.to_agent === id) {
          this.setTerminal(task.id, 'canceled', now, { status_message: `Recipient agent "${id}" unregistered.` });
          this.addEvent(task.id, SYSTEM_ID, 'canceled', `Recipient agent "${id}" unregistered.`);
          canceled++;
        } else if (task.attempts >= task.max_attempts) {
          const msg = `Assignee "${id}" unregistered during attempt ${task.attempts} of ${task.max_attempts}; giving up.`;
          this.setTerminal(task.id, 'failed', now, { error: msg });
          this.addEvent(task.id, SYSTEM_ID, 'failed', msg);
        } else {
          this.requeueInTx(task.id, now, `Re-queued: previous assignee "${id}" unregistered.`);
          this.addEvent(task.id, SYSTEM_ID, 'released', `Assignee "${id}" unregistered; task re-queued.`);
          requeued++;
        }
      }
      this.db.prepare('UPDATE sessions SET agent_id=NULL WHERE agent_id=?').run(id);
      this.db.prepare('DELETE FROM agents WHERE id=?').run(id);
      return { removed: true, requeued, canceled };
    });
    this.emit(touched, [id]);
    return result;
  }

  getAgent(rawId: string): Agent | undefined {
    const row = this.getAgentRow(normalizeAgentIdLoose(rawId));
    return row ? rowToAgent(row) : undefined;
  }

  requireAgent(rawId: string): Agent {
    const agent = this.getAgent(rawId);
    if (!agent) throw unknownAgent(rawId);
    return agent;
  }

  listAgents(filter: AgentFilter = {}): Agent[] {
    const now = this.now();
    let agents = (
      this.db.prepare(`SELECT a.*, ${CONNECTED_SESSIONS_SQL} FROM agents a ORDER BY a.id`).all(now - LIMITS.sessionStaleMs) as Row[]
    ).map(rowToAgent);
    if (filter.platform) agents = agents.filter((a) => a.platform === filter.platform);
    if (filter.status) agents = agents.filter((a) => a.status === filter.status);
    if (filter.skill) {
      const skill = filter.skill.trim().toLowerCase();
      agents = agents.filter((a) => agentRoutingKeys(a).has(skill));
    }
    if (filter.query) {
      const q = filter.query.trim().toLowerCase();
      agents = agents.filter((a) =>
        [a.id, a.name, a.description, a.platform, ...a.tags, ...a.skills.flatMap((s) => [s.id, s.name ?? '', s.description ?? '', ...(s.tags ?? [])])]
          .join('\n')
          .toLowerCase()
          .includes(q),
      );
    }
    if (filter.include_offline === false) agents = agents.filter((a) => presenceOf(a, now) !== 'offline');
    return agents;
  }

  /** Record that an agent is alive. `listeningUntil` marks it as blocked in a long-poll until that time. */
  touchAgent(rawId: string, listeningUntil?: number | null): void {
    const id = normalizeAgentIdLoose(rawId);
    const now = this.now();
    if (listeningUntil === undefined) {
      this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(now, id);
    } else {
      this.db.prepare('UPDATE agents SET last_seen_at=?, listening_until=? WHERE id=?').run(now, listeningUntil, id);
    }
  }

  presence(agent: Agent): Presence {
    return presenceOf(agent, this.now());
  }

  // ---------------------------------------------------------------- sessions

  /** Record a new connection (IDE window, app instance, runner). */
  openSession(input: SessionInput): Session {
    const id = input.id ? normalizeSessionId(input.id) : newId('S', 8);
    const now = this.now();
    const agentId = input.agent_id ? normalizeAgentIdLoose(input.agent_id) : null;
    this.db
      .prepare(
        `INSERT INTO sessions (id, agent_id, transport, client_name, client_version, label, workspaces, host_pid,
           started_at, heartbeat_at, last_active_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET closed_at=NULL, close_reason=NULL, heartbeat_at=excluded.heartbeat_at`,
      )
      .run(
        id,
        agentId,
        input.transport,
        optionalText(input.client_name, 'client_name', 200) ?? null,
        optionalText(input.client_version, 'client_version', 100) ?? null,
        sessionLabel(input.label),
        JSON.stringify(normalizeWorkspaces(input.workspaces)),
        input.host_pid ?? process.pid,
        now,
        now,
        agentId ? now : null,
      );
    this.emit([], [agentId]);
    return this.requireSession(id);
  }

  /** Change what is known about a session (client info from initialize, MCP roots, label, bound agent). */
  updateSession(rawId: string, patch: SessionPatch): Session {
    const id = normalizeSessionId(rawId);
    const sets: string[] = [];
    const values: SqlValue[] = [];
    const set = (column: string, value: SqlValue) => {
      sets.push(`${column}=?`);
      values.push(value);
    };
    if (patch.agent_id !== undefined) set('agent_id', patch.agent_id ? normalizeAgentIdLoose(patch.agent_id) : null);
    if (patch.client_name !== undefined) set('client_name', optionalText(patch.client_name, 'client_name', 200) ?? null);
    if (patch.client_version !== undefined) set('client_version', optionalText(patch.client_version, 'client_version', 100) ?? null);
    if (patch.label !== undefined) set('label', sessionLabel(patch.label));
    if (patch.workspaces !== undefined) set('workspaces', JSON.stringify(normalizeWorkspaces(patch.workspaces)));
    if (!sets.length) return this.requireSession(id);
    set('heartbeat_at', this.now());
    const before = this.getSession(id);
    const info = this.db.prepare(`UPDATE sessions SET ${sets.join(', ')} WHERE id=?`).run(...values, id);
    if (Number(info.changes) === 0) throw unknownSession(id);
    this.emit([], [before?.agent_id, patch.agent_id]);
    return this.requireSession(id);
  }

  /**
   * A tool call came through this session: refresh liveness (and optionally the long-poll marker). Reopens the session
   * if the sweeper closed it for a missing heartbeat (see {@link reviveSession}).
   */
  touchSession(rawId: string, options: { listeningUntil?: number | null } = {}): void {
    const id = normalizeSessionId(rawId);
    const now = this.now();
    if (options.listeningUntil === undefined) {
      this.db.prepare('UPDATE sessions SET last_active_at=?, heartbeat_at=? WHERE id=?').run(now, now, id);
    } else {
      this.db
        .prepare('UPDATE sessions SET last_active_at=?, heartbeat_at=?, listening_until=? WHERE id=?')
        .run(now, now, options.listeningUntil, id);
    }
    const revived = this.reviveSession(id, now);
    if (revived.length) this.emit([], revived);
  }

  /**
   * Called periodically by the process hosting these sessions: "these connections are still open". Reopens sessions
   * the sweeper closed for a missing heartbeat (see {@link reviveSession}).
   */
  heartbeatSessions(rawIds: string[]): void {
    if (!rawIds.length) return;
    const now = this.now();
    const stmt = this.db.prepare('UPDATE sessions SET heartbeat_at=? WHERE id=? AND closed_at IS NULL');
    const revived: string[] = [];
    for (const raw of rawIds) {
      const id = normalizeSessionId(raw);
      if (Number(stmt.run(now, id).changes) === 0) revived.push(...this.reviveSession(id, now));
    }
    if (revived.length) this.emit([], revived);
  }

  /**
   * The process hosting a session says it is still open, but the sweeper closed it for a missing heartbeat (the
   * machine slept, the clock jumped, the host was stalled): reopen it so it is listed, counted and reachable again.
   * Only that close reason is undone - a session closed by the human or by its own connection stays closed - and
   * nothing is routed back: work re-queued or un-pinned when it closed stays where it is. Returns the bound agent id
   * (for change events) when the row was reopened.
   */
  private reviveSession(id: string, now: number): string[] {
    // Read first: this runs on every tool call, and an open session needs no write.
    const row = this.db.prepare('SELECT agent_id, closed_at, close_reason FROM sessions WHERE id=?').get(id) as Row | undefined;
    if (!row || row.closed_at == null || row.close_reason !== NO_HEARTBEAT) return [];
    const info = this.db
      .prepare('UPDATE sessions SET closed_at=NULL, close_reason=NULL, heartbeat_at=? WHERE id=? AND closed_at IS NOT NULL AND close_reason=?')
      .run(now, id, NO_HEARTBEAT);
    return Number(info.changes) === 1 && row.agent_id ? [String(row.agent_id)] : [];
  }

  /**
   * Mark a session closed. Work routed to it is not lost: queued items pinned to it fall back to the agent's other
   * sessions (same workspace if one was recorded), and tasks it was working on go back to the queue.
   */
  closeSession(rawId: string, reason = 'closed'): void {
    const id = normalizeSessionId(rawId);
    const touched = transaction(this.db, () => this.closeSessionInTx(id, reason, this.now()));
    if (touched) this.emit(touched.taskIds, touched.agentIds);
  }

  getSession(rawId: string): Session | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id=?').get(normalizeSessionId(rawId)) as Row | undefined;
    return row ? rowToSession(row, this.now()) : undefined;
  }

  requireSession(rawId: string): Session {
    const session = this.getSession(rawId);
    if (!session) throw unknownSession(rawId);
    return session;
  }

  /** Sessions, newest first. By default only connected ones. */
  listSessions(filter: { agent_id?: string; include_closed?: boolean; limit?: number } = {}): Session[] {
    this.maybeSweep();
    const now = this.now();
    const where: string[] = [];
    const values: SqlValue[] = [];
    if (filter.agent_id) {
      where.push('agent_id = ?');
      values.push(normalizeAgentIdLoose(filter.agent_id));
    }
    if (!filter.include_closed) {
      where.push('closed_at IS NULL AND heartbeat_at >= ?');
      values.push(now - LIMITS.sessionStaleMs);
    }
    const limit = clamp(Math.round(filter.limit ?? 100), 1, 500);
    return (
      this.db
        .prepare(`SELECT * FROM sessions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY started_at DESC LIMIT ${limit}`)
        .all(...values) as Row[]
    ).map((row) => rowToSession(row, now));
  }

  private closeSessionInTx(id: string, reason: string, now: number): StoreChange | null {
    const session = this.db.prepare('SELECT * FROM sessions WHERE id=? AND closed_at IS NULL').get(id) as Row | undefined;
    if (!session) return null;
    this.db.prepare('UPDATE sessions SET closed_at=?, close_reason=?, listening_until=NULL WHERE id=?').run(now, reason, id);
    const agentId = (session.agent_id as string | null) ?? null;
    const taskIds: string[] = [];
    const agentIds: string[] = agentId ? [agentId] : [];
    // Unfinished items pinned to this session: release the pin (a dead session can never claim them).
    // to_workspace (recorded at send time) keeps them in the right workspace.
    for (const row of this.db
      .prepare(
        `SELECT id, to_workspace, from_agent FROM tasks
         WHERE to_session=? AND status IN ('awaiting_approval','queued','working','input_required')`,
      )
      .all(id) as Row[]) {
      const taskId = String(row.id);
      this.unpinInTx(taskId, `Session ${id} closed (${reason})`, agentId, row.to_workspace as string | null, now);
      taskIds.push(taskId);
      agentIds.push(String(row.from_agent));
    }
    // Work in progress in that session: the conversation that held it is gone, so put it back in the queue - unless
    // that was its last attempt (a task that keeps killing the process hosting its worker must not cycle forever).
    for (const row of this.db
      .prepare(`SELECT id, from_agent, assignee, attempts, max_attempts FROM tasks WHERE assignee_session=? AND status='working'`)
      .all(id) as Row[]) {
      const taskId = String(row.id);
      if (Number(row.attempts) >= Number(row.max_attempts)) {
        const msg =
          `Session ${id} of "${row.assignee}" closed (${reason}) during attempt ${row.attempts} of ${row.max_attempts} ` +
          'without completion; giving up.';
        this.setTerminal(taskId, 'failed', now, { error: msg });
        this.addEvent(taskId, SYSTEM_ID, 'failed', msg);
      } else {
        this.requeueInTx(taskId, now, `Re-queued: session ${id} of "${row.assignee}" closed while working (${reason}).`);
        this.addEvent(taskId, SYSTEM_ID, 'released', `Session ${id} closed while working (${reason}); task re-queued.`);
      }
      taskIds.push(taskId);
      agentIds.push(String(row.from_agent));
    }
    // Paused tasks keep their assignee agent but lose the session affinity.
    this.db
      .prepare(
        `UPDATE tasks SET assignee_session=NULL WHERE assignee_session=? AND status IN ('input_required','queued','awaiting_approval')`,
      )
      .run(id);
    return { taskIds, agentIds };
  }

  /** Drop a task's session pin (and its resume marker); to_workspace, recorded at send time, keeps it in the right workspace. */
  private unpinInTx(taskId: string, why: string, agentId: string | null, toWorkspace: string | null, now: number): void {
    this.db.prepare('UPDATE tasks SET to_session=NULL, resume_session=NULL, updated_at=? WHERE id=?').run(now, taskId);
    const who = agentId ? `"${agentId}"` : 'the agent';
    const where = toWorkspace ? `a session of ${who} with workspace "${toWorkspace}"` : `any session of ${who}`;
    this.addEvent(taskId, SYSTEM_ID, 'rerouted', `${why}; now available to ${where}.`);
  }

  /**
   * Put a claimed, paused or reserved task back in the open queue: the claim and any resume pin are dropped. A task
   * addressed to an agent that requires approval, which the human never approved (the gate was turned on after it was
   * queued), is held for approval again instead of waiting in a queue its recipient may not claim from.
   */
  private requeueInTx(taskId: string, now: number, statusMessage: string, options: { refundAttempt?: boolean; error?: string } = {}): void {
    this.db
      .prepare(
        `UPDATE tasks SET status=CASE WHEN ${HOLD_SQL} THEN 'awaiting_approval' ELSE 'queued' END,
           requires_approval=CASE WHEN ${HOLD_SQL} THEN 1 ELSE requires_approval END,
           assignee=NULL, assignee_session=NULL, lease_expires_at=NULL, ${DROP_RESUME_PIN_SQL},
           attempts=${options.refundAttempt ? 'MAX(attempts-1, 0)' : 'attempts'}, error=COALESCE(?, error), status_message=?,
           updated_at=? WHERE id=?`,
      )
      .run(options.error ?? null, statusMessage, now, taskId);
  }

  // ---------------------------------------------------------------- sending

  /** Queue a task or message. Returns one task, or one per recipient for a broadcast. */
  send(
    fromRaw: string,
    input: SendInput,
    options: { sessionId?: string | null } = {},
  ): { tasks: Task[]; deduplicated: boolean; warnings: string[] } {
    const fromSession = options.sessionId ? normalizeSessionId(options.sessionId) : null;
    const from = this.requireActor(fromRaw);
    const kind = input.kind ?? 'task';
    if (kind !== 'task' && kind !== 'message') throw new BruceError('invalid_argument', `kind must be "task" or "message".`);
    const routes = [input.to_agent ? 1 : 0, input.to_skill ? 1 : 0, input.broadcast ? 1 : 0].reduce((a, b) => a + b, 0);
    if (routes !== 1) {
      throw new BruceError(
        'invalid_argument',
        'Specify exactly one recipient: to_agent (an agent id, or "*" for any agent), to_skill, or broadcast=true.',
        'Use list_agents to find agent ids and skills.',
      );
    }
    const title = requireText(input.title, 'title', LIMITS.titleMax);
    const body = optionalText(input.body, 'body', LIMITS.bodyMax) ?? '';
    const inputJson = encodeJson(input.input, 'input');
    const priority = clamp(Math.round(input.priority ?? LIMITS.defaultPriority), 0, 9);
    const leaseSeconds = clamp(
      Math.round(input.lease_seconds ?? LIMITS.defaultLeaseSeconds),
      LIMITS.minLeaseSeconds,
      LIMITS.maxLeaseSeconds,
    );
    const maxAttempts = clamp(Math.round(input.max_attempts ?? LIMITS.defaultMaxAttempts), 1, LIMITS.maxAttempts);
    const idempotencyKey = optionalText(input.idempotency_key, 'idempotency_key', 200) ?? null;
    if ((input.to_session || input.to_workspace) && (!input.to_agent || input.to_agent === '*')) {
      throw new BruceError(
        'invalid_argument',
        'to_session / to_workspace need to_agent set to a specific agent id.',
        'Use list_sessions to see which sessions (IDE windows) each agent has open.',
      );
    }
    const now = this.now();
    const expiresAt =
      input.expires_in_seconds != null ? now + Math.max(1, Math.round(input.expires_in_seconds)) * 1000 : null;
    const notBefore = input.delay_seconds != null && input.delay_seconds > 0 ? now + Math.round(input.delay_seconds) * 1000 : null;
    const warnings: string[] = [];
    // Close sessions that are gone BEFORE checking that to_session is connected - in a transaction of its own, so the
    // close sticks even when this send is refused for it.
    if (input.to_session) this.maybeSweep();

    const outcome = transaction(this.db, () => {
      // Idempotency: a retried send returns the original task(s) instead of queueing duplicates. Every copy of a
      // broadcast stores the key as given (the unique index is per sender AND recipient), so an exact match finds them.
      if (idempotencyKey) {
        const existing = (
          this.db
            .prepare(`SELECT * FROM tasks WHERE from_agent=? AND idempotency_key=? ORDER BY created_at, id`)
            .all(from, idempotencyKey) as Row[]
        ).map(rowToTask);
        if (existing.length) return { tasks: existing, deduplicated: true };
      }

      let parentThread: string | null = null;
      let parentId: string | null = null;
      let parentTask: Task | null = null;
      let depth = 0;
      if (input.parent_task_id) {
        const parent = this.getTaskRow(input.parent_task_id);
        if (!parent) throw unknownTask(input.parent_task_id);
        parentTask = rowToTask(parent);
        parentId = String(parent.id);
        parentThread = String(parent.thread_id);
        depth = Number(parent.depth) + 1;
        if (depth > LIMITS.maxDepth) {
          throw new BruceError(
            'too_deep',
            `Delegation chain too deep (${depth} > ${LIMITS.maxDepth}). Agents may be delegating in a loop.`,
            'Do the work yourself or report back to the original sender instead of delegating further.',
          );
        }
      }
      const threadId = optionalText(input.thread_id, 'thread_id', 100) ?? parentThread;

      type Recipient = { to_agent: string | null; to_skill: string | null; key: string | null; approval: boolean };
      let toSession: string | null = null;
      let toWorkspace: string | null = null;
      let recipients: Recipient[];
      let broadcastId: string | null = null;
      // Tasks from the human never need approval: the human is the approver.
      const needsApproval = (target?: Agent) =>
        from !== HUMAN_ID && (input.requires_approval === true || (target?.require_approval ?? false));
      // Skill-routed / open work: when every agent that could take it requires approval, nobody could ever claim it
      // unapproved - hold it for the human instead of leaving it stranded in the queue.
      const onlyGated = (candidates: Agent[]) =>
        from !== HUMAN_ID && candidates.length > 0 && candidates.every((a) => a.require_approval);
      if (input.broadcast) {
        const targets = this.listAgents().filter((a) => a.id !== from && accepts(a, from));
        if (!targets.length) {
          throw new BruceError('no_recipients', 'No other registered agent accepts messages from you.', 'Use list_agents to see who is registered.');
        }
        if (targets.length > LIMITS.maxBroadcastRecipients) {
          throw new BruceError(
            'too_many_recipients',
            `Broadcast would reach ${targets.length} agents (max ${LIMITS.maxBroadcastRecipients}).`,
            'Route by to_skill instead.',
          );
        }
        broadcastId = newId('B');
        recipients = targets.map((a) => ({ to_agent: a.id, to_skill: null, key: idempotencyKey, approval: needsApproval(a) }));
      } else if (input.to_skill) {
        const skill = input.to_skill.trim().toLowerCase();
        if (!skill) throw new BruceError('invalid_argument', 'to_skill must not be empty.');
        assertPlainText(skill, 'to_skill');
        const able = this.listAgents({ skill }).filter((a) => a.id !== from);
        const willing = able.filter((a) => accepts(a, from));
        if (!able.length) {
          warnings.push(`No registered agent currently offers skill "${skill}". The task stays queued until one registers.`);
        } else if (!willing.length) {
          warnings.push(`Agents offering "${skill}" do not accept tasks from "${from}"; it will wait until one does.`);
        }
        recipients = [{ to_agent: null, to_skill: skill, key: idempotencyKey, approval: needsApproval() || onlyGated(willing) }];
      } else if (input.to_agent === '*') {
        const willing = this.listAgents().filter((a) => a.id !== from && accepts(a, from));
        recipients = [{ to_agent: null, to_skill: null, key: idempotencyKey, approval: needsApproval() || onlyGated(willing) }];
      } else {
        const target = this.getAgent(input.to_agent!);
        if (!target) throw unknownAgent(input.to_agent!);
        if (!accepts(target, from)) {
          throw new BruceError(
            'not_allowed',
            `Agent "${target.id}" does not accept tasks from "${from}" (accept_from: ${target.accept_from.join(', ')}).`,
          );
        }
        if (presenceOf(target, now) === 'offline') {
          warnings.push(`Agent "${target.id}" has not been seen for a while; the task will wait in its queue.`);
        }
        recipients = [{ to_agent: target.id, to_skill: null, key: idempotencyKey, approval: needsApproval(target) }];
        if (input.to_session) {
          // listSessions sweeps first: read the session after it, or a session the sweep just closed would look
          // connected and the task would be pinned to it with nothing left to un-pin it.
          const live = this.listSessions({ agent_id: target.id });
          const session = this.getSession(input.to_session);
          const options = live.length
            ? `Connected sessions of "${target.id}": ${live.map((x) => `${x.id} (${describeSession(x)})`).join('; ')}.`
            : `"${target.id}" has no connected session right now; send without to_session and it will be picked up next time.`;
          if (!session || session.agent_id !== target.id) {
            throw new BruceError('unknown_session', `No session "${input.to_session}" belongs to agent "${target.id}".`, options);
          }
          if (!session.connected) {
            throw new BruceError('session_closed', `Session ${session.id} of "${target.id}" is no longer connected.`, options);
          }
          toSession = session.id;
          // Fallback key if the session closes before claiming: its primary workspace, else its label.
          toWorkspace = session.workspaces[0] ?? (session.label ? session.label.toLowerCase() : null);
        }
        if (!input.to_session && !input.to_workspace && parentTask) {
          // Follow-up on an earlier task: reach the same window that was involved in it - the session that SENT
          // the parent (when replying to its sender) or the session that WORKED on it (when following up with
          // its assignee). Falls back to that session's workspace if it has closed since.
          const via =
            parentTask.from_agent === target.id
              ? parentTask.from_session
              : parentTask.assignee === target.id
                ? parentTask.assignee_session
                : null;
          const session = via ? this.getSession(via) : undefined;
          if (session && session.agent_id === target.id) {
            toSession = session.connected ? session.id : null;
            toWorkspace = session.workspaces[0] ?? (session.label ? session.label.toLowerCase() : null);
            // Same warning as an explicit to_workspace: otherwise a reply to a closed window waits unnoticed.
            const fallback = toWorkspace;
            if (!toSession && fallback && !this.listSessions({ agent_id: target.id }).some((x) => sessionRoutingKeys(x).includes(fallback))) {
              warnings.push(
                `The session of "${target.id}" involved in ${parentTask.id} has closed and no connected session has its workspace ` +
                  `"${fallback}" open; this waits until one does. To reach another session now, add to_session (see list_sessions).`,
              );
            }
          }
        }
        if (input.to_workspace) {
          toWorkspace = normalizeWorkspace(input.to_workspace);
          if (!toWorkspace) throw new BruceError('invalid_argument', 'to_workspace must not be empty.');
          const matching = this.listSessions({ agent_id: target.id }).filter((x) => sessionRoutingKeys(x).includes(toWorkspace!));
          if (!matching.length) {
            warnings.push(
              `No connected session of "${target.id}" has workspace "${input.to_workspace}" open; the task waits until one does.`,
            );
          }
        }
      }

      for (const r of recipients) this.checkLimits(from, r.to_agent, r.to_skill, now);
      if (recipients.some((r) => r.approval)) {
        warnings.push('Held until the human approves it in the Bruce Comm dashboard or CLI (status "awaiting_approval").');
      }

      const insert = this.db.prepare(
        `INSERT INTO tasks (id, kind, from_agent, to_agent, to_skill, title, body, input, priority, depth,
           requires_approval, status, thread_id, parent_task_id, broadcast_id, idempotency_key, lease_seconds,
           max_attempts, created_at, updated_at, not_before, expires_at, to_session, to_workspace, from_session)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      );
      const created: Task[] = [];
      for (const r of recipients) {
        const id = newId(kind === 'task' ? 'T' : 'M');
        insert.run(
          id,
          kind,
          from,
          r.to_agent,
          r.to_skill,
          title,
          body,
          inputJson,
          priority,
          depth,
          r.approval ? 1 : 0,
          r.approval ? 'awaiting_approval' : 'queued',
          threadId ?? id,
          parentId,
          broadcastId,
          r.key,
          leaseSeconds,
          maxAttempts,
          now,
          now,
          notBefore,
          expiresAt,
          toSession,
          toWorkspace,
          fromSession,
        );
        this.addEvent(id, from, 'created', null, null);
        created.push(this.requireTask(id));
      }
      return { tasks: created, deduplicated: false };
    });

    if (!outcome.deduplicated) {
      this.emit(
        outcome.tasks.map((t) => t.id),
        [from, ...outcome.tasks.map((t) => t.to_agent)],
      );
    }
    return { ...outcome, warnings };
  }

  /** Loop / flood protection: per-recipient rate limit and queue depth cap. The human is exempt. */
  private checkLimits(from: string, toAgent: string | null, toSkill: string | null, now: number): void {
    if (from === HUMAN_ID) return;
    const since = now - LIMITS.rateWindowMs;
    const recent = Number(
      (
        this.db
          .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE from_agent=? AND to_agent IS ? AND to_skill IS ? AND created_at >= ?`)
          .get(from, toAgent, toSkill, since) as Row
      ).n,
    );
    if (recent >= LIMITS.rateLimitPerRecipient) {
      const target = toAgent ?? (toSkill ? `skill "${toSkill}"` : 'any agent');
      throw new BruceError(
        'rate_limited',
        `You sent ${recent} items to ${target} in the last ${LIMITS.rateWindowMs / 60000} minutes (limit ${LIMITS.rateLimitPerRecipient}).`,
        'Batch the work into fewer, larger tasks, or wait for results before sending more.',
      );
    }
    if (toAgent) {
      const waiting = Number(
        (
          this.db
            .prepare(`SELECT COUNT(*) AS n FROM tasks WHERE to_agent=? AND status IN ('awaiting_approval','queued')`)
            .get(toAgent) as Row
        ).n,
      );
      if (waiting >= LIMITS.maxQueuedPerAgent) {
        throw new BruceError('queue_full', `Agent "${toAgent}" already has ${waiting} items waiting.`, 'Try again later.');
      }
    }
  }

  /**
   * The human approves a held task; it joins the queue. A queued agent task nobody approved can be approved too: an
   * agent that requires approval only claims approved work, so this is the human's way to release such a task to it
   * (e.g. skill-routed work queued before that agent turned its approval gate on).
   */
  approve(taskId: string, note?: string): Task {
    const text = optionalText(note, 'note', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireTask(taskId);
      const unapprovedQueued = task.status === 'queued' && !task.approved_by && task.from_agent !== HUMAN_ID;
      if (task.status !== 'awaiting_approval' && !unapprovedQueued) {
        throw new BruceError(
          'invalid_state',
          task.status === 'queued'
            ? `Task ${task.id} is already approved (or from the human) and queued.`
            : `Task ${task.id} is "${task.status}", not "awaiting_approval".`,
        );
      }
      const now = this.now();
      this.db
        .prepare(`UPDATE tasks SET status='queued', approved_by=?, status_message=NULL, updated_at=? WHERE id=?`)
        .run(HUMAN_ID, now, task.id);
      this.addEvent(task.id, HUMAN_ID, 'approved', text ?? null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [task.from_agent, task.to_agent]);
    return task;
  }

  /** The human refuses a held task. */
  deny(taskId: string, reason?: string): Task {
    const text = optionalText(reason, 'reason', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireTask(taskId);
      if (task.status !== 'awaiting_approval') {
        throw new BruceError('invalid_state', `Task ${task.id} is "${task.status}", not "awaiting_approval".`);
      }
      this.setTerminal(task.id, 'rejected', this.now(), { error: text ?? 'Denied by the human.' });
      this.addEvent(task.id, HUMAN_ID, 'denied', text ?? null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [task.from_agent, task.to_agent]);
    return task;
  }

  /** Record that the sender has seen these tasks' outcomes (clears the results_ready counter). */
  markResultsSeen(agentRaw: string, taskIds: string[]): void {
    const agentId = normalizeAgentIdLoose(agentRaw);
    if (!taskIds.length) return;
    const terminal = [...TERMINAL_STATUSES];
    const stmt = this.db.prepare(
      `UPDATE tasks SET result_seen=1 WHERE id=? AND from_agent=? AND result_seen=0 AND status IN (${terminal.map(() => '?').join(',')})`,
    );
    for (const id of taskIds) stmt.run(String(id).trim().toUpperCase(), agentId, ...terminal);
  }

  // ---------------------------------------------------------------- receiving

  /**
   * Atomically claim the best task this agent may work on: reserved first, then priority, then age.
   * `sessionId` is the calling connection: tasks pinned to another session or workspace are skipped - a pin to a
   * session that is not connected does not bind, so its workspace fallback applies (see SESSION_SQL).
   */
  claimNext(agentRaw: string, sessionId?: string | null): ClaimResult {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const session = sessionId ? this.getSession(sessionId) ?? null : null;
    const result = transaction(this.db, (): ClaimResult => {
      this.sweepInTx();
      const agent = this.requireAgent(agentId);
      const now = this.now();
      const busy = Number(
        (this.db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE assignee=? AND status='working'`).get(agentId) as Row).n,
      );
      if (busy >= agent.max_concurrent_tasks) {
        return {
          task: null,
          reason: `You already hold ${busy} working task(s) (max_concurrent_tasks=${agent.max_concurrent_tasks}). Complete, fail or release one first.`,
        };
      }
      const candidates = this.eligibleRows(agent, 'task', now, 50, session);
      for (const row of candidates) {
        const task = rowToTask(row);
        if (!mayDeliver(agent, task)) continue;
        // A task taken through another session than its pin (the pinned one was not connected, see SESSION_SQL) loses
        // the pin: the session that holds the work now is where an answered question must come back to.
        const info = this.db
          .prepare(
            `UPDATE tasks SET status='working', assignee=?, assignee_session=?, attempts=attempts+1, claimed_at=?,
               lease_expires_at=?, status_message=NULL,
               to_session=CASE WHEN to_session = resume_session OR to_session IS NOT ? THEN NULL ELSE to_session END,
               resume_session=NULL, updated_at=? WHERE id=? AND status='queued'`,
          )
          .run(agentId, session?.id ?? null, now, now + task.lease_seconds * 1000, session?.id ?? null, now, task.id);
        if (Number(info.changes) === 1) {
          this.noteFallbackDelivery(task, session);
          this.addEvent(task.id, agentId, 'claimed', `Attempt ${task.attempts + 1} of ${task.max_attempts}.`);
          return { task: this.requireTask(task.id) };
        }
      }
      return { task: null };
    });
    this.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(this.now(), agentId);
    if (session) this.touchSession(session.id);
    if (result.task) this.emit([result.task.id], [agentId, result.task.from_agent]);
    return result;
  }

  /** Deliver pending messages (kind=message). Messages are complete once delivered. */
  takeMessages(agentRaw: string, limit: number = LIMITS.messagesPerFetch, sessionId?: string | null): Task[] {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const session = sessionId ? this.getSession(sessionId) ?? null : null;
    const delivered = transaction(this.db, () => {
      this.sweepInTx();
      const agent = this.requireAgent(agentId);
      const now = this.now();
      const out: Task[] = [];
      for (const row of this.eligibleRows(agent, 'message', now, clamp(limit, 1, 100) * 2, session)) {
        if (out.length >= limit) break;
        const msg = rowToTask(row);
        if (!mayDeliver(agent, msg)) continue;
        const info = this.db
          .prepare(
            `UPDATE tasks SET status='completed', assignee=?, assignee_session=?, attempts=attempts+1, claimed_at=?,
               completed_at=?, status_message='delivered', updated_at=? WHERE id=? AND status='queued'`,
          )
          .run(agentId, session?.id ?? null, now, now, now, msg.id);
        if (Number(info.changes) === 1) {
          this.noteFallbackDelivery(msg, session);
          this.addEvent(msg.id, agentId, 'delivered', null);
          out.push(this.requireTask(msg.id));
        }
      }
      return out;
    });
    if (delivered.length) this.emit(delivered.map((t) => t.id), [agentId, ...delivered.map((t) => t.from_agent)]);
    return delivered;
  }

  /**
   * Undo the delivery of messages the agent never saw (its get_next_task was canceled, or failed, after takeMessages
   * had marked them delivered): they go back to the queue as if never delivered. Only messages this agent received
   * that are still marked delivered are returned. Returns how many went back.
   */
  returnMessages(agentRaw: string, messageIds: string[]): number {
    const agentId = normalizeAgentIdLoose(agentRaw);
    if (!messageIds.length) return 0;
    const returned = transaction(this.db, () => {
      const now = this.now();
      const stmt = this.db.prepare(
        `UPDATE tasks SET status='queued', assignee=NULL, assignee_session=NULL, attempts=MAX(attempts-1, 0), claimed_at=NULL,
           completed_at=NULL, status_message=NULL, updated_at=?
         WHERE id=? AND kind='message' AND status='completed' AND assignee=? AND status_message='delivered'`,
      );
      const out: Task[] = [];
      for (const raw of messageIds) {
        const id = String(raw).trim().toUpperCase();
        if (Number(stmt.run(now, id, agentId).changes) !== 1) continue;
        this.addEvent(id, agentId, 'released', 'Delivery canceled before the recipient saw it; back in the queue.');
        out.push(this.requireTask(id));
      }
      return out;
    });
    if (returned.length) this.emit(returned.map((t) => t.id), [agentId, ...returned.map((t) => t.from_agent)]);
    return returned.length;
  }

  /** Report progress on a claimed task. Also renews the lease, so long-running work is not re-queued. */
  progress(agentRaw: string, taskId: string, message?: string, percent?: number): Task {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const note = optionalText(message, 'message', LIMITS.noteMax);
    const pct = percent == null ? null : clamp(Math.round(percent), 0, 100);
    const task = transaction(this.db, () => {
      const task = this.requireOwnedTask(agentId, taskId, ['working']);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE tasks SET lease_expires_at=?, progress=COALESCE(?, progress), status_message=COALESCE(?, status_message), updated_at=? WHERE id=?`,
        )
        .run(now + task.lease_seconds * 1000, pct, note ?? null, now, task.id);
      if (note || pct != null) this.addEvent(task.id, agentId, 'progress', note ?? null, pct != null ? { percent: pct } : null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [agentId, task.from_agent]);
    return task;
  }

  /** Assignee asks the sender a question. The task pauses (no lease) until provide_input is called. */
  requestInput(agentRaw: string, taskId: string, question: string): Task {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const q = requireText(question, 'question', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireOwnedTask(agentId, taskId, ['working']);
      if (task.kind !== 'task') throw new BruceError('invalid_state', 'Messages do not support input requests.');
      const now = this.now();
      this.db
        .prepare(`UPDATE tasks SET status='input_required', lease_expires_at=NULL, status_message=?, updated_at=? WHERE id=?`)
        .run(q, now, task.id);
      this.addEvent(task.id, agentId, 'input_requested', q);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [agentId, task.from_agent]);
    return task;
  }

  /**
   * Sender (or the human) answers an input request. The task is re-queued, reserved for the same assignee, and pinned
   * to the session that asked while it is still connected (a temporary pin, see Task.resume_session). If that agent
   * requires approval and the task was never approved, it is held for the human first (see HOLD_SQL).
   */
  provideInput(actorRaw: string, taskId: string, answer: string, data?: unknown): Task {
    const actor = this.requireActor(actorRaw);
    const text = requireText(answer, 'answer', LIMITS.noteMax);
    const dataJson = encodeJson(data, 'data');
    const task = transaction(this.db, () => {
      const task = this.requireTask(taskId);
      if (actor !== task.from_agent && actor !== HUMAN_ID) {
        throw new BruceError('not_allowed', `Only the sender ("${task.from_agent}") or the human can answer this task's questions.`);
      }
      if (task.status !== 'input_required') {
        throw new BruceError('invalid_state', `Task ${task.id} is "${task.status}", not "input_required".`);
      }
      const now = this.now();
      const askingSession = task.assignee_session ? this.getSession(task.assignee_session) : undefined;
      const backTo = askingSession?.connected ? askingSession.id : null;
      this.db
        // attempts-1: the resume re-claim must not use up a delivery attempt (same as release()).
        // A pin the sender set (to_session) stays; otherwise the asking session is pinned and marked as a resume pin,
        // which is dropped when the reservation ends (claim, re-queue, session close).
        .prepare(
          `UPDATE tasks SET status=CASE WHEN ${HOLD_SQL} THEN 'awaiting_approval' ELSE 'queued' END,
             requires_approval=CASE WHEN ${HOLD_SQL} THEN 1 ELSE requires_approval END,
             resume_session=CASE WHEN to_session IS NULL THEN ? ELSE NULL END, to_session=COALESCE(to_session, ?),
             attempts=MAX(attempts-1, 0), status_message=?, updated_at=? WHERE id=?`,
        )
        .run(
          backTo,
          backTo,
          backTo ? `Input provided; waiting for session ${backTo} of "${task.assignee}" to resume.` : 'Input provided; waiting for the assignee to resume.',
          now,
          task.id,
        );
      this.addEvent(task.id, actor, 'input_provided', text, dataJson ? JSON.parse(dataJson) : null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [actor, task.assignee]);
    return task;
  }

  complete(agentRaw: string, taskId: string, result: string, data?: unknown): Task {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const text = requireText(result, 'result', LIMITS.resultMax);
    const dataJson = encodeJson(data, 'result_data');
    const task = transaction(this.db, () => {
      const task = this.requireOwnedTask(agentId, taskId, ['working', 'input_required']);
      const now = this.now();
      this.db
        .prepare(
          `UPDATE tasks SET status='completed', result=?, result_data=?, progress=100, lease_expires_at=NULL,
             completed_at=?, updated_at=?, status_message=NULL WHERE id=?`,
        )
        .run(text, dataJson, now, now, task.id);
      this.addEvent(task.id, agentId, 'completed', null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [agentId, task.from_agent]);
    return task;
  }

  /** Report failure. With retry=true and attempts left, the task goes back to the queue. */
  fail(agentRaw: string, taskId: string, error: string, retry = false): Task {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const text = requireText(error, 'error', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireOwnedTask(agentId, taskId, ['working', 'input_required']);
      const now = this.now();
      if (retry && task.attempts < task.max_attempts) {
        this.requeueInTx(task.id, now, `Retrying after failure (attempt ${task.attempts} of ${task.max_attempts}).`, { error: text });
        this.addEvent(task.id, agentId, 'retrying', text);
      } else {
        this.setTerminal(task.id, 'failed', now, { error: text });
        this.addEvent(task.id, agentId, 'failed', text);
      }
      return this.requireTask(task.id);
    });
    this.emit([task.id], [agentId, task.from_agent]);
    return task;
  }

  /** Assignee declines the task permanently (not my job, unsafe, out of scope). */
  reject(agentRaw: string, taskId: string, reason: string): Task {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const text = requireText(reason, 'reason', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireOwnedTask(agentId, taskId, ['working', 'input_required']);
      this.setTerminal(task.id, 'rejected', this.now(), { error: text });
      this.addEvent(task.id, agentId, 'rejected', text);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [agentId, task.from_agent]);
    return task;
  }

  /** Hand a claimed task back to the queue without using up an attempt (e.g. shutting down). */
  release(agentRaw: string, taskId: string, reason?: string): Task {
    const agentId = normalizeAgentIdLoose(agentRaw);
    const text = optionalText(reason, 'reason', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireOwnedTask(agentId, taskId, ['working', 'input_required']);
      this.requeueInTx(task.id, this.now(), text ?? `Released by ${agentId}.`, { refundAttempt: true });
      this.addEvent(task.id, agentId, 'released', text ?? null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [agentId, task.from_agent]);
    return task;
  }

  /** Sender (or the human) cancels a task that has not finished yet. */
  cancel(actorRaw: string, taskId: string, reason?: string): Task {
    const actor = this.requireActor(actorRaw);
    const text = optionalText(reason, 'reason', LIMITS.noteMax);
    const task = transaction(this.db, () => {
      const task = this.requireTask(taskId);
      if (actor !== task.from_agent && actor !== HUMAN_ID) {
        throw new BruceError('not_allowed', `Only the sender ("${task.from_agent}") or the human can cancel task ${task.id}.`);
      }
      if (TERMINAL_STATUSES.has(task.status)) {
        throw new BruceError('invalid_state', `Task ${task.id} is already "${task.status}".`);
      }
      this.setTerminal(task.id, 'canceled', this.now(), { status_message: text ?? `Canceled by ${actor}.` });
      this.addEvent(task.id, actor, 'canceled', text ?? null);
      return this.requireTask(task.id);
    });
    this.emit([task.id], [actor, task.assignee, task.to_agent]);
    return task;
  }

  /** Add a free-form note to a task's history (visible to sender and assignee). */
  addNote(actorRaw: string, taskId: string, note: string, data?: unknown): TaskEvent {
    const actor = this.requireActor(actorRaw);
    const text = requireText(note, 'note', LIMITS.noteMax);
    const dataJson = encodeJson(data, 'data');
    const task = this.requireTask(taskId);
    const event = transaction(this.db, () => {
      this.db.prepare('UPDATE tasks SET updated_at=? WHERE id=?').run(this.now(), task.id);
      return this.addEvent(task.id, actor, 'note', text, dataJson ? JSON.parse(dataJson) : null);
    });
    this.emit([task.id], [actor, task.from_agent, task.assignee]);
    return event;
  }

  // ---------------------------------------------------------------- reading

  getTask(id: string): Task | undefined {
    this.maybeSweep();
    const row = this.getTaskRow(id);
    return row ? rowToTask(row) : undefined;
  }

  requireTask(id: string): Task {
    const row = this.getTaskRow(id);
    if (!row) throw unknownTask(id);
    return rowToTask(row);
  }

  getEvents(taskId: string, afterSeq = 0): TaskEvent[] {
    return (
      this.db.prepare('SELECT * FROM task_events WHERE task_id=? AND seq>? ORDER BY seq').all(taskId, afterSeq) as Row[]
    ).map(rowToEvent);
  }

  listTasks(filter: TaskFilter = {}): Task[] {
    this.maybeSweep();
    const where: string[] = [];
    const values: SqlValue[] = [];
    if (filter.from_agent) {
      where.push('from_agent = ?');
      values.push(normalizeAgentIdLoose(filter.from_agent));
    }
    if (filter.to_agent) {
      where.push('to_agent = ?');
      values.push(normalizeAgentIdLoose(filter.to_agent));
    }
    if (filter.assignee) {
      where.push('assignee = ?');
      values.push(normalizeAgentIdLoose(filter.assignee));
    }
    if (filter.inbox_of) {
      const agent = this.requireAgent(filter.inbox_of);
      where.push(
        `(assignee = ? AND status IN ('queued','working','input_required')
          OR (status = 'queued' AND assignee IS NULL AND ${ROUTING_SQL}))`,
      );
      values.push(agent.id, agent.id, agent.id, JSON.stringify([...agentRoutingKeys(agent)]));
    }
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      for (const s of statuses) {
        if (!TASK_STATUSES.includes(s)) throw new BruceError('invalid_argument', `Unknown status "${s}".`);
      }
      where.push(`status IN (${statuses.map(() => '?').join(',')})`);
      values.push(...statuses);
    }
    if (filter.kind) {
      where.push('kind = ?');
      values.push(filter.kind);
    }
    if (filter.thread_id) {
      where.push('thread_id = ?');
      values.push(filter.thread_id);
    }
    if (filter.parent_task_id) {
      where.push('parent_task_id = ?');
      values.push(filter.parent_task_id);
    }
    const limit = clamp(Math.round(filter.limit ?? 50), 1, 500);
    const order = filter.newest_first === false ? 'ASC' : 'DESC';
    const sql = `SELECT * FROM tasks ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
                 ORDER BY created_at ${order}, id ${order} LIMIT ${limit}`;
    return (this.db.prepare(sql).all(...values) as Row[]).map(rowToTask);
  }

  /** Counters for an agent's attention (attached to tool responses), without claiming anything. */
  pendingCounts(agentRaw: string, sessionId?: string | null): PendingCounts {
    const agent = this.requireAgent(agentRaw);
    const now = this.now();
    const keys = JSON.stringify([...agentRoutingKeys(agent)]);
    const session = sessionId ? this.getSession(sessionId) ?? null : null;
    const n = (sql: string, ...params: SqlValue[]) => Number((this.db.prepare(sql).get(...params) as Row).n);
    // Same predicate as eligibleRows: only items claimNext / takeMessages would actually hand out.
    const claimable = (kind: string) =>
      n(
        `SELECT COUNT(*) AS n FROM tasks WHERE kind=? AND status='queued'
           AND (not_before IS NULL OR not_before <= ?) AND (expires_at IS NULL OR claimed_at IS NOT NULL OR expires_at > ?)
           AND (assignee = ? OR (assignee IS NULL AND ${ROUTING_SQL}))
           AND ${SESSION_SQL}
           AND ${DELIVERABLE_SQL}`,
        kind,
        now,
        now,
        agent.id,
        agent.id,
        agent.id,
        keys,
        ...sessionParams(session, now),
        ...deliverableParams(agent),
      );
    const terminal = [...TERMINAL_STATUSES];
    return {
      tasks: claimable('task'),
      messages: claimable('message'),
      working: n(`SELECT COUNT(*) AS n FROM tasks WHERE assignee=? AND status='working'`, agent.id),
      waiting_for_answer: n(`SELECT COUNT(*) AS n FROM tasks WHERE assignee=? AND status='input_required'`, agent.id),
      questions_for_you: n(
        `SELECT COUNT(*) AS n FROM tasks WHERE from_agent=? AND status='input_required' AND ${SENDER_SESSION_SQL}`,
        agent.id,
        session?.id ?? '',
        now - LIMITS.sessionStaleMs,
      ),
      results_ready: n(
        `SELECT COUNT(*) AS n FROM tasks WHERE from_agent=? AND kind='task' AND result_seen=0
           AND status IN (${terminal.map(() => '?').join(',')}) AND ${SENDER_SESSION_SQL}`,
        agent.id,
        ...terminal,
        session?.id ?? '',
        now - LIMITS.sessionStaleMs,
      ),
      awaiting_approval: n(`SELECT COUNT(*) AS n FROM tasks WHERE to_agent=? AND status='awaiting_approval'`, agent.id),
    };
  }

  stats(): QueueStats {
    this.maybeSweep();
    const now = this.now();
    const tasks = Object.fromEntries(TASK_STATUSES.map((s) => [s, 0])) as Record<TaskStatus, number>;
    for (const row of this.db.prepare('SELECT status, COUNT(*) AS n FROM tasks GROUP BY status').all() as Row[]) {
      tasks[row.status as TaskStatus] = Number(row.n);
    }
    const agents: QueueStatsAgents = { total: 0, listening: 0, active: 0, connected: 0, idle: 0, offline: 0 };
    for (const agent of this.listAgents()) {
      agents.total++;
      agents[presenceOf(agent, now)]++;
    }
    const live = this.listSessions();
    const sessions = { connected: live.length, listening: live.filter((x) => x.listening).length };
    const oldest = this.db.prepare(`SELECT MIN(created_at) AS t FROM tasks WHERE status='queued'`).get() as Row;
    return { agents, sessions, tasks, oldest_queued_at: oldest.t == null ? null : Number(oldest.t) };
  }

  // ---------------------------------------------------------------- maintenance

  /** Re-queue tasks whose lease ran out, dead-letter ones out of attempts, expire stale queued tasks. */
  sweep(): SweepResult {
    const outcome = transaction(this.db, () => this.sweepInTx());
    this.lastSweep = this.now();
    return outcome;
  }

  /** Delete finished tasks (and their history) older than the given age. */
  purge(olderThanMs: number): number {
    const cutoff = this.now() - olderThanMs;
    const terminal = [...TERMINAL_STATUSES];
    return transaction(this.db, () => {
      const placeholders = terminal.map(() => '?').join(',');
      this.db
        .prepare(
          `DELETE FROM task_events WHERE task_id IN (SELECT id FROM tasks WHERE status IN (${placeholders}) AND updated_at < ?)`,
        )
        .run(...terminal, cutoff);
      const info = this.db.prepare(`DELETE FROM tasks WHERE status IN (${placeholders}) AND updated_at < ?`).run(...terminal, cutoff);
      return Number(info.changes);
    });
  }

  private maybeSweep(): void {
    if (this.now() - this.lastSweep < 1000) return;
    try {
      this.sweep();
    } catch {
      // a busy database must not break reads; the next call retries
    }
  }

  private sweepInTx(): SweepResult {
    const now = this.now();
    const touchedTasks: string[] = [];
    const touchedAgents: string[] = [];
    let requeued = 0;
    let deadLettered = 0;
    let expired = 0;
    const leased = (
      this.db.prepare(`SELECT * FROM tasks WHERE status='working' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`).all(now) as Row[]
    ).map(rowToTask);
    for (const task of leased) {
      touchedTasks.push(task.id);
      touchedAgents.push(task.from_agent, task.assignee ?? '');
      if (task.attempts >= task.max_attempts) {
        const msg = `Lease expired on attempt ${task.attempts} of ${task.max_attempts} without completion; giving up.`;
        this.setTerminal(task.id, 'failed', now, { error: msg });
        this.addEvent(task.id, SYSTEM_ID, 'failed', msg);
        deadLettered++;
      } else {
        this.requeueInTx(task.id, now, `Re-queued: "${task.assignee}" did not finish or report progress within ${task.lease_seconds}s.`);
        this.addEvent(task.id, SYSTEM_ID, 'lease_expired', `Assignee "${task.assignee}" let the lease expire.`);
        requeued++;
      }
    }
    // expires_in_seconds means "expire if nobody claims it in time": a task that was claimed once (and came back to
    // the queue: answered question, retry, release, lease expiry) is not affected.
    const stale = this.db
      .prepare(
        `SELECT id, from_agent FROM tasks WHERE status IN ('queued','awaiting_approval') AND expires_at IS NOT NULL AND expires_at <= ?
           AND claimed_at IS NULL`,
      )
      .all(now) as Row[];
    for (const row of stale) {
      const id = String(row.id);
      touchedTasks.push(id);
      touchedAgents.push(String(row.from_agent));
      this.setTerminal(id, 'expired', now, { status_message: 'Expired before any agent claimed it.' });
      this.addEvent(id, SYSTEM_ID, 'expired', null);
      expired++;
    }
    // Sessions whose hosting process has exited (checked once the heartbeat is overdue) or stopped heart-beating. A
    // stale heartbeat alone does not close a session whose host process is still running: after a sleep or a clock
    // jump every host heartbeats again within one interval, and closing would re-queue work still in progress. Only a
    // host silent for LIMITS.sessionHungMs (hung) loses its sessions; a session without a recorded host goes when stale.
    for (const row of this.db
      .prepare(`SELECT id, heartbeat_at, host_pid FROM sessions WHERE closed_at IS NULL AND heartbeat_at < ?`)
      .all(now - LIMITS.sessionHeartbeatMs * 1.5) as Row[]) {
      const silentMs = now - Number(row.heartbeat_at);
      const dead = row.host_pid != null && !processAlive(Number(row.host_pid));
      const stale = silentMs > (row.host_pid == null ? LIMITS.sessionStaleMs : LIMITS.sessionHungMs);
      if (!stale && !dead) continue;
      const change = this.closeSessionInTx(String(row.id), dead ? 'host process exited' : NO_HEARTBEAT, now);
      if (change) {
        touchedTasks.push(...change.taskIds);
        touchedAgents.push(...change.agentIds);
      }
    }
    // Safety net: unfinished work still pinned to a session that is closed (e.g. a send that raced the close) could
    // never be claimed. Release the pin as closing the session would have.
    for (const row of this.db
      .prepare(
        `SELECT t.id, t.to_session, t.to_workspace, t.from_agent, s.agent_id FROM tasks t JOIN sessions s ON s.id = t.to_session
         WHERE t.to_session IS NOT NULL AND t.status IN ('awaiting_approval','queued','working','input_required')
           AND s.closed_at IS NOT NULL`,
      )
      .all() as Row[]) {
      const taskId = String(row.id);
      this.unpinInTx(taskId, `Session ${row.to_session} is closed`, (row.agent_id as string | null) ?? null, row.to_workspace as string | null, now);
      touchedTasks.push(taskId);
      touchedAgents.push(String(row.from_agent));
    }
    if (touchedTasks.length) queueMicrotask(() => this.emit(touchedTasks, touchedAgents));
    return { requeued, dead_lettered: deadLettered, expired };
  }

  // ---------------------------------------------------------------- internals

  /**
   * Items this agent (through this session) may take now, best first. Sender / approval rules are applied in SQL, so
   * the LIMIT counts deliverable rows only: items the agent may not receive can never starve the ones it may. A
   * deadline (expires_at) only applies until the first claim - a re-queued task is not "unclaimed". Session pins bind
   * only while the pinned session is connected (SESSION_SQL).
   */
  private eligibleRows(agent: Agent, kind: 'task' | 'message', now: number, limit: number, session: Session | null): Row[] {
    return this.db
      .prepare(
        `SELECT * FROM tasks
         WHERE kind = ? AND status = 'queued'
           AND (not_before IS NULL OR not_before <= ?)
           AND (expires_at IS NULL OR claimed_at IS NOT NULL OR expires_at > ?)
           AND (assignee = ? OR (assignee IS NULL AND ${ROUTING_SQL}))
           AND ${SESSION_SQL}
           AND ${DELIVERABLE_SQL}
         ORDER BY (assignee IS ?) DESC, priority DESC, created_at ASC
         LIMIT ?`,
      )
      .all(
        kind,
        now,
        now,
        agent.id,
        agent.id,
        agent.id,
        JSON.stringify([...agentRoutingKeys(agent)]),
        ...sessionParams(session, now),
        ...deliverableParams(agent),
        agent.id,
        limit,
      ) as Row[];
  }

  /**
   * An item was handed out through another session than the one it was pinned to (possible only while that session is
   * not connected, see SESSION_SQL): record it in the history.
   */
  private noteFallbackDelivery(task: Task, session: Session | null): void {
    if (!task.to_session || task.to_session === session?.id) return;
    const via = session ? `session ${session.id}` : 'a call without a session';
    this.addEvent(
      task.id,
      SYSTEM_ID,
      'rerouted',
      `Session ${task.to_session} was not connected (no heartbeat for over ${LIMITS.sessionStaleMs / 1000}s); delivered through ${via} instead.`,
    );
  }

  private requireOwnedTask(agentId: string, taskId: string, statuses: TaskStatus[]): Task {
    const task = this.requireTask(taskId);
    if (task.assignee !== agentId) {
      throw new BruceError(
        'not_assignee',
        task.assignee
          ? `Task ${task.id} is assigned to "${task.assignee}", not "${agentId}".`
          : `Task ${task.id} is not claimed by "${agentId}" (status "${task.status}").`,
        'Use get_next_task to claim work before reporting on it.',
      );
    }
    if (!statuses.includes(task.status)) {
      const hint =
        task.status === 'canceled'
          ? 'The sender canceled this task - stop working on it.'
          : task.status === 'queued'
            ? 'Your lease expired and the task was re-queued. Call get_next_task to claim it again.'
            : undefined;
      throw new BruceError('invalid_state', `Task ${task.id} is "${task.status}"; expected ${statuses.join(' or ')}.`, hint);
    }
    return task;
  }

  /** Resolve the acting identity: a registered agent, or the reserved "human" / "system" actors. */
  private requireActor(raw: string): string {
    const id = normalizeAgentIdLoose(raw);
    if (id === HUMAN_ID || id === SYSTEM_ID) return id;
    if (!this.getAgentRow(id)) throw unknownAgent(id, 'Call register_agent first.');
    return id;
  }

  private setTerminal(
    taskId: string,
    status: TaskStatus,
    now: number,
    fields: { error?: string; status_message?: string },
  ): void {
    this.db
      .prepare(
        `UPDATE tasks SET status=?, lease_expires_at=NULL, completed_at=?, updated_at=?,
           error=COALESCE(?, error), status_message=? WHERE id=?`,
      )
      .run(status, now, now, fields.error ?? null, fields.status_message ?? null, taskId);
  }

  private addEvent(taskId: string, actor: string, type: TaskEventType, message: string | null, data: unknown = null): TaskEvent {
    const at = this.now();
    const info = this.db
      .prepare('INSERT INTO task_events (task_id, at, actor, type, message, data) VALUES (?,?,?,?,?,?)')
      .run(taskId, at, actor, type, message, data == null ? null : JSON.stringify(data));
    return { seq: Number(info.lastInsertRowid), task_id: taskId, at, actor, type, message, data };
  }

  private getAgentRow(id: string): Row | undefined {
    return this.db.prepare(`SELECT a.*, ${CONNECTED_SESSIONS_SQL} FROM agents a WHERE a.id=?`).get(this.now() - LIMITS.sessionStaleMs, id) as
      | Row
      | undefined;
  }

  private getTaskRow(id: string): Row | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id=?').get(String(id).trim().toUpperCase()) as Row | undefined;
  }
}

/**
 * Routing predicate shared by claim/inbox queries. Parameters: (agentId, agentId, routingKeysJson).
 * Matches tasks addressed to the agent, open tasks ("*", not sent by the agent itself), and tasks
 * routed to a skill/tag the agent offers.
 */
const ROUTING_SQL = `(
  to_agent = ?
  OR (to_agent IS NULL AND from_agent <> ? AND (
        to_skill IS NULL OR to_skill IN (SELECT value FROM json_each(?))
  ))
)`;

/** Sub-select adding `connected_sessions` to an agents row aliased `a`. Parameter: stale cutoff (epoch ms). */
const CONNECTED_SESSIONS_SQL = `(SELECT COUNT(*) FROM sessions s WHERE s.agent_id = a.id AND s.closed_at IS NULL AND s.heartbeat_at >= ?) AS connected_sessions`;

/**
 * Sender-side notices (questions, results) belong to the session that sent the task - unless no session was recorded
 * or that session is gone, in which case every session of the agent sees them. Parameters: (callerSessionId or '',
 * stale cutoff).
 */
const SENDER_SESSION_SQL = `(
  from_session IS NULL OR from_session = ?
  OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.id = tasks.from_session AND s.closed_at IS NULL AND s.heartbeat_at >= ?)
)`;

/**
 * Session predicate. Parameters: see sessionParams() - (callerSessionId or '', connected cutoff = now -
 * LIMITS.sessionStaleMs, callerSessionKeysJson).
 *
 * A to_session pin (chosen by the sender, or a resume pin back to the session that asked a question) binds only while
 * the pinned session is CONNECTED - open, heartbeat within LIMITS.sessionStaleMs: the same rule as Session.connected,
 * listSessions and send(to_session). Then only that session may take the item, whatever its workspaces or label are by
 * now. While it is not connected (a hung or sleeping host, or a reused PID after a crash: the sweeper keeps such a row
 * open for up to LIMITS.sessionHungMs) the item behaves as if unpinned: to_workspace, recorded next to the pin, picks
 * the sessions that may take it, or any session of the agent when none was recorded. The pin binds again as soon as the
 * session heart-beats or makes a call. A call through the pinned session itself always qualifies (it proves the session
 * is alive). Items pinned to a workspace only go to sessions with that workspace/label open.
 */
const SESSION_SQL = `(
  to_session = ?
  OR ((to_session IS NULL OR NOT EXISTS (
         SELECT 1 FROM sessions ps WHERE ps.id = tasks.to_session AND ps.closed_at IS NULL AND ps.heartbeat_at >= ?))
      AND (to_workspace IS NULL OR to_workspace IN (SELECT value FROM json_each(?))))
)`;

/** Parameters of SESSION_SQL for a call through `session` (null: a call without a session) at `now`. */
function sessionParams(session: Session | null, now: number): SqlValue[] {
  return [session?.id ?? '', now - LIMITS.sessionStaleMs, JSON.stringify(session ? sessionRoutingKeys(session) : [])];
}

/**
 * Whether the agent may receive an item - mayDeliver() in SQL, so that a LIMIT counts deliverable rows only: the
 * sender is the human or allowed by accept_from, and an agent that requires approval only gets what the human sent or
 * approved. Parameters: see deliverableParams().
 */
const DELIVERABLE_SQL = `(
  (from_agent = '${HUMAN_ID}' OR ? = 1 OR from_agent IN (SELECT value FROM json_each(?)))
  AND (? = 0 OR from_agent = '${HUMAN_ID}' OR approved_by IS NOT NULL)
)`;

function deliverableParams(agent: Agent): SqlValue[] {
  return [agent.accept_from.includes('*') ? 1 : 0, JSON.stringify(agent.accept_from), agent.require_approval ? 1 : 0];
}

/**
 * A task going back to the queue (re-queue, answered question) that is addressed to an agent requiring approval, and
 * that the human never approved (the gate was turned on after it was sent), must wait for the human again: that agent
 * cannot claim it unapproved. Used in UPDATE tasks statements.
 */
const HOLD_SQL = `(approved_by IS NULL AND from_agent <> '${HUMAN_ID}'
  AND EXISTS (SELECT 1 FROM agents ag WHERE ag.id = tasks.to_agent AND ag.require_approval = 1))`;

/**
 * SET clause dropping a resume pin (to_session added by provideInput) when the task's reservation ends (re-queue). A
 * claim drops it too, and also a sender's pin when the claim came through another session (see claimNext).
 */
const DROP_RESUME_PIN_SQL = `to_session=CASE WHEN to_session = resume_session THEN NULL ELSE to_session END, resume_session=NULL`;

/** Close reason of a session the sweeper closed for a missing heartbeat; its host may reopen it (reviveSession). */
const NO_HEARTBEAT = 'no heartbeat';

// ---------------------------------------------------------------- helpers

export function presenceOf(agent: Agent, now: number): Presence {
  if (agent.listening_until && agent.listening_until > now) return 'listening';
  const age = now - agent.last_seen_at;
  if (age <= LIMITS.activeWindowMs) return 'active';
  if (agent.connected_sessions > 0) return 'connected';
  if (age <= LIMITS.idleWindowMs) return 'idle';
  return 'offline';
}

/** Keys a task's to_skill can match: skill ids, skill tags and agent tags (all lower-case). */
export function agentRoutingKeys(agent: Agent): Set<string> {
  const keys = new Set<string>();
  for (const skill of agent.skills) {
    keys.add(skill.id.toLowerCase());
    for (const tag of skill.tags ?? []) keys.add(tag.toLowerCase());
  }
  for (const tag of agent.tags) keys.add(tag.toLowerCase());
  return keys;
}

function accepts(agent: Agent, from: string): boolean {
  return from === HUMAN_ID || agent.accept_from.includes('*') || agent.accept_from.includes(from);
}

/** Whether an agent may receive this item: sender allowed, and approved if the agent requires approval. */
function mayDeliver(agent: Agent, task: Task): boolean {
  if (!accepts(agent, task.from_agent)) return false;
  if (agent.require_approval && task.from_agent !== HUMAN_ID && !task.approved_by) return false;
  return true;
}

export function normalizeAgentId(raw: string): string {
  const id = normalizeAgentIdLoose(raw);
  if (!LIMITS.idPattern.test(id)) {
    throw new BruceError(
      'invalid_agent_id',
      `Invalid agent id "${raw}". Use 2-64 chars: lower-case letters, digits, ".", "_" or "-", starting with a letter or digit.`,
      'Example: "copilot-frontend" or "claude-desktop.research".',
    );
  }
  if (RESERVED_IDS.has(id)) throw new BruceError('invalid_agent_id', `"${id}" is a reserved id.`);
  return id;
}

function normalizeAgentIdLoose(raw: string): string {
  if (typeof raw !== 'string') throw new BruceError('invalid_agent_id', 'agent id must be a string.');
  return raw.trim().toLowerCase();
}

function validateProfile(input: AgentPatch, requireInstructions: boolean): AgentPatch {
  const out: AgentPatch = {};
  if (input.name !== undefined) out.name = requireText(input.name, 'name', 100);
  if (input.description !== undefined) out.description = optionalText(input.description, 'description', 2000) ?? '';
  if (input.platform !== undefined) out.platform = assertPlainText(requireText(input.platform, 'platform', 50), 'platform').toLowerCase();
  if (input.instructions !== undefined || requireInstructions) {
    out.instructions = requireText(
      input.instructions as string,
      'instructions',
      LIMITS.instructionsMax,
      'Describe how other agents should talk to you: what tasks you accept, the input you need, and what you return.',
    );
  }
  if (input.skills !== undefined) {
    if (!Array.isArray(input.skills)) throw new BruceError('invalid_argument', 'skills must be an array.');
    if (input.skills.length > LIMITS.skillsMax) throw new BruceError('invalid_argument', `At most ${LIMITS.skillsMax} skills.`);
    const seen = new Set<string>();
    out.skills = input.skills.map((s): Skill => {
      const id = assertPlainText(requireText(s?.id, 'skills[].id', 64), 'skills[].id').toLowerCase();
      if (seen.has(id)) throw new BruceError('invalid_argument', `Duplicate skill id "${id}".`);
      seen.add(id);
      return {
        id,
        name: optionalText(s.name, 'skills[].name', 100) ?? id,
        description: optionalText(s.description, 'skills[].description', 2000) ?? '',
        tags: normalizeTags(s.tags, 'skills[].tags'),
        examples: (s.examples ?? []).slice(0, 10).map((e) => requireText(e, 'skills[].examples[]', 500)),
      };
    });
  }
  if (input.tags !== undefined) out.tags = normalizeTags(input.tags, 'tags');
  if (input.accept_from !== undefined) {
    if (!Array.isArray(input.accept_from) || input.accept_from.length === 0) {
      throw new BruceError('invalid_argument', 'accept_from must be a non-empty array of agent ids (or ["*"]).');
    }
    out.accept_from = input.accept_from.map((x) => normalizeAgentIdLoose(x));
  }
  if (input.max_concurrent_tasks !== undefined) out.max_concurrent_tasks = clamp(Math.round(input.max_concurrent_tasks), 1, 50);
  if (input.owner !== undefined) out.owner = optionalText(input.owner, 'owner', 200) ?? null;
  if (input.workspace !== undefined) out.workspace = optionalText(input.workspace, 'workspace', 1000) ?? null;
  if (input.version !== undefined) out.version = optionalText(input.version, 'version', 50) ?? null;
  if (input.require_approval !== undefined) out.require_approval = input.require_approval === true;
  if (input.metadata !== undefined) {
    if (input.metadata === null || typeof input.metadata !== 'object' || Array.isArray(input.metadata)) {
      throw new BruceError('invalid_argument', 'metadata must be an object.');
    }
    encodeJson(input.metadata, 'metadata');
    out.metadata = input.metadata;
  }
  if (input.status !== undefined) {
    if (!AGENT_STATUSES.includes(input.status as AgentStatus)) {
      throw new BruceError('invalid_argument', `status must be one of ${AGENT_STATUSES.join(', ')}.`);
    }
    out.status = input.status;
  }
  if (input.status_message !== undefined) out.status_message = optionalText(input.status_message, 'status_message', 500) ?? null;
  return out;
}

function normalizeTags(tags: unknown, field: string): string[] {
  if (tags == null) return [];
  if (!Array.isArray(tags)) throw new BruceError('invalid_argument', `${field} must be an array of strings.`);
  return [...new Set(tags.slice(0, 50).map((t) => assertPlainText(requireText(t, field, 64), field).toLowerCase()))];
}

/**
 * Refused in routing keys and short labels: control characters (C0, DEL, C1), Unicode line / paragraph separators,
 * bidi controls, and < > " ` (quote and tag look-alikes in the sentences and wrappers other agents read).
 */
const NOT_PLAIN = /[\p{Cc}\p{Zl}\p{Zp}؜‎‏‪-‮⁦-⁩<>"`]/u;
const PLAIN_TEXT_RULE = 'printable characters except < > " and ` (no control characters, line breaks or bidi controls)';

/**
 * Store-boundary check for the short agent-chosen strings other agents see inside our own sentences: skill ids, skill
 * and agent tags, to_skill, platform and session labels. Display code still escapes them (format.ts); this keeps the
 * stored values clean. Throws invalid_argument naming the field, the offending character and the allowed set - never
 * echoing the value itself. Returns `value`.
 */
export function assertPlainText(value: string, field: string): string {
  const bad = NOT_PLAIN.exec(value)?.[0];
  if (bad === undefined) return value;
  const code = `U+${bad.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
  const shown = /[<>"`]/.test(bad) ? `${code} ${bad}` : code;
  throw new BruceError('invalid_argument', `${field} contains a character that is not allowed (${shown}). Allowed: ${PLAIN_TEXT_RULE}.`);
}

/** A session label as stored: trimmed, at most 200 characters, plain text (see assertPlainText); null when empty. */
function sessionLabel(value: unknown): string | null {
  const label = optionalText(value, 'session_label', 200);
  return label === undefined ? null : assertPlainText(label, 'session_label');
}

function requireText(value: unknown, field: string, max: number, hint?: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BruceError('invalid_argument', `${field} is required and must be a non-empty string.`, hint);
  }
  if (value.length > max) throw new BruceError('invalid_argument', `${field} is too long (max ${max} characters).`);
  return value.trim();
}

function optionalText(value: unknown, field: string, max: number): string | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'string') throw new BruceError('invalid_argument', `${field} must be a string.`);
  if (value.length > max) throw new BruceError('invalid_argument', `${field} is too long (max ${max} characters).`);
  const trimmed = value.trim();
  return trimmed === '' ? undefined : trimmed;
}

function encodeJson(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    throw new BruceError('invalid_argument', `${field} must be JSON-serialisable.`);
  }
  if (text.length > LIMITS.jsonMax) throw new BruceError('invalid_argument', `${field} is too large (max ${LIMITS.jsonMax} bytes as JSON).`);
  return text;
}

function unknownAgent(id: string, hint = 'Use list_agents to see registered agents.'): BruceError {
  return new BruceError('unknown_agent', `No agent registered with id "${id}".`, hint);
}

function unknownTask(id: string): BruceError {
  return new BruceError('unknown_task', `No task with id "${id}".`, 'Task ids look like "T-XXXXXXXXXX" (tasks) or "M-XXXXXXXXXX" (messages).');
}

function rowToAgent(row: Row): Agent {
  return {
    id: String(row.id),
    name: String(row.name),
    description: String(row.description ?? ''),
    platform: String(row.platform),
    instructions: String(row.instructions),
    skills: parseJson<Skill[]>(row.skills as string, []),
    tags: parseJson<string[]>(row.tags as string, []),
    accept_from: parseJson<string[]>(row.accept_from as string, ['*']),
    max_concurrent_tasks: Number(row.max_concurrent),
    require_approval: Number(row.require_approval) === 1,
    owner: (row.owner as string | null) ?? null,
    workspace: (row.workspace as string | null) ?? null,
    version: (row.version as string | null) ?? null,
    metadata: parseJson<Record<string, unknown>>(row.metadata as string, {}),
    status: row.status as AgentStatus,
    status_message: (row.status_message as string | null) ?? null,
    registered_at: Number(row.registered_at),
    updated_at: Number(row.updated_at),
    last_seen_at: Number(row.last_seen_at),
    listening_until: row.listening_until == null ? null : Number(row.listening_until),
    connected_sessions: Number(row.connected_sessions ?? 0),
  };
}

function rowToTask(row: Row): Task {
  const num = (v: unknown) => (v == null ? null : Number(v));
  return {
    id: String(row.id),
    kind: row.kind as Task['kind'],
    from_agent: String(row.from_agent),
    to_agent: (row.to_agent as string | null) ?? null,
    to_skill: (row.to_skill as string | null) ?? null,
    title: String(row.title),
    body: String(row.body ?? ''),
    input: parseJson<unknown>(row.input as string | null, null),
    priority: Number(row.priority),
    depth: Number(row.depth),
    requires_approval: Number(row.requires_approval) === 1,
    approved_by: (row.approved_by as string | null) ?? null,
    status: row.status as TaskStatus,
    status_message: (row.status_message as string | null) ?? null,
    progress: num(row.progress),
    thread_id: String(row.thread_id),
    parent_task_id: (row.parent_task_id as string | null) ?? null,
    broadcast_id: (row.broadcast_id as string | null) ?? null,
    idempotency_key: (row.idempotency_key as string | null) ?? null,
    assignee: (row.assignee as string | null) ?? null,
    from_session: (row.from_session as string | null) ?? null,
    to_session: (row.to_session as string | null) ?? null,
    resume_session: (row.resume_session as string | null) ?? null,
    to_workspace: (row.to_workspace as string | null) ?? null,
    assignee_session: (row.assignee_session as string | null) ?? null,
    lease_seconds: Number(row.lease_seconds),
    lease_expires_at: num(row.lease_expires_at),
    attempts: Number(row.attempts),
    max_attempts: Number(row.max_attempts),
    result: (row.result as string | null) ?? null,
    result_data: parseJson<unknown>(row.result_data as string | null, null),
    error: (row.error as string | null) ?? null,
    result_seen: Number(row.result_seen) === 1,
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
    not_before: num(row.not_before),
    expires_at: num(row.expires_at),
    claimed_at: num(row.claimed_at),
    completed_at: num(row.completed_at),
  };
}

function rowToEvent(row: Row): TaskEvent {
  return {
    seq: Number(row.seq),
    task_id: String(row.task_id),
    at: Number(row.at),
    actor: String(row.actor),
    type: row.type as TaskEventType,
    message: (row.message as string | null) ?? null,
    data: parseJson<unknown>(row.data as string | null, null),
  };
}

function rowToSession(row: Row, now: number): Session {
  const closedAt = row.closed_at == null ? null : Number(row.closed_at);
  const heartbeat = Number(row.heartbeat_at);
  const listeningUntil = row.listening_until == null ? null : Number(row.listening_until);
  const connected = closedAt == null && heartbeat >= now - LIMITS.sessionStaleMs;
  return {
    id: String(row.id),
    agent_id: (row.agent_id as string | null) ?? null,
    transport: row.transport as Session['transport'],
    client_name: (row.client_name as string | null) ?? null,
    client_version: (row.client_version as string | null) ?? null,
    label: (row.label as string | null) ?? null,
    workspaces: parseJson<string[]>(row.workspaces as string, []),
    host_pid: row.host_pid == null ? null : Number(row.host_pid),
    started_at: Number(row.started_at),
    heartbeat_at: heartbeat,
    last_active_at: row.last_active_at == null ? null : Number(row.last_active_at),
    listening_until: listeningUntil,
    closed_at: closedAt,
    close_reason: (row.close_reason as string | null) ?? null,
    connected,
    listening: connected && listeningUntil != null && listeningUntil > now,
  };
}

function normalizeSessionId(raw: string): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new BruceError('invalid_argument', 'session id must be a non-empty string.');
  return raw.trim().toUpperCase();
}

function unknownSession(id: string): BruceError {
  return new BruceError('unknown_session', `No session "${id}".`, 'Use list_sessions to see connected sessions.');
}

/**
 * Canonical form of a workspace folder so that "C:\\Users\\Me\\Repo", "c:/users/me/repo/" and the MCP root URI
 * "file:///c%3A/Users/Me/Repo" all compare equal. A bare name ("Repo") stays a bare lower-case name.
 */
export function normalizeWorkspace(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  let value = String(raw).trim();
  if (!value) return null;
  if (/^file:\/\//i.test(value)) {
    value = value.replace(/^file:\/\/(localhost)?/i, '');
    try {
      value = decodeURIComponent(value);
    } catch {
      // keep the raw text
    }
  }
  value = value.replace(/\\/g, '/').replace(/\/+$/, '');
  if (/^\/[a-zA-Z]:/.test(value)) value = value.slice(1);
  return value.toLowerCase() || null;
}

function normalizeWorkspaces(list: string[] | undefined): string[] {
  if (!list) return [];
  if (!Array.isArray(list)) throw new BruceError('invalid_argument', 'workspaces must be an array of strings.');
  const out = new Set<string>();
  for (const item of list.slice(0, 20)) {
    const normalized = normalizeWorkspace(item);
    if (normalized) out.add(normalized);
  }
  return [...out];
}

/** Keys a task's to_workspace can match for a session: each workspace path, its folder name, and the label. */
export function sessionRoutingKeys(session: Pick<Session, 'workspaces' | 'label'>): string[] {
  const keys = new Set<string>();
  for (const ws of session.workspaces) {
    keys.add(ws);
    const base = ws.split('/').pop();
    if (base) keys.add(base);
  }
  if (session.label) keys.add(session.label.trim().toLowerCase());
  return [...keys];
}

/** One-line human description of a session for hints and listings. */
export function describeSession(session: Session): string {
  const parts = [session.client_name ? `${session.client_name}${session.client_version ? ` ${session.client_version}` : ''}` : session.transport];
  if (session.label) parts.push(`"${session.label}"`);
  if (session.workspaces.length) parts.push(session.workspaces.join(', '));
  return parts.join(' - ');
}

/** Whether a local process id is still running (EPERM means it exists but belongs to someone else). */
function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
