import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListRootsResultSchema, RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import type { BruceContext } from '../context.js';
import { LIMITS, type Session, type SessionPatch } from '../store/types.js';
import type { Extra } from './runtime.js';
import type { SessionState } from './server.js';

/** How long the client may take to answer roots/list. */
const ROOTS_TIMEOUT_MS = 5_000;
/** A failed roots/list is retried (through the next tool call) after this long; the first retry is immediate. */
const ROOTS_RETRY_MS = 30_000;
/** Give up on roots after this many failures in a row (the client may simply never answer). */
const ROOTS_MAX_FAILURES = 3;
/**
 * HTTP: the first roots/list is sent this long after the handshake. A server-initiated request travels on the client's
 * standalone GET stream, which SDK clients only open after the `initialized` notification was answered - a request
 * sent from oninitialized itself is silently dropped.
 */
const HTTP_ROOTS_DELAY_MS = 1_000;
/** A link whose MCP server is found disconnected on this many heartbeat ticks in a row is closed (safety net). */
const DISCONNECTED_TICKS = 2;

// ---------------------------------------------------------------- process-wide heartbeat

/** Every open store session hosted by this process (all transports, all contexts). */
const tracked = new Set<SessionLink>();
/** ONE timer for all of them. */
let heartbeatTimer: NodeJS.Timeout | null = null;

function track(link: SessionLink): void {
  tracked.add(link);
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => heartbeatOpenSessions(), LIMITS.sessionHeartbeatMs);
  heartbeatTimer.unref();
}

function untrack(link: SessionLink): void {
  tracked.delete(link);
  if (tracked.size || !heartbeatTimer) return;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
}

/**
 * Refresh the heartbeat of every open session hosted by this process ("these connections are still open"). Runs on
 * one process-wide timer every LIMITS.sessionHeartbeatMs; exported so tests can run a tick. Links whose MCP server
 * disconnected without an onclose callback are closed here. A row some sweep closed while its connection is alive
 * (e.g. after the machine slept) is revived by the heartbeat; its link then restores what it records. Returns how
 * many sessions were heart-beaten.
 */
export function heartbeatOpenSessions(): number {
  const byContext = new Map<BruceContext, { ids: string[]; links: SessionLink[] }>();
  for (const link of [...tracked]) {
    if (!link.checkAlive() || !link.id) continue;
    const group = byContext.get(link.ctx) ?? { ids: [], links: [] };
    group.ids.push(link.id);
    group.links.push(link);
    byContext.set(link.ctx, group);
  }
  let count = 0;
  for (const [ctx, group] of byContext) {
    try {
      const wronglyClosed = group.links.filter((link) => link.rowClosed());
      ctx.store.heartbeatSessions(group.ids);
      for (const link of wronglyClosed) link.restore();
      count += group.ids.length;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ERR_INVALID_STATE') {
        // The context was closed under us (database closed): nothing left to heartbeat for these sessions.
        for (const link of group.links) untrack(link);
      } else {
        ctx.log(`session heartbeat failed: ${message(err)}`);
      }
    }
  }
  return count;
}

/** Number of store sessions this process currently keeps open (diagnostics / tests). */
export function trackedSessionCount(): number {
  return tracked.size;
}

// ---------------------------------------------------------------- one MCP connection = one store session

/**
 * Ties one MCP connection to its row in the store's `sessions` table: opens it when the server is created, records
 * the client's name/version and MCP roots (as workspaces) after the handshake, keeps it alive (process-wide heartbeat
 * plus every tool call), mirrors the agent binding, marks long-polls, and closes it when the connection closes.
 *
 * Nothing here may fail or block a tool call: store problems are logged, roots are fetched in the background.
 */
export class SessionLink {
  /** Store session id ("S-..."), or undefined when the row could not be created (routing then ignores sessions). */
  readonly id: string | undefined;
  private boundAgent: string | null;
  /** Label set with register_agent(session_label); undefined until one was set. */
  private label: string | null | undefined;
  /** End of the get_next_task long-poll in progress (epoch ms), 0 when none. */
  private listeningUntil = 0;
  /** Folders the agent declared with register_agent(session_workspaces). */
  private declared: string[] = [];
  /** Root URIs reported by the client (roots/list). */
  private roots: string[] = [];
  private lastWorkspaces = '[]';
  private rootsLoading = false;
  private rootsAgain = false;
  private rootsFailures = 0;
  /** When > 0: retry roots/list through the next tool call made at or after this time. */
  private rootsRetryAt = 0;
  private disconnectedTicks = 0;
  private closed = false;
  private readonly transport: SessionState['transport'];

  constructor(
    readonly ctx: BruceContext,
    state: SessionState,
    private readonly server: McpServer,
  ) {
    this.transport = state.transport;
    this.boundAgent = state.agentId ?? null;
    let id: string | undefined;
    try {
      id = ctx.store.openSession({ transport: state.transport, agent_id: this.boundAgent, host_pid: process.pid }).id;
      state.bruceSessionId = id;
      track(this);
    } catch (err) {
      ctx.log(`could not record the MCP session in the store: ${message(err)}`);
    }
    this.id = id;
    // Clients that declared roots.listChanged tell us when the open folders change.
    server.server.setNotificationHandler(RootsListChangedNotificationSchema, () => this.refreshRoots());
  }

  /** MCP clientInfo.name from the handshake (e.g. "Visual Studio Code", "claude-ai"), once initialized. */
  get clientName(): string | undefined {
    return this.server.server.getClientVersion()?.name;
  }

  /** The handshake finished: record the client and start fetching its roots (in the background). */
  onInitialized(): void {
    if (!this.id || this.closed) return;
    const client = this.server.server.getClientVersion();
    if (client) {
      this.update({
        client_name: String(client.name ?? '').slice(0, 200) || null,
        client_version: String(client.version ?? '').slice(0, 100) || null,
      });
    }
    if (this.transport !== 'http') return this.refreshRoots();
    // If the client never opens the GET stream, the request times out and is retried with the next tool call.
    setTimeout(() => this.refreshRoots(), HTTP_ROOTS_DELAY_MS).unref();
  }

  /**
   * Re-read the client's roots (non-blocking). Only for clients that declared the roots capability. With `extra`
   * the request travels with that tool call (works for HTTP clients that never opened the standalone SSE stream).
   */
  refreshRoots(extra?: Extra): void {
    if (!this.id || this.closed || !this.server.server.getClientCapabilities()?.roots) return;
    if (this.rootsLoading) {
      this.rootsAgain = true;
      return;
    }
    this.rootsLoading = true;
    void this.loadRoots(extra).finally(() => {
      this.rootsLoading = false;
      if (this.rootsAgain && !this.closed) {
        this.rootsAgain = false;
        this.refreshRoots();
      }
    });
  }

  private async loadRoots(extra?: Extra): Promise<void> {
    try {
      const options = { timeout: ROOTS_TIMEOUT_MS };
      const result = extra
        ? await extra.sendRequest({ method: 'roots/list' }, ListRootsResultSchema, options)
        : await this.server.server.listRoots(undefined, options);
      if (this.closed) return;
      this.roots = result.roots.map((root) => root.uri).filter((uri) => typeof uri === 'string' && uri.trim() !== '');
      this.rootsFailures = 0;
      this.rootsRetryAt = 0;
      this.syncWorkspaces();
    } catch (err) {
      if (this.closed) return;
      this.rootsFailures++;
      this.rootsRetryAt = this.rootsFailures >= ROOTS_MAX_FAILURES ? 0 : Date.now() + (this.rootsFailures === 1 ? 0 : ROOTS_RETRY_MS);
      this.ctx.log(`roots/list for session ${this.id} failed (${this.rootsFailures}/${ROOTS_MAX_FAILURES}): ${message(err)}`);
    }
  }

  /** A tool call came through this connection: refresh liveness (reviving a wrongly closed row); retry a failed roots/list alongside it. */
  touch(extra?: Extra): void {
    if (!this.id || this.closed) return;
    try {
      const wronglyClosed = this.rowClosed();
      this.ctx.store.touchSession(this.id);
      if (wronglyClosed) this.restore();
    } catch (err) {
      this.ctx.log(`touchSession ${this.id} failed: ${message(err)}`);
    }
    if (extra && this.rootsRetryAt && Date.now() >= this.rootsRetryAt) {
      this.rootsRetryAt = 0;
      this.refreshRoots(extra);
    }
  }

  /** Mark this session as blocked in a get_next_task long-poll until `until` (epoch ms). */
  startListening(until: number): void {
    if (!this.id || this.closed) return;
    this.listeningUntil = Math.max(this.listeningUntil, until);
    try {
      this.ctx.store.touchSession(this.id, { listeningUntil: until });
    } catch (err) {
      this.ctx.log(`touchSession ${this.id} failed: ${message(err)}`);
    }
  }

  /** Clear the long-poll marker set by {@link startListening}, unless a concurrent poll extended it meanwhile. */
  stopListening(until: number): void {
    if (!this.id || this.closed) return;
    if (this.listeningUntil <= until) this.listeningUntil = 0;
    try {
      const row = this.ctx.store.getSession(this.id);
      if (row && row.listening_until != null && row.listening_until > until) return;
      this.ctx.store.touchSession(this.id, { listeningUntil: null });
    } catch (err) {
      this.ctx.log(`touchSession ${this.id} failed: ${message(err)}`);
    }
  }

  /** Mirror the session's agent binding into the store (register_agent passes force: the row may have been cleared). */
  bindAgent(agentId: string | null, force = false): void {
    if (!this.id || this.closed) return;
    if (!force && agentId === this.boundAgent) return;
    this.boundAgent = agentId;
    this.update({ agent_id: agentId });
  }

  /**
   * register_agent(session_label, session_workspaces): name this window and declare its folders (merged with the
   * MCP roots). Returns a warning when the store refused the change.
   */
  declare(options: { label?: string; workspaces?: string[] }): string | undefined {
    if (!this.id || this.closed) return 'This connection has no Bruce Comm session record; the session label and workspaces were not saved.';
    const patch: SessionPatch = {};
    if (options.label !== undefined) this.label = patch.label = options.label.trim() || null;
    if (options.workspaces !== undefined) {
      this.declared = options.workspaces.map((w) => w.trim()).filter(Boolean);
      patch.workspaces = this.mergedWorkspaces();
    }
    if (!Object.keys(patch).length) return undefined;
    try {
      this.ctx.store.updateSession(this.id, patch);
      if (patch.workspaces) this.lastWorkspaces = JSON.stringify(patch.workspaces);
      return undefined;
    } catch (err) {
      return `Could not save the session label / workspaces: ${message(err)}`;
    }
  }

  /** The store row of this session (undefined if unavailable). */
  current(): Session | undefined {
    if (!this.id) return undefined;
    try {
      return this.ctx.store.getSession(this.id);
    } catch {
      return undefined;
    }
  }

  /** The connection closed: close the store session (pinned work falls back, held tasks are re-queued). Idempotent. */
  close(reason = 'disconnected'): void {
    if (this.closed) return;
    this.closed = true;
    untrack(this);
    if (!this.id) return;
    try {
      this.ctx.store.closeSession(this.id, reason);
    } catch (err) {
      this.ctx.log(`closeSession ${this.id} failed: ${message(err)}`);
    }
  }

  /** Whether this live connection's row is closed (some sweep closed it, e.g. after a sleep or clock jump). */
  rowClosed(): boolean {
    if (!this.id || this.closed) return false;
    const row = this.current();
    return row !== undefined && row.closed_at !== null;
  }

  /**
   * The row was closed while this connection stayed alive and the store has just revived it (heartbeat / touch): put
   * back what this link records - agent binding, label, workspaces and a long-poll in progress - in case the close
   * or anything done meanwhile dropped them. Nothing happens while the row stays closed.
   */
  restore(): void {
    const row = this.current();
    if (!row || row.closed_at !== null || this.closed) return;
    this.ctx.log(`session ${this.id} was closed while its connection is alive; reopened`);
    const patch: SessionPatch = { agent_id: this.boundAgent };
    if (this.label !== undefined) patch.label = this.label;
    if (this.declared.length || this.roots.length) patch.workspaces = this.mergedWorkspaces();
    this.update(patch);
    if (this.listeningUntil > Date.now()) this.startListening(this.listeningUntil);
  }

  /**
   * Heartbeat check: false once closed. A server found disconnected on consecutive ticks closes the link (covers
   * transports that replaced server.onclose or a server that was created but never connected).
   */
  checkAlive(): boolean {
    if (this.closed) return false;
    if (this.server.isConnected()) {
      this.disconnectedTicks = 0;
      return true;
    }
    if (++this.disconnectedTicks >= DISCONNECTED_TICKS) {
      this.close('disconnected');
      return false;
    }
    return true;
  }

  private mergedWorkspaces(): string[] {
    // Declared folders first: the first workspace is the fallback routing key when a pinned session closes.
    return [...new Set([...this.declared, ...this.roots])].slice(0, 20);
  }

  private syncWorkspaces(): void {
    const workspaces = this.mergedWorkspaces();
    const key = JSON.stringify(workspaces);
    if (key === this.lastWorkspaces) return;
    if (this.update({ workspaces })) this.lastWorkspaces = key;
  }

  private update(patch: SessionPatch): Session | undefined {
    if (!this.id || this.closed) return undefined;
    try {
      return this.ctx.store.updateSession(this.id, patch);
    } catch (err) {
      this.ctx.log(`updateSession ${this.id} failed: ${message(err)}`);
      return undefined;
    }
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
