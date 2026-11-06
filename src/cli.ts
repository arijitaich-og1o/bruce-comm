import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { parseArgs } from 'node:util';
import {
  CLIENTS,
  CLIENT_IDS,
  bruceBinPath,
  clientSnippet,
  daemonApi,
  daemonBaseUrl,
  getClient,
  installClient,
  installTarget,
  mcpUrl,
  nodePath,
  probeDaemon,
  readJsonConfig,
  type ClientSnippet,
  type McpTransport,
} from './clients.js';
import { SERVER_NAME, SERVER_VERSION, loadConfig, type BruceConfig } from './config.js';
import { createContext, type BruceContext } from './context.js';
import { checkRunners, detectPresetCommand, loadRunnerConfig, PRESET_IDS, runRunners, writeExampleRunnerConfig } from './runner/runner.js';
import {
  HUMAN_ID,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  type Agent,
  type AgentPatch,
  type Session,
  type Task,
  type TaskEvent,
  type TaskFilter,
  type TaskStatus,
} from './store/types.js';
import { BruceError, iso } from './util.js';

/**
 * Bruce Comm command line. Human commands operate directly on the shared SQLite database (no daemon
 * needed); `serve`, `stdio` and `runner` start long-running processes. Human-friendly tables by
 * default, `--json` for machines. Writes act as the reserved actor "human".
 */

type OptionSpec = { type: 'string' | 'boolean'; short?: string };
type Values = Record<string, string | boolean | undefined>;

interface Invocation {
  values: Values;
  positionals: string[];
  json: boolean;
  /** Lazily created context (opens the database on first use). */
  bruce(): BruceContext;
  config(): BruceConfig;
}

interface CommandDef {
  name: string;
  usage: string;
  summary: string;
  options?: Record<string, OptionSpec>;
  run(inv: Invocation): Promise<number | void> | number | void;
}

const GLOBAL_OPTIONS: Record<string, OptionSpec> = {
  json: { type: 'boolean' },
  home: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
};

// ---------------------------------------------------------------- output helpers

function print(text = ''): void {
  process.stdout.write(`${text}\n`);
}

function printJson(value: unknown): void {
  print(JSON.stringify(value, null, 2));
}

function ago(ms: number | null | undefined): string {
  if (ms == null) return '-';
  const diff = Date.now() - ms;
  const future = diff < 0;
  const s = Math.round(Math.abs(diff) / 1000);
  const text = s < 60 ? `${s}s` : s < 3600 ? `${Math.round(s / 60)}m` : s < 86400 ? `${Math.round(s / 3600)}h` : `${Math.round(s / 86400)}d`;
  return future ? `in ${text}` : `${text} ago`;
}

function cell(value: unknown, max: number): string {
  const text = value == null || value === '' ? '-' : String(value).replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

/** Aligned text table. */
function table(rows: Record<string, unknown>[], columns: { key: string; label: string; max?: number }[]): string {
  const cells = rows.map((row) => columns.map((c) => cell(row[c.key], c.max ?? 40)));
  const widths = columns.map((c, i) => Math.max(c.label.length, ...cells.map((r) => r[i]!.length)));
  const line = (parts: string[]) => parts.map((p, i) => (i === parts.length - 1 ? p : p.padEnd(widths[i]!))).join('  ').trimEnd();
  return [line(columns.map((c) => c.label)), ...cells.map(line)].join('\n');
}

/** Copy of a record with epoch-ms timestamp fields converted to ISO strings (for --json). */
function isoFields<T extends object>(value: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = typeof v === 'number' && (/_at$/.test(key) || key === 'listening_until' || key === 'not_before') ? iso(v) : v;
  }
  return out;
}

function route(task: Task): string {
  if (task.to_agent) return task.to_agent;
  if (task.to_skill) return `skill:${task.to_skill}`;
  return '*';
}

/** Recipient plus session routing, e.g. "coder @S-7K3M9Q2X" or "coder @frontend" (workspace folder name). */
function routeWithSession(task: Task): string {
  if (task.to_session) return `${route(task)} @${task.to_session}`;
  if (task.to_workspace) return `${route(task)} @${task.to_workspace.split('/').pop() || task.to_workspace}`;
  return route(task);
}

/** One sentence on which session(s) of the recipient may take a task, or null when any session may. */
function deliveryText(task: Task): string | null {
  if (task.to_session) {
    const fallback = task.to_workspace ? `a session with workspace "${task.to_workspace}"` : 'any session of the agent';
    return `only session ${task.to_session} while it is connected (otherwise ${fallback})`;
  }
  if (task.to_workspace) return `only a session that has workspace "${task.to_workspace}" open`;
  return null;
}

// ---------------------------------------------------------------- session views

/** listening / connected / stale (open, heartbeat too old) / closed. */
function sessionState(s: Session): string {
  if (s.closed_at !== null) return 'closed';
  if (s.listening) return 'listening';
  return s.connected ? 'connected' : 'stale';
}

/** "Visual Studio Code 1.105.1 (http)" - the MCP client (or the runner) behind a session. */
function sessionClient(s: Session): string {
  const name = s.client_name ? `${s.client_name}${s.client_version ? ` ${s.client_version}` : ''}` : 'unknown client';
  return `${name} (${s.transport})`;
}

function sessionRows(sessions: Session[], options: { closed?: boolean } = {}): string {
  const columns = [
    { key: 'id', label: 'ID', max: 10 },
    { key: 'agent', label: 'AGENT', max: 24 },
    { key: 'client', label: 'CLIENT', max: 36 },
    { key: 'label', label: 'LABEL', max: 30 },
    { key: 'workspaces', label: 'WORKSPACES', max: 60 },
    { key: 'state', label: 'STATE', max: 9 },
    { key: 'active', label: 'LAST ACTIVE', max: 11 },
  ];
  if (options.closed) columns.push({ key: 'closed', label: 'CLOSED', max: 50 });
  return table(
    sessions.map((s) => ({
      id: s.id,
      agent: s.agent_id ?? '(unregistered)',
      client: sessionClient(s),
      label: s.label,
      workspaces: s.workspaces.join(', '),
      state: sessionState(s),
      active: ago(s.last_active_at ?? s.started_at),
      closed: s.closed_at === null ? '' : `${ago(s.closed_at)}${s.close_reason ? ` - ${s.close_reason}` : ''}`,
    })),
    columns,
  );
}

/** Whether a local process is still running (EPERM: it exists but belongs to another user). */
function processAlive(pid: number | null): boolean {
  if (pid == null || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => (process.platform === 'linux' ? path.resolve(p) : path.resolve(p).toLowerCase());
  return norm(a) === norm(b);
}

function indent(text: string, prefix = '  '): string {
  return text
    .split(/\r?\n/)
    .map((l) => prefix + l)
    .join('\n');
}

// ---------------------------------------------------------------- argument helpers

function str(values: Values, key: string): string | undefined {
  const v = values[key];
  return typeof v === 'string' ? v : undefined;
}

function int(values: Values, key: string, options: { min?: number; max?: number } = {}): number | undefined {
  const raw = str(values, key);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || (options.min !== undefined && n < options.min) || (options.max !== undefined && n > options.max)) {
    const range = options.min !== undefined && options.max !== undefined ? ` between ${options.min} and ${options.max}` : '';
    throw new BruceError('invalid_argument', `--${key} must be a whole number${range} (got "${raw}").`);
  }
  return n;
}

function bool(values: Values, key: string): boolean | undefined {
  const raw = str(values, key);
  if (raw === undefined) return undefined;
  if (/^(true|yes|on|1)$/i.test(raw)) return true;
  if (/^(false|no|off|0)$/i.test(raw)) return false;
  throw new BruceError('invalid_argument', `--${key} must be true or false (got "${raw}").`);
}

function list(values: Values, key: string): string[] | undefined {
  const raw = str(values, key);
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function transportOf(values: Values): McpTransport | undefined {
  const raw = str(values, 'transport');
  if (raw === undefined) return undefined;
  if (raw !== 'stdio' && raw !== 'http') throw new BruceError('invalid_argument', `--transport must be "stdio" or "http" (got "${raw}").`);
  return raw;
}

/**
 * --workspace value: a relative path ("." / "./x" / "..\\x") is resolved against the current directory so it can
 * match a session's absolute workspace; absolute paths, folder names and labels pass through unchanged.
 */
function workspaceArg(raw: string | undefined): string | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  return /^\.\.?([\\/]|$)/.test(value) ? path.resolve(value) : value;
}

function need(positionals: string[], index: number, what: string, usage: string): string {
  const value = positionals[index];
  if (!value) throw new BruceError('invalid_argument', `Missing ${what}.`, `Usage: bruce-comm ${usage}`);
  return value;
}

function restText(positionals: string[], from: number, what: string, usage: string): string {
  const text = positionals.slice(from).join(' ').trim();
  if (!text) throw new BruceError('invalid_argument', `Missing ${what}.`, `Usage: bruce-comm ${usage}`);
  return text;
}

/** Resolve after SIGINT / SIGTERM / SIGHUP. */
function waitForShutdown(): Promise<NodeJS.Signals> {
  return new Promise((resolve) => {
    const signals: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
    const handler = (signal: NodeJS.Signals) => {
      for (const s of signals) process.off(s, handler);
      resolve(signal);
    };
    for (const s of signals) process.on(s, handler);
  });
}

// ---------------------------------------------------------------- task / agent views

function taskRows(tasks: Task[]): string {
  return table(
    tasks.map((t) => ({
      id: t.id,
      status: t.status,
      pri: t.priority,
      from: t.from_agent,
      to: routeWithSession(t),
      assignee: t.assignee,
      updated: ago(t.updated_at),
      title: t.title,
    })),
    [
      { key: 'id', label: 'ID', max: 12 },
      { key: 'status', label: 'STATUS', max: 17 },
      { key: 'pri', label: 'PRI', max: 3 },
      { key: 'from', label: 'FROM', max: 24 },
      { key: 'to', label: 'TO', max: 36 },
      { key: 'assignee', label: 'ASSIGNEE', max: 24 },
      { key: 'updated', label: 'UPDATED', max: 9 },
      { key: 'title', label: 'TITLE', max: 60 },
    ],
  );
}

function renderTask(task: Task, events: TaskEvent[]): string {
  const lines = [
    `${task.id}  [${task.status}]  ${task.kind}  priority ${task.priority}  attempt ${task.attempts}/${task.max_attempts}`,
    `Title:    ${task.title}`,
    `From:     ${task.from_agent}  ->  ${route(task)}${task.assignee ? `  (assignee: ${task.assignee})` : ''}`,
    `Thread:   ${task.thread_id}${task.parent_task_id ? `   parent: ${task.parent_task_id} (depth ${task.depth})` : ''}`,
    `Created:  ${iso(task.created_at)} (${ago(task.created_at)})   updated ${ago(task.updated_at)}`,
  ];
  const delivery = deliveryText(task);
  if (delivery) lines.push(`Deliver:  ${delivery}`);
  const sessions = [
    task.from_session ? `sent from ${task.from_session}` : '',
    task.assignee_session ? `claimed by ${task.assignee_session}` : '',
  ].filter(Boolean);
  if (sessions.length) lines.push(`Sessions: ${sessions.join(', ')}`);
  if (task.requires_approval) lines.push(`Approval: required${task.approved_by ? ` - approved by ${task.approved_by}` : ' - not yet approved'}`);
  if (task.status_message) lines.push(`Status:   ${task.status_message}`);
  if (task.progress != null && task.status !== 'completed') lines.push(`Progress: ${task.progress}%`);
  if (task.lease_expires_at) lines.push(`Lease:    until ${iso(task.lease_expires_at)} (${ago(task.lease_expires_at)})`);
  if (task.body) lines.push('Body:', indent(task.body));
  if (task.input != null) lines.push('Input (JSON):', indent(JSON.stringify(task.input, null, 2)));
  if (task.result) lines.push('Result:', indent(task.result));
  if (task.result_data != null) lines.push('Result data (JSON):', indent(JSON.stringify(task.result_data, null, 2)));
  if (task.error) lines.push('Error:', indent(task.error));
  if (events.length) {
    lines.push('History:');
    for (const e of events) {
      const msg = e.message ? `: ${e.message.replace(/\r?\n/g, ' ')}` : '';
      lines.push(`  ${iso(e.at)}  ${e.actor.padEnd(18)} ${e.type}${cell(msg, 160).replace(/^-$/, '')}`);
    }
  }
  return lines.join('\n');
}

function renderAgent(ctx: BruceContext, agent: Agent, sessions: Session[]): string {
  const counts = ctx.store.pendingCounts(agent.id);
  // pendingCounts without a session leaves out work pinned to one window / workspace; count that separately.
  const pinned = ctx.store
    .listTasks({ inbox_of: agent.id, status: 'queued', limit: 500 })
    .filter((t) => t.kind === 'task' && (t.to_session || t.to_workspace)).length;
  const lines = [
    `${agent.name} (${agent.id})`,
    `Platform:   ${agent.platform}`,
    `Presence:   ${ctx.store.presence(agent)}  status: ${agent.status}${agent.status_message ? ` - ${agent.status_message}` : ''}`,
    `Last seen:  ${iso(agent.last_seen_at)} (${ago(agent.last_seen_at)})`,
    `Accepts:    ${agent.accept_from.join(', ')}   max concurrent: ${agent.max_concurrent_tasks}   require approval: ${agent.require_approval ? 'yes' : 'no'}`,
    `Queue:      ${counts.tasks} claimable${pinned ? ` (+${pinned} pinned to a session/workspace)` : ''}, ${counts.messages} messages, ${counts.working} working, ` +
      `${counts.waiting_for_answer} waiting for an answer, ${counts.awaiting_approval} awaiting approval`,
  ];
  if (sessions.length) {
    lines.push(`Sessions:   ${sessions.length} connected (IDE windows / app instances / runners):`);
    for (const s of sessions) {
      const where = [s.label ? `"${s.label}"` : '', s.workspaces.join(', ')].filter(Boolean).join(' ');
      lines.push(`  ${s.id}  ${sessionState(s).padEnd(9)}  ${sessionClient(s)}${where ? `  ${where}` : ''}  - last active ${ago(s.last_active_at ?? s.started_at)}`);
    }
    lines.push(`  Reach one window: bruce-comm send --to ${agent.id} --session <id> ...  (or --workspace <path|name>)`);
  } else {
    lines.push('Sessions:   none connected (tasks wait in the queue until the agent connects or a runner picks them up)');
  }
  if (agent.owner) lines.push(`Owner:      ${agent.owner}`);
  if (agent.workspace) lines.push(`Workspace:  ${agent.workspace}`);
  if (agent.tags.length) lines.push(`Tags:       ${agent.tags.join(', ')}`);
  if (agent.description) lines.push('', agent.description);
  lines.push('', 'Instructions for other agents:', indent(agent.instructions));
  if (agent.skills.length) {
    lines.push('', 'Skills:');
    for (const s of agent.skills) lines.push(`  - ${s.id}${s.name && s.name !== s.id ? ` (${s.name})` : ''}${s.description ? `: ${s.description}` : ''}`);
  }
  if (Object.keys(agent.metadata).length) lines.push('', `Metadata: ${JSON.stringify(agent.metadata)}`);
  return lines.join('\n');
}

function jsonTask(task: Task, events?: TaskEvent[]): Record<string, unknown> {
  return { ...isoFields(task), ...(events ? { events: events.map((e) => isoFields(e)) } : {}) };
}

// ---------------------------------------------------------------- commands

const COMMANDS: CommandDef[] = [
  {
    name: 'serve',
    usage: 'serve [--port n] [--host 127.0.0.1] [--token secret]',
    summary: 'Run the HTTP daemon: MCP at /mcp, REST API at /api, dashboard at /.',
    options: { port: { type: 'string' }, host: { type: 'string' }, token: { type: 'string' } },
    async run(inv) {
      const { startHttpServer } = await import('./transports/http.js');
      const ctx = inv.bruce();
      let handle: Awaited<ReturnType<typeof startHttpServer>>;
      try {
        handle = await startHttpServer(ctx);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          throw new BruceError(
            'port_in_use',
            `Port ${ctx.config.port} on ${ctx.config.host} is already in use.`,
            `Another Bruce Comm daemon may be running (check ${mcpUrl(ctx.config).replace(/\/mcp$/, '/healthz')}), or pick another port with --port.`,
          );
        }
        throw err;
      }
      print(`Bruce Comm ${SERVER_VERSION} is running`);
      print(`  MCP endpoint: ${handle.url}/mcp`);
      print(`  Dashboard:    ${handle.url}/${ctx.config.token ? '?token=<your token>' : ''}`);
      print(`  Database:     ${ctx.config.dbPath}`);
      print('Press Ctrl+C to stop.');
      const signal = await waitForShutdown();
      ctx.log(`${signal} received - shutting down`);
      await handle.close();
    },
  },
  {
    name: 'stdio',
    usage:
      'stdio [--agent-id id] [--runner-task task-id]\n' +
      '  --runner-task is set by the runner in the MCP config of the headless CLI it starts: a one-shot session that\n' +
      '  works on that task only (no get_next_task, no work-loop guidance).',
    summary: 'Serve one MCP session over stdin/stdout (what MCP clients launch). Prints nothing else on stdout.',
    options: { 'agent-id': { type: 'string' }, 'runner-task': { type: 'string' } },
    async run(inv) {
      const { startStdioServer } = await import('./transports/stdio.js');
      await startStdioServer(inv.bruce(), { agentId: str(inv.values, 'agent-id'), runnerTask: str(inv.values, 'runner-task') });
    },
  },
  {
    name: 'runner',
    usage: 'runner [--config file] [--only id,id] [--once] | runner init [--force] | runner check',
    summary: 'Process tasks unattended with headless agent CLIs (see runners.json).',
    options: {
      config: { type: 'string' },
      only: { type: 'string' },
      once: { type: 'boolean' },
      force: { type: 'boolean' },
    },
    run: runnerCommand,
  },
  {
    name: 'status',
    usage: 'status [--json]',
    summary: 'Queue and agent overview, daemon state.',
    async run(inv) {
      const ctx = inv.bruce();
      const stats = ctx.store.stats();
      const daemon = await probeDaemon(ctx.config);
      const pending = stats.tasks.awaiting_approval;
      if (inv.json) {
        printJson({
          version: SERVER_VERSION,
          home: ctx.config.home,
          database: ctx.config.dbPath,
          daemon: { running: daemon.ok, url: daemon.ok ? daemon.url.replace(/\/healthz$/, '/') : undefined, error: daemon.ok ? undefined : daemon.error },
          agents: stats.agents,
          sessions: stats.sessions,
          tasks: stats.tasks,
          oldest_queued_at: iso(stats.oldest_queued_at),
        });
        return;
      }
      const a = stats.agents;
      const t = stats.tasks;
      print(`Bruce Comm ${SERVER_VERSION}`);
      print(`Home:      ${ctx.config.home}`);
      print(`Database:  ${ctx.config.dbPath}`);
      print(`Daemon:    ${daemon.ok ? `running - dashboard ${daemon.url.replace(/\/healthz$/, '/')}` : `not running on port ${ctx.config.port} (start it with: bruce-comm serve)`}`);
      print(`Agents:    ${a.total} total - ${a.listening} listening, ${a.active} active, ${a.connected} connected, ${a.idle} idle, ${a.offline} offline`);
      print(
        `Sessions:  ${stats.sessions.connected} connected, ${stats.sessions.listening} listening` +
          (stats.sessions.connected ? ' (list them: bruce-comm sessions)' : ''),
      );
      const active = TASK_STATUSES.filter((s) => t[s] > 0).map((s) => `${t[s]} ${s}`);
      print(`Tasks:     ${active.length ? active.join(', ') : 'none'}`);
      if (stats.oldest_queued_at) print(`Oldest queued task: ${ago(stats.oldest_queued_at)}`);
      if (pending) print(`\n${pending} task(s) are waiting for YOUR approval: bruce-comm pending`);
    },
  },
  {
    name: 'agents',
    usage: 'agents [--json]',
    summary: 'List registered agents.',
    run(inv) {
      const ctx = inv.bruce();
      const agents = ctx.store.listAgents();
      if (inv.json) return printJson(agents.map((a) => ({ ...isoFields(a), presence: ctx.store.presence(a) })));
      if (!agents.length) return print('No agents registered yet. Connect a client (bruce-comm config all) and ask it to register_agent.');
      print(
        table(
          agents.map((a) => ({
            id: a.id,
            name: a.name,
            platform: a.platform,
            presence: ctx.store.presence(a),
            sessions: a.connected_sessions,
            status: a.status,
            skills: a.skills.map((s) => s.id).join(','),
            seen: ago(a.last_seen_at),
            flags: [a.require_approval ? 'approval' : '', a.accept_from.includes('*') ? '' : 'restricted'].filter(Boolean).join(','),
          })),
          [
            { key: 'id', label: 'ID', max: 28 },
            { key: 'name', label: 'NAME', max: 30 },
            { key: 'platform', label: 'PLATFORM', max: 16 },
            { key: 'presence', label: 'PRESENCE', max: 9 },
            { key: 'sessions', label: 'SESSIONS', max: 8 },
            { key: 'status', label: 'STATUS', max: 7 },
            { key: 'skills', label: 'SKILLS', max: 30 },
            { key: 'seen', label: 'LAST SEEN', max: 9 },
            { key: 'flags', label: 'FLAGS', max: 20 },
          ],
        ),
      );
    },
  },
  {
    name: 'agent',
    usage: 'agent <id> [--json]',
    summary: 'Show one agent card (instructions, skills, queue counters, connected sessions).',
    run(inv) {
      const ctx = inv.bruce();
      const agent = ctx.store.requireAgent(need(inv.positionals, 0, 'agent id', 'agent <id>'));
      const sessions = ctx.store.listSessions({ agent_id: agent.id, limit: 500 });
      if (inv.json) {
        return printJson({
          ...isoFields(agent),
          presence: ctx.store.presence(agent),
          pending: ctx.store.pendingCounts(agent.id),
          sessions: sessions.map((s) => isoFields(s)),
        });
      }
      print(renderAgent(ctx, agent, sessions));
    },
  },
  {
    name: 'sessions',
    usage: 'sessions [--agent id] [--all] [--json]',
    summary: 'List connected sessions (IDE windows, app instances, runners) of every agent; --all adds closed ones.',
    options: { agent: { type: 'string' }, all: { type: 'boolean' } },
    run(inv) {
      const ctx = inv.bruce();
      const agent = str(inv.values, 'agent')?.trim().toLowerCase() || undefined;
      const all = inv.values.all === true;
      const sessions = ctx.store.listSessions({ agent_id: agent, include_closed: all, limit: 500 });
      if (inv.json) return printJson(sessions.map((s) => isoFields(s)));
      if (!sessions.length) {
        const whose = agent ? ` for agent "${agent}"` : '';
        print(all ? `No sessions recorded${whose}.` : `No connected sessions${whose}. Add --all to include closed ones.`);
        if (agent && !ctx.store.getAgent(agent)) print(`(No agent "${agent}" is registered - see: bruce-comm agents)`);
        return;
      }
      print(sessionRows(sessions, { closed: all }));
      print(
        '\nSend to one window: bruce-comm send --to <agent> --session <id> --title ...' +
          '\n  or to whichever window has a folder open: --workspace <path|folder name|label>',
      );
    },
  },
  {
    name: 'close-session',
    usage:
      'close-session <session-id> [--json]\n' +
      '  If a daemon serving this database runs on the configured port, it does the closing and also disconnects the\n' +
      '  live MCP connection when it hosts it (HTTP clients). Otherwise only the database row is closed: a stdio client\n' +
      '  stays connected until it exits, and a running runner opens a new session.',
    summary: "Close a (stale) session: work pinned to it goes to the agent's other sessions, work in progress is re-queued.",
    run: closeSessionCommand,
  },
  {
    name: 'tasks',
    usage: 'tasks [--status s,s] [--agent id] [--role sent|inbox|assigned|all] [--limit n] [--json]',
    summary: 'List tasks (newest first).',
    options: { status: { type: 'string' }, agent: { type: 'string' }, role: { type: 'string' }, limit: { type: 'string' } },
    run(inv) {
      const ctx = inv.bruce();
      const tasks = listTasks(ctx, inv.values);
      if (inv.json) return printJson(tasks.map((t) => jsonTask(t)));
      if (!tasks.length) return print('No tasks match.');
      print(taskRows(tasks));
    },
  },
  {
    name: 'task',
    usage: 'task <id> [--json]',
    summary: 'Show a task with its full history.',
    run(inv) {
      const ctx = inv.bruce();
      const task = ctx.store.requireTask(need(inv.positionals, 0, 'task id', 'task <id>'));
      const events = ctx.store.getEvents(task.id);
      if (inv.json) return printJson(jsonTask(task, events));
      print(renderTask(task, events));
    },
  },
  {
    name: 'send',
    usage:
      'send (--to <agent|*> | --skill <s> | --broadcast) --title T [--body B | --body-file F] [--input JSON] [--priority n] [--message] [--wait secs]\n' +
      '            [--session <S-id> | --workspace <path|name>]   (with --to <agent>: deliver to one session / window of that agent; see "bruce-comm sessions")',
    summary: 'Send a task (or --message) as the human operator, optionally to one session (window) of the agent.',
    options: {
      session: { type: 'string' },
      workspace: { type: 'string' },
      to: { type: 'string' },
      skill: { type: 'string' },
      broadcast: { type: 'boolean' },
      title: { type: 'string' },
      body: { type: 'string' },
      'body-file': { type: 'string' },
      input: { type: 'string' },
      priority: { type: 'string' },
      message: { type: 'boolean' },
      wait: { type: 'string' },
      'expires-in': { type: 'string' },
    },
    run: sendCommand,
  },
  {
    name: 'cancel',
    usage: 'cancel <task-id> [--reason text]',
    summary: 'Cancel a task that has not finished.',
    options: { reason: { type: 'string' } },
    run(inv) {
      const task = inv.bruce().store.cancel(HUMAN_ID, need(inv.positionals, 0, 'task id', 'cancel <task-id>'), str(inv.values, 'reason'));
      if (inv.json) return printJson(jsonTask(task));
      print(`Canceled ${task.id}.`);
    },
  },
  {
    name: 'answer',
    usage: 'answer <task-id> <text>',
    summary: "Answer an agent's question on an input_required task.",
    run(inv) {
      const id = need(inv.positionals, 0, 'task id', 'answer <task-id> <text>');
      const task = inv.bruce().store.provideInput(HUMAN_ID, id, restText(inv.positionals, 1, 'answer text', 'answer <task-id> <text>'));
      if (inv.json) return printJson(jsonTask(task));
      print(`Answered ${task.id}; it is queued again for ${task.assignee ?? 'its assignee'}.`);
    },
  },
  {
    name: 'note',
    usage: 'note <task-id> <text>',
    summary: "Add a note to a task's history.",
    run(inv) {
      const id = need(inv.positionals, 0, 'task id', 'note <task-id> <text>');
      const event = inv.bruce().store.addNote(HUMAN_ID, id, restText(inv.positionals, 1, 'note text', 'note <task-id> <text>'));
      if (inv.json) return printJson(isoFields(event));
      print(`Note added to ${event.task_id}.`);
    },
  },
  {
    name: 'unregister',
    usage: 'unregister <agent-id>',
    summary: 'Remove an agent (its queued work is re-queued or canceled).',
    run(inv) {
      const id = need(inv.positionals, 0, 'agent id', 'unregister <agent-id>');
      const result = inv.bruce().store.unregisterAgent(id, { asHuman: true });
      if (inv.json) return printJson(result);
      if (!result.removed) throw new BruceError('unknown_agent', `No agent registered with id "${id}".`, 'See: bruce-comm agents');
      print(`Unregistered ${id}: ${result.requeued} task(s) re-queued, ${result.canceled} canceled.`);
    },
  },
  {
    name: 'approve',
    usage: 'approve <task-id> [--note text]',
    summary: 'Approve a task held for your approval.',
    options: { note: { type: 'string' } },
    run(inv) {
      const task = inv.bruce().store.approve(need(inv.positionals, 0, 'task id', 'approve <task-id>'), str(inv.values, 'note'));
      if (inv.json) return printJson(jsonTask(task));
      print(`Approved ${task.id}; it is now queued for ${route(task)}.`);
    },
  },
  {
    name: 'deny',
    usage: 'deny <task-id> [--reason text]',
    summary: 'Refuse a task held for your approval.',
    options: { reason: { type: 'string' } },
    run(inv) {
      const task = inv.bruce().store.deny(need(inv.positionals, 0, 'task id', 'deny <task-id>'), str(inv.values, 'reason'));
      if (inv.json) return printJson(jsonTask(task));
      print(`Denied ${task.id}.`);
    },
  },
  {
    name: 'pending',
    usage: 'pending [--json]',
    summary: 'List tasks waiting for your approval.',
    run(inv) {
      const tasks = inv.bruce().store.listTasks({ status: 'awaiting_approval', limit: 500, newest_first: false });
      if (inv.json) return printJson(tasks.map((t) => jsonTask(t)));
      if (!tasks.length) return print('Nothing is waiting for approval.');
      print(taskRows(tasks));
      print('\nInspect with "bruce-comm task <id>", then "bruce-comm approve <id>" or "bruce-comm deny <id> --reason ...".');
    },
  },
  {
    name: 'agent-set',
    usage: 'agent-set <agent-id> [--require-approval true|false] [--accept-from a,b|*] [--max-concurrent n] [--status online|busy|away|offline]',
    summary: "Change an agent's settings as the human (e.g. turn approval off).",
    options: {
      'require-approval': { type: 'string' },
      'accept-from': { type: 'string' },
      'max-concurrent': { type: 'string' },
      status: { type: 'string' },
    },
    run(inv) {
      const id = need(inv.positionals, 0, 'agent id', 'agent-set <agent-id> ...');
      const patch: AgentPatch = {};
      const approval = bool(inv.values, 'require-approval');
      if (approval !== undefined) patch.require_approval = approval;
      const accept = list(inv.values, 'accept-from');
      if (accept !== undefined) patch.accept_from = accept;
      const max = int(inv.values, 'max-concurrent', { min: 1, max: 50 });
      if (max !== undefined) patch.max_concurrent_tasks = max;
      const status = str(inv.values, 'status');
      if (status !== undefined) patch.status = status as AgentPatch['status'];
      if (!Object.keys(patch).length) {
        throw new BruceError('invalid_argument', 'Nothing to change.', 'Pass --require-approval, --accept-from, --max-concurrent or --status.');
      }
      const agent = inv.bruce().store.updateAgent(id, patch, { asHuman: true });
      if (inv.json) return printJson(isoFields(agent));
      print(
        `Updated ${agent.id}: require_approval=${agent.require_approval}, accept_from=${agent.accept_from.join(',')}, ` +
          `max_concurrent_tasks=${agent.max_concurrent_tasks}, status=${agent.status}`,
      );
    },
  },
  {
    name: 'purge',
    usage: 'purge [--days 7]',
    summary: 'Delete finished tasks older than N days.',
    options: { days: { type: 'string' } },
    run(inv) {
      const days = int(inv.values, 'days', { min: 0, max: 36500 }) ?? 7;
      const removed = inv.bruce().store.purge(days * 86_400_000);
      if (inv.json) return printJson({ removed, older_than_days: days });
      print(`Purged ${removed} finished task(s) older than ${days} day(s).`);
    },
  },
  {
    name: 'pc-control',
    usage:
      'pc-control status [--json] | pc-control stop [--json]\n' +
      '  status: kill switch, BruceControl helper and permissions, which agents may control this Mac, recent actions.\n' +
      '  stop:   engage the kill switch (works without the daemon; BruceControl is told too, started if needed, within 10 s).\n' +
      '  Switching agents on and re-enabling PC control need Touch ID: use the dashboard (PC control panel).',
    summary: 'PC control (computer use on macOS): show its status, or stop it all (kill switch).',
    run: pcControlCommand,
  },
  {
    name: 'config',
    usage: `config <client|all> [--transport stdio|http] [--port n] [--agent-id id]   clients: ${CLIENT_IDS.join(', ')}`,
    summary: 'Print ready-to-paste MCP config for a client (absolute paths filled in).',
    options: { transport: { type: 'string' }, port: { type: 'string' }, 'agent-id': { type: 'string' } },
    run: configCommand,
  },
  {
    name: 'install',
    usage: 'install <client> [--transport stdio|http] [--agent-id id] [--port n] [--yes] [--dry-run] [--config-file path]',
    summary: "Merge a bruce-comm entry into a client's config file (backup first).",
    options: {
      transport: { type: 'string' },
      'agent-id': { type: 'string' },
      port: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      'dry-run': { type: 'boolean' },
      'config-file': { type: 'string' },
    },
    run: installCommand,
  },
  {
    name: 'doctor',
    usage: 'doctor [--json]',
    summary: 'Check node, database, daemon, runner config and agent CLIs; suggest the next step.',
    run: doctorCommand,
  },
  {
    name: 'version',
    usage: 'version',
    summary: 'Print the version.',
    run(inv) {
      if (inv.json) return printJson({ name: SERVER_NAME, version: SERVER_VERSION, node: process.versions.node });
      print(`${SERVER_NAME} ${SERVER_VERSION} (node ${process.versions.node})`);
    },
  },
  {
    name: 'help',
    usage: 'help [command]',
    summary: 'Show help.',
    run(inv) {
      print(helpText(inv.positionals[0]));
    },
  },
];

function helpText(commandName?: string): string {
  if (commandName) {
    const cmd = COMMANDS.find((c) => c.name === commandName);
    if (cmd) return `Usage: bruce-comm ${cmd.usage}\n\n${cmd.summary}\n\nGlobal options: --json (machine output), --home <dir> (data directory), -h/--help`;
  }
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    `Bruce Comm ${SERVER_VERSION} - local MCP gateway for agent-to-agent tasks`,
    '',
    'Usage: bruce-comm <command> [options]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Sessions: one agent id can be connected through several sessions at once (two VS Code windows on different',
    'repos, Claude Desktop + a terminal, a runner). "bruce-comm sessions" lists them; "send --to <agent> --session <id>"',
    'reaches one window and "--workspace <path|name>" whichever window has that folder open.',
    '',
    'Run "bruce-comm help <command>" for its options. Global: --json, --home <dir>, -h/--help.',
    'Environment: BRUCE_COMM_HOME, BRUCE_COMM_PORT (default 7457), BRUCE_COMM_TOKEN, BRUCE_COMM_DEBUG=1 (stack traces).',
    '',
    'Getting started:  bruce-comm doctor   ->   bruce-comm config all   ->   bruce-comm serve',
  ].join('\n');
}

// ---------------------------------------------------------------- command implementations

function listTasks(ctx: BruceContext, values: Values): Task[] {
  const statuses = list(values, 'status');
  for (const s of statuses ?? []) {
    if (!TASK_STATUSES.includes(s as TaskStatus)) {
      throw new BruceError('invalid_argument', `Unknown status "${s}".`, `Valid: ${TASK_STATUSES.join(', ')}.`);
    }
  }
  const limit = int(values, 'limit', { min: 1, max: 500 }) ?? 50;
  const agent = str(values, 'agent');
  const role = str(values, 'role') ?? 'all';
  if (!['sent', 'inbox', 'assigned', 'all'].includes(role)) {
    throw new BruceError('invalid_argument', `--role must be sent, inbox, assigned or all (got "${role}").`);
  }
  const base: TaskFilter = { status: statuses as TaskStatus[] | undefined, limit };
  if (!agent) {
    if (str(values, 'role')) throw new BruceError('invalid_argument', '--role needs --agent <id>.');
    return ctx.store.listTasks(base);
  }
  if (role === 'sent') return ctx.store.listTasks({ ...base, from_agent: agent });
  if (role === 'inbox') return ctx.store.listTasks({ ...base, inbox_of: agent });
  if (role === 'assigned') return ctx.store.listTasks({ ...base, assignee: agent });
  const merged = new Map<string, Task>();
  for (const filter of [{ from_agent: agent }, { to_agent: agent }, { assignee: agent }]) {
    for (const t of ctx.store.listTasks({ ...base, ...filter })) merged.set(t.id, t);
  }
  return [...merged.values()].sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1)).slice(0, limit);
}

async function sendCommand(inv: Invocation): Promise<number> {
  const v = inv.values;
  const title = str(v, 'title');
  if (!title) throw new BruceError('invalid_argument', '--title is required.', 'Usage: bruce-comm send --to <agent> --title "..." [--body "..."]');
  if (str(v, 'body') !== undefined && str(v, 'body-file') !== undefined) {
    throw new BruceError('invalid_argument', 'Use either --body or --body-file, not both.');
  }
  let body = str(v, 'body');
  const bodyFile = str(v, 'body-file');
  if (bodyFile) {
    try {
      body = fs.readFileSync(bodyFile, 'utf8');
    } catch (err) {
      throw new BruceError('invalid_argument', `Cannot read --body-file ${bodyFile}: ${(err as Error).message}`);
    }
  }
  let input: unknown;
  const inputText = str(v, 'input');
  if (inputText !== undefined) {
    try {
      input = JSON.parse(inputText);
    } catch (err) {
      throw new BruceError('invalid_argument', `--input must be JSON: ${(err as Error).message}`);
    }
  }
  const toSession = str(v, 'session')?.trim() || undefined;
  const toWorkspace = workspaceArg(str(v, 'workspace'));
  if ((toSession || toWorkspace) && (!str(v, 'to') || str(v, 'to') === '*')) {
    throw new BruceError(
      'invalid_argument',
      `--${toSession ? 'session' : 'workspace'} needs --to <agent id> (one specific agent).`,
      'See the agents\' connected sessions with: bruce-comm sessions',
    );
  }
  const ctx = inv.bruce();
  // Sent as the human without a session (from_session stays empty): the CLI is not a connection anyone can route
  // replies to - the human follows results and questions here or in the dashboard.
  const { tasks, warnings } = ctx.store.send(HUMAN_ID, {
    kind: v.message ? 'message' : 'task',
    to_agent: str(v, 'to'),
    to_skill: str(v, 'skill'),
    broadcast: v.broadcast === true ? true : undefined,
    title,
    body,
    input,
    priority: int(v, 'priority', { min: 0, max: 9 }),
    expires_in_seconds: int(v, 'expires-in', { min: 1 }),
    to_session: toSession,
    to_workspace: toWorkspace,
  });
  const wait = int(v, 'wait', { min: 0, max: 86_400 }) ?? 0;
  let settled = tasks;
  if (wait > 0) {
    const ids = tasks.map((t) => t.id);
    const isSettled = (t: Task) => TERMINAL_STATUSES.has(t.status) || t.status === 'input_required';
    if (!inv.json) process.stderr.write(`Waiting up to ${wait}s for ${ids.join(', ')}...\n`);
    const done = await ctx.notifier.pollUntil(
      () => {
        const current = ids.map((id) => ctx.store.requireTask(id));
        return current.every(isSettled) ? current : null;
      },
      { timeoutMs: wait * 1000, recheckMs: 2000 },
    );
    settled = done ?? ids.map((id) => ctx.store.requireTask(id));
  }
  if (inv.json) {
    printJson({ tasks: settled.map((t) => jsonTask(t)), warnings });
    return 0;
  }
  for (const w of warnings) process.stderr.write(`warning: ${w}\n`);
  if (wait <= 0) {
    print(`Sent ${tasks.length === 1 ? tasks[0]!.id : `${tasks.length} items`} (${tasks[0]!.kind}) -> ${tasks.map(route).join(', ')}`);
    const delivery = tasks.length === 1 ? deliveryText(tasks[0]!) : null;
    if (delivery) print(`Deliver to: ${delivery}`);
    if (tasks.length > 1) print(taskRows(tasks));
    print(`Follow it with: bruce-comm task ${tasks[0]!.id}`);
    return 0;
  }
  for (const t of settled) {
    print(`${t.id}  [${t.status}]${t.assignee ? `  by ${t.assignee}` : ''}`);
    if (t.status === 'input_required') print(indent(`Question: ${t.status_message ?? ''}\nAnswer with: bruce-comm answer ${t.id} "<text>"`));
    if (t.result) print(indent(t.result));
    if (t.error) print(indent(`Error: ${t.error}`));
    if (!TERMINAL_STATUSES.has(t.status) && t.status !== 'input_required') print(indent('(still pending - check later with bruce-comm task <id>)'));
  }
  return 0;
}

/** What the daemon did with a DELETE /api/sessions/:id, or why it was not asked. */
type DaemonClose =
  | { used: true; url: string; pid: number | null; alreadyClosed: boolean; disconnected: boolean }
  | { used: false; url: string; reason: string };

/**
 * Close a session as the human. When a daemon serving THIS database answers on the configured port it does the
 * closing (DELETE /api/sessions/:id), because only it can also end the live MCP connection when it hosts it;
 * otherwise the database row is closed directly. Either way the store releases the session's pinned work.
 */
async function closeSessionCommand(inv: Invocation): Promise<number> {
  const raw = need(inv.positionals, 0, 'session id', 'close-session <session-id>');
  const ctx = inv.bruce();
  const before = ctx.store.getSession(raw);
  if (!before) throw new BruceError('unknown_session', `No session "${raw.trim()}".`, 'See: bruce-comm sessions --all');
  const daemon = await closeViaDaemon(ctx, before.id);
  if (!daemon.used && before.closed_at === null) ctx.store.closeSession(before.id, 'closed from the CLI');
  const after = ctx.store.requireSession(before.id);
  const alreadyClosed = daemon.used ? daemon.alreadyClosed : before.closed_at !== null;
  const disconnected = daemon.used && daemon.disconnected;
  if (inv.json) {
    printJson({
      session: isoFields(after),
      already_closed: alreadyClosed,
      closed_via: daemon.used ? 'daemon' : 'database',
      disconnected,
      daemon: daemon.used ? { url: daemon.url } : { url: daemon.url, not_used_because: daemon.reason },
    });
    return 0;
  }
  const who = `${after.agent_id ? `agent "${after.agent_id}"` : 'no agent'}, ${sessionClient(after)}${after.label ? `, "${after.label}"` : ''}`;
  if (alreadyClosed) {
    print(`Session ${after.id} (${who}) was already closed ${ago(after.closed_at)}${after.close_reason ? ` (${after.close_reason})` : ''}.`);
  } else {
    print(`Closed session ${after.id} (${who}).`);
    print("Work pinned to it is now available to the agent's other sessions; tasks it was working on went back to the queue.");
  }
  if (disconnected) {
    print(`The daemon (${daemon.url}) hosted its MCP connection and has disconnected it; the client may reconnect as a new session.`);
    return 0;
  }
  if (!daemon.used) print(`Closed in the database only: the daemon ${daemon.reason}.`);
  print(connectionNote(after, daemon));
  return 0;
}

/** Ask the daemon on the configured port to close (and disconnect) the session - only if it serves this database. */
async function closeViaDaemon(ctx: BruceContext, sessionId: string): Promise<DaemonClose> {
  const url = daemonBaseUrl(ctx.config);
  let status;
  try {
    status = await daemonApi(ctx.config, 'GET', 'status', 1500);
  } catch {
    return { used: false, url, reason: `is not running on port ${ctx.config.port}` };
  }
  if (!status.ok) {
    const auth = status.status === 401 ? ' - set BRUCE_COMM_TOKEN to the daemon\'s token' : '';
    return { used: false, url, reason: `at ${url} refused the request (HTTP ${status.status}${auth})` };
  }
  const body = status.body as { name?: unknown; db_path?: unknown; pid?: unknown } | null;
  if (body?.name !== SERVER_NAME || typeof body.db_path !== 'string') {
    return { used: false, url, reason: `port ${ctx.config.port} is answered by something that is not Bruce Comm` };
  }
  if (!samePath(body.db_path, ctx.config.dbPath)) {
    return { used: false, url, reason: `at ${url} uses another database (${body.db_path})` };
  }
  try {
    const res = await daemonApi(ctx.config, 'DELETE', `sessions/${encodeURIComponent(sessionId)}`, 10_000);
    const result = res.body as { already_closed?: unknown; disconnected?: unknown } | null;
    if (!res.ok || !result) return { used: false, url, reason: `at ${url} could not close it (HTTP ${res.status})` };
    return {
      used: true,
      url,
      pid: typeof body.pid === 'number' ? body.pid : null,
      alreadyClosed: result.already_closed === true,
      disconnected: result.disconnected === true,
    };
  } catch (err) {
    return { used: false, url, reason: `at ${url} did not answer (${(err as Error).message})` };
  }
}

/** What happens to the live connection behind a session the daemon did not disconnect. */
function connectionNote(session: Session, daemon: DaemonClose): string {
  const pid = session.host_pid;
  const host = pid ? `process ${pid}` : 'another process';
  if (pid && !processAlive(pid)) return `Its host process (pid ${pid}) has already exited, so there is no live connection left.`;
  if (session.transport === 'runner') {
    return `It belongs to a runner (${host}): a running runner opens a new session on its next check. Stop the runner to take it offline.`;
  }
  if (daemon.used && pid !== null && daemon.pid === pid) {
    return `The daemon (pid ${pid}) hosted this session but has no live MCP connection for it any more.`;
  }
  return (
    `Only the daemon can disconnect the connections it hosts${daemon.used ? ', and it does not host this one' : ''}: ` +
    `this ${session.transport} connection lives in ${host}, which stays connected until its client disconnects ` +
    '(restart or close that client window to end it).'
  );
}

/** Subcommands that need owner authentication (Touch ID) and therefore exist only in the dashboard. */
const PC_DASHBOARD_ONLY = ['start', 'resume', 'release', 'unkill', 'reenable', 're-enable', 'enable', 'on', 'allow', 'grant'];

/**
 * PC control from the terminal: `status` and `stop` only. Works on the database directly (no daemon needed). `status`
 * probes the helper without launching it; `stop` tells it as well (launching it when needed, at most 10 s).
 */
async function pcControlCommand(inv: Invocation): Promise<number> {
  const usage = 'pc-control status [--json] | pc-control stop [--json]';
  const sub = (inv.positionals[0] ?? 'status').trim().toLowerCase();
  if (inv.positionals.length > 1) {
    throw new BruceError('invalid_argument', `Unexpected argument "${inv.positionals[1]}".`, `Usage: bruce-comm ${usage}`);
  }
  if (PC_DASHBOARD_ONLY.includes(sub)) {
    throw new BruceError(
      'invalid_argument',
      `"pc-control ${sub}" is not available on the command line.`,
      'Switching agents on and re-enabling PC control need Touch ID: use the Bruce Comm dashboard (PC control panel).',
    );
  }
  if (sub !== 'status' && sub !== 'stop') {
    throw new BruceError('invalid_argument', `Unknown pc-control subcommand "${sub}".`, `Usage: bruce-comm ${usage}`);
  }
  const { getPcControl, NOT_TOLD_NOTE } = await import('./pccontrol/service.js');
  const ctx = inv.bruce();
  const pc = getPcControl(ctx);

  if (sub === 'stop') {
    const wasKilled = pc.store.isKilled().killed;
    const result = await pc.setKilled(true, 'cli');
    if (inv.json) {
      printJson({ ...result, was_killed: wasKilled });
      return 0;
    }
    if (result.db_error) {
      print(`WARNING: the stop could not be written to the Bruce Comm database (${result.db_error}).`);
    } else {
      print(
        wasKilled
          ? 'PC control was already stopped; it stays stopped (the first stop is kept).'
          : 'PC control STOPPED: Bruce Comm refuses every pc_* call from now on.',
      );
    }
    print(
      result.helper_notified
        ? 'BruceControl was told as well and refuses every action itself.'
        : `WARNING: ${NOT_TOLD_NOTE} (${result.helper_error ?? 'not reachable'})`,
    );
    print('Only the owner can re-enable it: dashboard > PC control > "Re-enable (Touch ID)".');
    return 0;
  }

  const status = await pc.status();
  const recent = pc.listLog({ limit: 10 });
  if (inv.json) {
    printJson({
      ...isoFields(status),
      agents: status.agents.map((a) => isoFields(a)),
      home: ctx.config.home,
      database: ctx.config.dbPath,
      recent_log: recent.map((r) => ({ ...r, at: iso(r.at) })),
    });
    return 0;
  }
  const h = status.helper;
  const enabled = status.agents.filter((a) => a.enabled);
  const byWho: Record<string, string> = { human: 'the dashboard', cli: 'the command line', hotkey: 'the hotkey', menu: 'the menu bar', daemon: 'Bruce Comm' };
  const by = (who: string | null) => (who ? (byWho[who] ?? who) : null);
  const killedBy = status.killed_updated_by ? ` by ${by(status.killed_updated_by)}` : '';
  const state = status.killed
    ? `STOPPED${killedBy} ${ago(status.killed_updated_at)} (kill switch engaged)`
    : h.killed
      ? "STOPPED by the helper's own kill switch (re-enable in the dashboard)"
      : enabled.length
        ? `active - ${enabled.length} agent(s) switched on: ${enabled.map((a) => a.agent_id).join(', ')}`
        : 'off - no agent is switched on';
  const yesNo = (v: boolean | undefined) => (v === undefined ? 'unknown' : v ? 'yes' : 'NO');
  let helper: string;
  if (h.reachable && h.mismatch) {
    helper = `running for ANOTHER data folder${h.home ? ` (${h.home})` : ''} - quit it from its menu bar; this Bruce Comm cannot use it`;
  } else if (h.reachable) {
    helper =
      `running${h.version ? ` v${h.version}` : ''}${h.pid ? ` (pid ${h.pid})` : ''} - Accessibility ${yesNo(h.accessibility)}, ` +
      `Screen Recording ${yesNo(h.screen_recording)}, hotkey ${h.hotkey_registered === false ? 'NOT registered' : 'registered'}` +
      (h.state_loading ? ', still loading its state' : '') +
      (h.signature_ok === false ? ', its state is UNREADABLE (it refuses everything)' : '');
  } else if (h.installed) {
    helper = `installed, not running (${h.app_path}); it starts on the first PC action`;
  } else {
    helper = `NOT installed (${h.app_path}) - run \`npm run build:helper\` in the Bruce Comm folder`;
  }
  print('PC control (computer use on macOS)');
  if (!status.platform_supported) print(`Platform:  not supported - PC control works on macOS only (this is ${process.platform})`);
  print(`State:     ${state}`);
  print(`Hotkey:    ${status.hotkey} stops everything (also: bruce-comm pc-control stop)`);
  print(`Helper:    ${helper}`);
  if (status.agents.length) {
    print('Agents:');
    print(
      indent(
        table(
          status.agents.map((a) => ({
            id: a.agent_id,
            name: a.registered ? a.name : '(unregistered)',
            pc: a.enabled ? 'ON' : 'off',
            grant: a.granted === null ? '?' : a.granted ? 'granted' : '-',
            changed: a.updated_at ? `${ago(a.updated_at)}${a.updated_by ? ` by ${by(a.updated_by)}` : ''}` : '-',
          })),
          [
            { key: 'id', label: 'ID', max: 28 },
            { key: 'name', label: 'NAME', max: 30 },
            { key: 'pc', label: 'PC CONTROL', max: 10 },
            { key: 'grant', label: 'HELPER GRANT', max: 12 },
            { key: 'changed', label: 'CHANGED', max: 30 },
          ],
        ),
      ),
    );
  } else {
    print('Agents:    none registered yet');
  }
  print(`Log:       ${status.log_total} action(s) recorded (kept 30 days)`);
  if (recent.length) {
    print('Recent actions:');
    print(
      indent(
        table(
          recent.map((r) => ({
            at: iso(r.at),
            agent: r.agent_id ?? '(none)',
            tool: r.tool,
            outcome: r.outcome,
            result: r.result,
          })),
          [
            { key: 'at', label: 'AT', max: 24 },
            { key: 'agent', label: 'AGENT', max: 24 },
            { key: 'tool', label: 'TOOL', max: 18 },
            { key: 'outcome', label: 'OUTCOME', max: 7 },
            { key: 'result', label: 'RESULT', max: 70 },
          ],
        ),
      ),
    );
  }
  print('\nSwitch agents on/off and re-enable after a stop in the dashboard (PC control panel; Touch ID).');
  return 0;
}

async function runnerCommand(inv: Invocation): Promise<number | void> {
  const sub = inv.positionals[0];
  const configFile = str(inv.values, 'config') ? path.resolve(str(inv.values, 'config')!) : inv.config().runnersFile;
  if (sub === 'init') {
    const result = writeExampleRunnerConfig(configFile, { force: inv.values.force === true });
    if (inv.json) return printJson(result);
    print(`Wrote ${result.file}${result.backup ? ` (previous file kept as ${result.backup})` : ''}`);
    print('All entries are DISABLED. Agent CLIs found on this machine:');
    for (const [preset, via] of Object.entries(result.detected)) print(`  ${preset.padEnd(13)} ${via ?? '(not found)'}`);
    print('\nNext: set "enabled": true on the entries you want, then run "bruce-comm runner check" and "bruce-comm runner".');
    return;
  }
  if (sub === 'check') {
    const report = await checkRunners(inv.bruce(), configFile);
    const failing = report.runners.some((r) => r.enabled && !r.ok);
    if (inv.json) {
      printJson(report);
      return failing ? 1 : 0;
    }
    print(`Runner config: ${report.file}`);
    if (!report.runners.length) print('No runners configured.');
    for (const r of report.runners) {
      const state = !r.enabled ? 'disabled' : r.ok ? 'OK' : 'PROBLEM';
      print(`\n[${state}] ${r.agent_id}  (preset ${r.preset}, result from ${r.result_from}, mcp ${r.mcp_transport})`);
      print(`  command: ${r.resolved ?? `${r.command ?? '-'} (not resolved)`}`);
      print(`  cwd:     ${r.cwd}`);
      for (const p of r.problems) print(`  problem: ${p}`);
      for (const w of r.warnings) print(`  note:    ${w}`);
    }
    const bad = report.runners.filter((r) => r.enabled && !r.ok).length;
    const enabled = report.runners.filter((r) => r.enabled).length;
    print(`\n${enabled} enabled, ${bad} with problems.${enabled && !bad ? ' Start with: bruce-comm runner' : ''}`);
    return bad ? 1 : 0;
  }
  if (sub !== undefined) {
    throw new BruceError('invalid_argument', `Unknown runner subcommand "${sub}".`, 'Use: bruce-comm runner [init|check]');
  }
  await runRunners(inv.bruce(), { configFile, only: list(inv.values, 'only'), once: inv.values.once === true });
}

function configCommand(inv: Invocation): void {
  const which = need(inv.positionals, 0, 'client name (or "all")', `config <client|all>   clients: ${CLIENT_IDS.join(', ')}`);
  const config = inv.config();
  const clients = which === 'all' ? CLIENTS : [getClient(which)];
  const options = { transport: transportOf(inv.values), port: int(inv.values, 'port', { min: 1, max: 65535 }), agentId: str(inv.values, 'agent-id') };
  if (options.agentId && clients.length > 1) throw new BruceError('invalid_argument', '--agent-id only makes sense for a single client.');
  const snippets = clients.map((c) => clientSnippet(config, c, options));
  if (inv.json) return printJson(snippets);
  for (const s of snippets) printSnippet(s);
  print(inspectorTip(config, options.port));
}

function printSnippet(s: ClientSnippet): void {
  print(`== ${s.title} [${s.client}] - ${s.transport}, agent id "${s.agent_id}" ==`);
  if (s.file) print(`File: ${s.file}   (merge into "${s.rootKey}", or run: bruce-comm install ${s.client})`);
  if (s.client === 'codex') print(`Add to ${path.join(process.env.CODEX_HOME || path.join(process.env.USERPROFILE || process.env.HOME || '~', '.codex'), 'config.toml')}:`);
  print(s.text);
  if (s.commands.length) {
    print('Or run:');
    for (const c of s.commands) print(`  ${c}`);
  }
  for (const n of s.notes) print(`Note: ${n}`);
  print();
}

function inspectorTip(config: BruceConfig, port?: number): string {
  return [
    'Tip - test the server with the MCP Inspector:',
    `  npx @modelcontextprotocol/inspector "${nodePath()}" "${bruceBinPath()}" stdio`,
    `  (HTTP: start "bruce-comm serve", run "npx @modelcontextprotocol/inspector", choose "Streamable HTTP" and ${mcpUrl(config, undefined, port)})`,
  ].join('\n');
}

const NORMAL_TERMINAL_NOTE =
  'Run "bruce-comm install" from a normal terminal: processes started inside the Claude Desktop (MSIX) container get their ' +
  'AppData writes virtualized, so the client would never see the change.';

function installCommand(inv: Invocation): number {
  const clientName = need(inv.positionals, 0, 'client name', `install <client>   clients: ${CLIENT_IDS.join(', ')}`);
  const client = getClient(clientName);
  const result = installClient(inv.config(), client.id, {
    transport: transportOf(inv.values),
    agentId: str(inv.values, 'agent-id'),
    port: int(inv.values, 'port', { min: 1, max: 65535 }),
    yes: inv.values.yes === true,
    dryRun: inv.values['dry-run'] === true,
    configFile: str(inv.values, 'config-file'),
  });
  if (inv.json) {
    printJson({ ...result, snippet: undefined, entry: result.snippet.entry, notes: result.snippet.notes });
    return 0;
  }
  for (const w of result.warnings) process.stderr.write(`warning: ${w}\n`);
  switch (result.action) {
    case 'printed':
      print(`${result.snippet.title} is not configured through a JSON file Bruce Comm edits.`);
      if (result.snippet.commands.length) {
        print('Run:');
        for (const c of result.snippet.commands) print(`  ${c}`);
        print('Or add:');
      }
      print(result.snippet.text);
      break;
    case 'dry-run':
      print(`Dry run - would write ${result.file}:`);
      print(result.content.trimEnd());
      break;
    case 'unchanged':
      print(`${result.snippet.title}: ${result.file} already has this bruce-comm entry - nothing to do.`);
      break;
    case 'written':
      print(`${result.snippet.title}: added bruce-comm (${result.snippet.transport}, agent id "${result.snippet.agent_id}") to ${result.file}`);
      if (result.backup) print(`Backup of the previous file: ${result.backup}`);
      break;
  }
  for (const n of result.snippet.notes) print(`Note: ${n}`);
  if (process.platform === 'win32') print(`Note: ${NORMAL_TERMINAL_NOTE}`);
  return 0;
}

// ---------------------------------------------------------------- doctor

type CheckLevel = 'ok' | 'warn' | 'fail' | 'info';
interface DoctorCheck {
  name: string;
  level: CheckLevel;
  detail: string;
}

async function doctorCommand(inv: Invocation): Promise<number> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, level: CheckLevel, detail: string) => checks.push({ name, level, detail });
  const next: string[] = [];

  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  add('node', nodeOk ? 'ok' : 'fail', `${process.versions.node} at ${process.execPath}${nodeOk ? '' : ' - Bruce Comm needs Node >= 22.13'}`);

  let config: BruceConfig | undefined;
  try {
    config = inv.config();
  } catch (err) {
    add('config', 'fail', (err as Error).message);
  }
  let ctx: BruceContext | undefined;
  if (config) {
    const underAppData = /[\\/]AppData[\\/]/i.test(config.home);
    add(
      'data dir',
      underAppData ? 'warn' : 'ok',
      `${config.home}${underAppData ? ' - inside AppData: stdio servers started by Claude Desktop (MSIX) may see a virtualized copy; prefer %USERPROFILE%\\.bruce-comm' : ''}`,
    );
    try {
      ctx = inv.bruce();
      ctx.store.db.exec('BEGIN IMMEDIATE');
      ctx.store.db.exec('ROLLBACK');
      const stats = ctx.store.stats();
      add('database', 'ok', `${config.dbPath} (writable; ${stats.agents.total} agent(s), ${Object.values(stats.tasks).reduce((a, b) => a + b, 0)} task(s))`);
      if (!stats.agents.total) next.push('Connect a client: "bruce-comm config all" (or "bruce-comm install <client>"), then ask it to register_agent.');
    } catch (err) {
      add('database', 'fail', `${config.dbPath}: ${(err as Error).message}`);
    }

    const daemon = await probeDaemon(config);
    if (daemon.ok) {
      add('daemon', 'ok', `running (${daemon.name} ${daemon.version}) - dashboard ${daemon.url.replace(/\/healthz$/, '/')}`);
    } else {
      const free = await portFree(config.host, config.port);
      add('daemon', 'info', `not running; port ${config.port} is ${free ? 'free' : 'IN USE by another program (use BRUCE_COMM_PORT / --port)'}`);
      next.push(free ? 'Start the daemon for the dashboard and HTTP clients: bruce-comm serve' : `Pick a free port: bruce-comm serve --port <n> (port ${config.port} is taken).`);
    }
    add('token', 'info', config.token ? 'BRUCE_COMM_TOKEN is set - HTTP clients need "Authorization: Bearer <token>"' : 'no token (loopback only)');

    try {
      const runners = loadRunnerConfig(config.runnersFile).runners;
      const enabled = runners.filter((r) => r.enabled);
      add('runner config', 'ok', `${config.runnersFile}: ${runners.length} entr${runners.length === 1 ? 'y' : 'ies'}, ${enabled.length} enabled`);
      if (enabled.length && ctx) {
        const report = await checkRunners(ctx, config.runnersFile);
        const bad = report.runners.filter((r) => r.enabled && !r.ok);
        if (bad.length) {
          add('runners', 'warn', `${bad.map((r) => `${r.agent_id}: ${r.problems.join('; ')}`).join(' | ')}`);
          next.push('Fix the runner problems shown by: bruce-comm runner check');
        } else {
          add('runners', 'ok', `${enabled.map((r) => r.agent.id).join(', ')} ready - start with: bruce-comm runner`);
        }
      }
    } catch (err) {
      const e = err as BruceError;
      if (e.code === 'no_runner_config') {
        add('runner config', 'info', `${config.runnersFile} not found (optional - for unattended headless agents)`);
        next.push('Optional: let headless CLIs process tasks unattended: bruce-comm runner init');
      } else {
        add('runner config', 'fail', e.message);
      }
    }
  }

  const found: string[] = [];
  const missing: string[] = [];
  for (const preset of PRESET_IDS) {
    if (preset === 'custom') continue;
    const d = detectPresetCommand(preset);
    if (d.via) found.push(`${preset} (${d.via})`);
    else missing.push(preset);
  }
  add('agent CLIs', found.length ? 'ok' : 'info', `${found.length ? `found: ${found.join('; ')}` : 'none found'}${missing.length ? `; not found: ${missing.join(', ')}` : ''}`);

  if (config) {
    const configured: string[] = [];
    for (const client of CLIENTS) {
      if (client.kind !== 'json-file') continue;
      try {
        const { data } = readJsonConfig(installTarget(client));
        const servers = data[client.rootKey!] as Record<string, unknown> | undefined;
        if (servers && typeof servers === 'object' && SERVER_NAME in servers) configured.push(client.id);
      } catch {
        // unreadable client config - not our business here
      }
    }
    add('clients', configured.length ? 'ok' : 'info', configured.length ? `bruce-comm configured in: ${configured.join(', ')}` : 'no client config mentions bruce-comm yet');
  }

  if (inv.json) {
    printJson({ checks, next_steps: next });
  } else {
    const label: Record<CheckLevel, string> = { ok: 'OK  ', warn: 'WARN', fail: 'FAIL', info: 'INFO' };
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const c of checks) print(`[${label[c.level]}] ${c.name.padEnd(width)}  ${c.detail}`);
    print();
    print(next.length ? `Next step: ${next[0]}` : 'Everything looks good.');
    for (const n of next.slice(1)) print(`      then: ${n}`);
  }
  return checks.some((c) => c.level === 'fail') ? 1 : 0;
}

function portFree(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------- entry point

/** Run the CLI with the given arguments (without "node bruce-comm"). Returns the process exit code. */
export async function main(argv: string[]): Promise<number> {
  const [first, ...rest] = argv;
  if (!first || first === '--help' || first === '-h') {
    print(helpText());
    return 0;
  }
  if (first === '--version' || first === '-v') {
    print(`${SERVER_NAME} ${SERVER_VERSION}`);
    return 0;
  }
  const command = COMMANDS.find((c) => c.name === first);
  if (!command) {
    process.stderr.write(`bruce-comm: unknown command "${first}". Run "bruce-comm help" for the list.\n`);
    return 1;
  }
  let ctx: BruceContext | undefined;
  try {
    const parsed = parseArgs({
      args: rest,
      options: { ...GLOBAL_OPTIONS, ...(command.options ?? {}) },
      allowPositionals: true,
      strict: true,
    });
    const values = parsed.values as Values;
    if (values.help) {
      print(helpText(command.name));
      return 0;
    }
    const overrides: Partial<BruceConfig> = {};
    const home = str(values, 'home');
    if (home) overrides.home = path.resolve(home);
    if (command.name === 'serve') {
      const port = int(values, 'port', { min: 0, max: 65535 });
      if (port !== undefined) overrides.port = port;
      if (str(values, 'host')) overrides.host = str(values, 'host');
      if (str(values, 'token')) overrides.token = str(values, 'token');
    }
    let config: BruceConfig | undefined;
    const inv: Invocation = {
      values,
      positionals: parsed.positionals,
      json: values.json === true,
      config: () => (config ??= ctx?.config ?? loadConfig(overrides)),
      bruce: () => (ctx ??= createContext(overrides)),
    };
    const code = await command.run(inv);
    return typeof code === 'number' ? code : 0;
  } catch (err) {
    reportError(err, command.name);
    return 1;
  } finally {
    ctx?.close();
  }
}

function reportError(err: unknown, commandName: string): void {
  if (process.env.BRUCE_COMM_DEBUG === '1' && err instanceof Error && err.stack) {
    process.stderr.write(`${err.stack}\n`);
  }
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (err instanceof BruceError) {
    process.stderr.write(`bruce-comm: ${err.message}\n`);
    if (err.hint) process.stderr.write(`  hint: ${err.hint}\n`);
  } else if (typeof code === 'string' && code.startsWith('ERR_PARSE_ARGS')) {
    process.stderr.write(`bruce-comm: ${(err as Error).message}\n  hint: run "bruce-comm help ${commandName}"\n`);
  } else {
    process.stderr.write(`bruce-comm: ${(err as Error)?.message ?? String(err)}\n`);
  }
}
