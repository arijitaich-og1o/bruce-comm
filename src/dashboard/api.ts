import fs from 'node:fs';
import type http from 'node:http';
import { SERVER_NAME, SERVER_VERSION } from '../config.js';
import type { BruceContext } from '../context.js';
import { getPcControl } from '../pccontrol/service.js';
import { presenceOf } from '../store/store.js';
import {
  AGENT_STATUSES,
  HUMAN_ID,
  TASK_STATUSES,
  TERMINAL_STATUSES,
  type Agent,
  type AgentPatch,
  type AgentStatus,
  type SendInput,
  type Session,
  type Task,
  type TaskFilter,
  type TaskKind,
  type TaskStatus,
} from '../store/types.js';
import { BruceError } from '../util.js';
import type { EventHub } from './events.js';
import { HttpError, readJsonObject, sendError, sendJson } from './http-util.js';

/** What the REST layer needs from the HTTP server that hosts it. */
export interface ApiHost {
  ctx: BruceContext;
  events: EventHub;
  /** Base URL of the gateway, e.g. http://127.0.0.1:7457 */
  baseUrl: () => string;
  startedAt: number;
  /** Number of live MCP sessions on this daemon. */
  mcpSessionCount: () => number;
  /** Disconnect the MCP connection behind a Bruce session id if this daemon hosts it. Resolves true if one was closed. */
  disconnectSession: (sessionId: string) => Promise<boolean>;
}

type Handler = (host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[], url: URL) => Promise<void> | void;

interface Route {
  /** Path segments after /api; ':' marks a parameter. */
  pattern: string[];
  methods: Partial<Record<string, Handler>>;
}

const ACTIVE_STATUSES: TaskStatus[] = ['awaiting_approval', 'queued', 'working', 'input_required'];
const TASK_ROLES = ['all', 'sent', 'inbox', 'assigned', 'to'] as const;
const DEFAULT_TASK_LIMIT = 100;
const MAX_TASK_LIMIT = 500;

/** HTTP status for each BruceError code; anything unlisted is a client error (400). */
const STATUS_BY_CODE: Record<string, number> = {
  unknown_agent: 404,
  unknown_task: 404,
  unknown_session: 404,
  not_found: 404,
  not_allowed: 403,
  not_assignee: 403,
  invalid_state: 409,
  rate_limited: 429,
  queue_full: 429,
  // PC control
  pc_auth_failed: 403,
  pc_control_refused: 403,
  pc_not_allowed: 403,
  pc_killed: 409,
  pc_permission_missing: 409,
  pc_helper_busy: 409,
  pc_helper_error: 502,
  pc_helper_missing: 503,
  pc_helper_not_running: 503,
  pc_helper_timeout: 504,
  pc_stop_failed: 500,
  unsupported_platform: 501,
};

const ROUTES: Route[] = [
  { pattern: ['status'], methods: { GET: getStatus } },
  { pattern: ['events'], methods: { GET: (host, req, res) => host.events.open(req, res) } },
  { pattern: ['agents'], methods: { GET: listAgents } },
  { pattern: ['agents', ':'], methods: { GET: getAgent, PATCH: patchAgent, DELETE: deleteAgent } },
  { pattern: ['sessions'], methods: { GET: listSessions } },
  { pattern: ['sessions', ':'], methods: { GET: getSession, DELETE: closeSession } },
  { pattern: ['tasks'], methods: { GET: listTasks, POST: createTask } },
  { pattern: ['tasks', ':'], methods: { GET: getTask } },
  { pattern: ['tasks', ':', 'cancel'], methods: { POST: cancelTask } },
  { pattern: ['tasks', ':', 'input'], methods: { POST: answerTask } },
  { pattern: ['tasks', ':', 'notes'], methods: { POST: addNote } },
  { pattern: ['tasks', ':', 'approve'], methods: { POST: approveTask } },
  { pattern: ['tasks', ':', 'deny'], methods: { POST: denyTask } },
  { pattern: ['pc-control'], methods: { GET: getPcControlStatus } },
  { pattern: ['pc-control', 'agents', ':'], methods: { POST: setPcAgent } },
  { pattern: ['pc-control', 'kill'], methods: { POST: setPcKill } },
  { pattern: ['pc-control', 'permissions'], methods: { POST: requestPcPermissions } },
  { pattern: ['pc-control', 'log'], methods: { GET: listPcLog } },
  { pattern: ['pc-control', 'log', ':', 'thumbnail'], methods: { GET: getPcThumbnail } },
];

/**
 * Serve one `/api/*` request. Writes are always performed as the reserved actor `human`
 * (the dashboard / CLI user). Errors become `{error: {code, message, hint}}`.
 */
export async function handleApiRequest(
  host: ApiHost,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
): Promise<void> {
  try {
    const segments = splitPath(url.pathname);
    const match = matchRoute(segments);
    if (!match) throw new HttpError(404, 'not_found', `No API route ${url.pathname}.`, 'See GET /api/status, /api/agents, /api/tasks, /api/pc-control.');
    const method = req.method ?? 'GET';
    // HEAD mirrors GET (Node drops the body), except on the event stream, which would stay open.
    const headOk = method === 'HEAD' && match.route.pattern[0] !== 'events';
    const handler = match.route.methods[method] ?? (headOk ? match.route.methods.GET : undefined);
    if (!handler) {
      const allow = Object.keys(match.route.methods).join(', ');
      req.resume();
      return sendError(res, 405, 'method_not_allowed', `${method} is not supported on ${url.pathname}.`, `Allowed: ${allow}.`, {
        Allow: allow,
      });
    }
    await handler(host, req, res, match.params, url);
  } catch (err) {
    sendApiError(host, res, err);
  }
}

// ---------------------------------------------------------------- routing

function splitPath(pathname: string): string[] {
  const parts = pathname.split('/').filter(Boolean).slice(1); // drop "api"
  return parts.map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      throw new HttpError(400, 'invalid_argument', 'Malformed URL encoding in path.');
    }
  });
}

function matchRoute(segments: string[]): { route: Route; params: string[] } | null {
  for (const route of ROUTES) {
    if (route.pattern.length !== segments.length) continue;
    const params: string[] = [];
    const ok = route.pattern.every((part, i) => {
      if (part === ':') {
        params.push(segments[i]!);
        return true;
      }
      return part === segments[i];
    });
    if (ok) return { route, params };
  }
  return null;
}

function sendApiError(host: ApiHost, res: http.ServerResponse, err: unknown): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  if (err instanceof HttpError) return sendError(res, err.status, err.code, err.message, err.hint);
  if (err instanceof BruceError) {
    return sendError(res, STATUS_BY_CODE[err.code] ?? 400, err.code, err.message, err.hint);
  }
  host.ctx.log(`REST handler error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  sendError(res, 500, 'internal_error', 'Unexpected server error; see the Bruce Comm daemon log.');
}

// ---------------------------------------------------------------- views

/** Agent card for the dashboard: profile + derived presence + attention counters + live sessions. */
function agentView(host: ApiHost, agent: Agent, now: number, sessions: Session[]) {
  let counts = null;
  try {
    counts = host.ctx.store.pendingCounts(agent.id);
  } catch {
    // agent removed concurrently - counts are optional
  }
  return { ...agent, presence: presenceOf(agent, now), counts, sessions };
}

/** Connected sessions grouped by agent id (key '' = connections that have not registered an agent yet). */
function sessionsByAgent(host: ApiHost): Map<string, Session[]> {
  const byAgent = new Map<string, Session[]>();
  for (const session of host.ctx.store.listSessions({ limit: 500 })) {
    const key = session.agent_id ?? '';
    const list = byAgent.get(key) ?? [];
    list.push(session);
    byAgent.set(key, list);
  }
  return byAgent;
}

const PREVIEW_CHARS = 280;
const MESSAGE_CHARS = 500;

/** Compact task row for lists: no body/input/result payloads (fetch GET /api/tasks/:id for those). */
function taskSummary(task: Task) {
  const { body, input, result, result_data, error, status_message, ...rest } = task;
  return {
    ...rest,
    body_preview: truncate(body, PREVIEW_CHARS),
    status_message: status_message == null ? null : truncate(status_message, MESSAGE_CHARS),
    error: error == null ? null : truncate(error, MESSAGE_CHARS),
    has_input: input != null,
    has_result: result != null || result_data != null,
  };
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// ---------------------------------------------------------------- handlers: status & agents

function getStatus(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const base = host.baseUrl();
  sendJson(res, 200, {
    name: SERVER_NAME,
    version: SERVER_VERSION,
    url: base,
    mcp_url: `${base}/mcp`,
    dashboard_url: `${base}/`,
    started_at: host.startedAt,
    now: Date.now(),
    pid: process.pid,
    token_required: Boolean(host.ctx.config.token),
    db_path: host.ctx.config.dbPath,
    sessions: { mcp: host.mcpSessionCount(), events: host.events.size },
    stats: host.ctx.store.stats(),
  });
}

function listAgents(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse): void {
  const now = Date.now();
  const sessions = sessionsByAgent(host);
  const agents = host.ctx.store.listAgents().map((agent) => agentView(host, agent, now, sessions.get(agent.id) ?? []));
  // Live connections whose client has not called register_agent (or passed an agent_id) yet.
  const unregistered = [...sessions.entries()]
    .filter(([agentId]) => agentId === '' || !agents.some((a) => a.id === agentId))
    .flatMap(([, list]) => list);
  sendJson(res, 200, { agents, unregistered_sessions: unregistered });
}

function getAgent(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, params: string[]): void {
  const agent = host.ctx.store.requireAgent(params[0]!);
  const tasks = tasksInvolving(host, agent.id, {}, 20).map(taskSummary);
  const sessions = host.ctx.store.listSessions({ agent_id: agent.id });
  sendJson(res, 200, { agent: agentView(host, agent, Date.now(), sessions), tasks });
}

async function patchAgent(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['require_approval', 'accept_from', 'max_concurrent_tasks', 'status']);
  const patch: AgentPatch = {};
  if (body.require_approval !== undefined) patch.require_approval = requireBoolean(body.require_approval, 'require_approval');
  if (body.accept_from !== undefined) patch.accept_from = parseAcceptFrom(body.accept_from);
  if (body.max_concurrent_tasks !== undefined) {
    patch.max_concurrent_tasks = requireNumber(body.max_concurrent_tasks, 'max_concurrent_tasks', 1, 50);
  }
  if (body.status !== undefined) {
    if (!AGENT_STATUSES.includes(body.status as AgentStatus)) {
      throw new HttpError(400, 'invalid_argument', `status must be one of ${AGENT_STATUSES.join(', ')}.`);
    }
    patch.status = body.status as AgentStatus;
  }
  if (Object.keys(patch).length === 0) {
    throw new HttpError(400, 'invalid_argument', 'Nothing to change.', 'Send at least one of require_approval, accept_from, max_concurrent_tasks, status.');
  }
  const agent = host.ctx.store.updateAgent(params[0]!, patch, { asHuman: true });
  sendJson(res, 200, { agent: agentView(host, agent, Date.now(), host.ctx.store.listSessions({ agent_id: agent.id })) });
}

function deleteAgent(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, params: string[]): void {
  const result = host.ctx.store.unregisterAgent(params[0]!, { asHuman: true });
  if (!result.removed) {
    throw new BruceError('unknown_agent', `No agent registered with id "${params[0]}".`, 'It may already have been removed.');
  }
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------- handlers: sessions

function listSessions(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, _params: string[], url: URL): void {
  const q = url.searchParams;
  const agent = q.get('agent')?.trim().toLowerCase() || undefined;
  const includeClosed = ['1', 'true', 'yes'].includes((q.get('include_closed') ?? '').toLowerCase());
  const limit = parseLimit(q.get('limit'));
  sendJson(res, 200, { sessions: host.ctx.store.listSessions({ agent_id: agent, include_closed: includeClosed, limit }) });
}

function getSession(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, params: string[]): void {
  sendJson(res, 200, { session: host.ctx.store.requireSession(params[0]!) });
}

/**
 * The human closes a session (typically a stale one). Work pinned to it is released by the store; if this daemon
 * hosts the MCP connection behind it, that connection is ended too so the database and reality agree.
 */
async function closeSession(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const before = host.ctx.store.requireSession(params[0]!);
  const alreadyClosed = before.closed_at !== null;
  if (!alreadyClosed) host.ctx.store.closeSession(before.id, 'closed from the dashboard');
  const disconnected = await host.disconnectSession(before.id);
  sendJson(res, 200, { session: host.ctx.store.requireSession(before.id), already_closed: alreadyClosed, disconnected });
}

// ---------------------------------------------------------------- handlers: tasks

function listTasks(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, _params: string[], url: URL): void {
  const q = url.searchParams;
  const status = parseStatuses(q.get('status'));
  const kind = parseKind(q.get('kind'));
  const thread = q.get('thread')?.trim() || undefined;
  const limit = parseLimit(q.get('limit'));
  const agent = q.get('agent')?.trim().toLowerCase() || undefined;
  const role = (q.get('role')?.trim().toLowerCase() || 'all') as (typeof TASK_ROLES)[number];
  if (!TASK_ROLES.includes(role)) {
    throw new HttpError(400, 'invalid_argument', `role must be one of ${TASK_ROLES.join(', ')}.`);
  }
  const base: TaskFilter = { status, kind, thread_id: thread, limit };
  let tasks: Task[];
  if (!agent) tasks = host.ctx.store.listTasks(base);
  else if (role === 'sent') tasks = host.ctx.store.listTasks({ ...base, from_agent: agent });
  else if (role === 'inbox') tasks = host.ctx.store.listTasks({ ...base, inbox_of: agent });
  else if (role === 'assigned') tasks = host.ctx.store.listTasks({ ...base, assignee: agent });
  else if (role === 'to') tasks = host.ctx.store.listTasks({ ...base, to_agent: agent });
  else tasks = tasksInvolving(host, agent, base, limit);
  sendJson(res, 200, { tasks: tasks.map(taskSummary), limit });
}

/** Tasks an agent sent, was addressed or is assigned - newest first, de-duplicated. */
function tasksInvolving(host: ApiHost, agentId: string, base: TaskFilter, limit: number): Task[] {
  const store = host.ctx.store;
  const byId = new Map<string, Task>();
  for (const filter of [{ from_agent: agentId }, { to_agent: agentId }, { assignee: agentId }]) {
    for (const task of store.listTasks({ ...base, ...filter, limit })) byId.set(task.id, task);
  }
  return [...byId.values()]
    .sort((a, b) => b.created_at - a.created_at || (a.id < b.id ? 1 : -1))
    .slice(0, limit);
}

function getTask(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, params: string[]): void {
  const task = host.ctx.store.requireTask(params[0]!);
  sendJson(res, 200, { task, events: host.ctx.store.getEvents(task.id) });
}

const SEND_FIELDS = [
  'to_agent',
  'to_skill',
  'broadcast',
  'kind',
  'title',
  'body',
  'input',
  'priority',
  'expires_in_seconds',
  'delay_seconds',
  'thread_id',
  'idempotency_key',
  'lease_seconds',
  'max_attempts',
  'to_session',
  'to_workspace',
] as const;

async function createTask(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, SEND_FIELDS);
  const input: SendInput = {
    to_agent: optionalString(body.to_agent, 'to_agent'),
    to_skill: optionalString(body.to_skill, 'to_skill'),
    broadcast: body.broadcast === undefined ? undefined : requireBoolean(body.broadcast, 'broadcast'),
    kind: parseKind(body.kind as string | undefined),
    title: optionalString(body.title, 'title') ?? '',
    body: optionalString(body.body, 'body'),
    input: body.input,
    priority: optionalNumber(body.priority, 'priority', 0, 9),
    expires_in_seconds: optionalNumber(body.expires_in_seconds, 'expires_in_seconds', 1, 365 * 24 * 3600),
    delay_seconds: optionalNumber(body.delay_seconds, 'delay_seconds', 0, 365 * 24 * 3600),
    thread_id: optionalString(body.thread_id, 'thread_id'),
    idempotency_key: optionalString(body.idempotency_key, 'idempotency_key'),
    lease_seconds: optionalNumber(body.lease_seconds, 'lease_seconds', 1, 365 * 24 * 3600),
    max_attempts: optionalNumber(body.max_attempts, 'max_attempts', 1, 1000),
    to_session: optionalString(body.to_session, 'to_session')?.trim() || undefined,
    to_workspace: optionalString(body.to_workspace, 'to_workspace')?.trim() || undefined,
  };
  const result = host.ctx.store.send(HUMAN_ID, input);
  sendJson(res, result.deduplicated ? 200 : 201, result);
}

async function cancelTask(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['reason']);
  const task = host.ctx.store.cancel(HUMAN_ID, params[0]!, optionalString(body.reason, 'reason'));
  sendJson(res, 200, { task });
}

async function answerTask(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['answer', 'data']);
  const answer = optionalString(body.answer, 'answer');
  if (!answer?.trim()) throw new HttpError(400, 'invalid_argument', 'answer is required.');
  const task = host.ctx.store.provideInput(HUMAN_ID, params[0]!, answer, body.data);
  sendJson(res, 200, { task });
}

async function addNote(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['note', 'data']);
  const note = optionalString(body.note, 'note');
  if (!note?.trim()) throw new HttpError(400, 'invalid_argument', 'note is required.');
  const event = host.ctx.store.addNote(HUMAN_ID, params[0]!, note, body.data);
  sendJson(res, 201, { event, task: host.ctx.store.requireTask(params[0]!) });
}

async function approveTask(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['note']);
  const task = host.ctx.store.approve(params[0]!, optionalString(body.note, 'note'));
  sendJson(res, 200, { task });
}

async function denyTask(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['reason']);
  const task = host.ctx.store.deny(params[0]!, optionalString(body.reason, 'reason'));
  sendJson(res, 200, { task });
}

// ---------------------------------------------------------------- handlers: PC control

const PC_LOG_DEFAULT_LIMIT = 50;
const PC_LOG_MAX_LIMIT = 500;

/** Panel state: kill switch, helper, agents (all registered, default off) and the newest 50 log rows. */
async function getPcControlStatus(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const pc = getPcControl(host.ctx);
  const status = await pc.status();
  sendJson(res, 200, { ...status, log: pc.listLog({ limit: PC_LOG_DEFAULT_LIMIT }) });
}

/**
 * Switch an agent on (Touch ID through the helper; may take up to 120 s) or off (the helper is told, launched if
 * needed, within 10 s; `helper_notified` / `helper_error` / `db_error` say what reached whom).
 */
async function setPcAgent(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['enabled']);
  const enabled = requireBoolean(body.enabled, 'enabled');
  sendJson(res, 200, await getPcControl(host.ctx).setAgentEnabled(params[0]!, enabled, HUMAN_ID));
}

/**
 * Engage (no auth; the helper is told, launched if needed, within 10 s - see `helper_notified` / `helper_error` /
 * `db_error`) or release (Touch ID through the helper) the kill switch.
 */
async function setPcKill(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const body = await readJsonObject(req);
  allowOnly(body, ['killed']);
  const killed = requireBoolean(body.killed, 'killed');
  sendJson(res, 200, await getPcControl(host.ctx).setKilled(killed, HUMAN_ID));
}

/** Ask the helper to show the macOS permission prompts (launches it; never edits settings). */
async function requestPcPermissions(host: ApiHost, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  allowOnly(await readJsonObject(req), []);
  sendJson(res, 200, { requested: true, permissions: await getPcControl(host.ctx).requestPermissions() });
}

/** Action log, newest first: ?limit= (default 50, max 500) &before_id= &agent= */
function listPcLog(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, _params: string[], url: URL): void {
  const q = url.searchParams;
  const limit = Math.min(positiveInt(q.get('limit'), 'limit') ?? PC_LOG_DEFAULT_LIMIT, PC_LOG_MAX_LIMIT);
  const beforeId = positiveInt(q.get('before_id'), 'before_id');
  const agent = q.get('agent')?.trim().toLowerCase() || undefined;
  const log = getPcControl(host.ctx).listLog({ limit, before_id: beforeId, agent_id: agent });
  sendJson(res, 200, { log, limit, next_before_id: log.length === limit ? log[log.length - 1]!.id : null });
}

/** Thumbnail JPEG of a log row; only files inside <home>/pc-control/thumbs are served (see PcControlStore.thumbnailFile). */
function getPcThumbnail(host: ApiHost, _req: http.IncomingMessage, res: http.ServerResponse, params: string[]): Promise<void> {
  const id = positiveInt(params[0]!, 'log id')!;
  const file = getPcControl(host.ctx).thumbnailFile(id);
  const missing = () => new HttpError(404, 'not_found', `Log entry ${id} has no thumbnail.`, 'Thumbnails exist only for successful actions and are kept 30 days.');
  if (!file) throw missing();
  return new Promise<void>((resolve) => {
    const stream = fs.createReadStream(file);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        const e = missing();
        sendError(res, e.status, e.code, e.message, e.hint);
      } else {
        res.destroy(err);
      }
      resolve();
    });
    stream.on('open', (fd) => {
      const headers: Record<string, string> = { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=86400' };
      try {
        headers['Content-Length'] = String(fs.fstatSync(fd).size);
      } catch {
        // length is optional
      }
      res.writeHead(200, headers);
      stream.pipe(res);
    });
    res.on('close', () => {
      stream.destroy();
      resolve();
    });
  });
}

// ---------------------------------------------------------------- input parsing

function allowOnly(body: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(body).filter((key) => !allowed.includes(key));
  if (unknown.length) {
    throw new HttpError(400, 'invalid_argument', `Unknown field(s): ${unknown.join(', ')}.`, `Allowed: ${allowed.join(', ')}.`);
  }
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new HttpError(400, 'invalid_argument', `${field} must be a string.`);
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, 'invalid_argument', `${field} must be true or false.`);
  return value;
}

function optionalNumber(value: unknown, field: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null) return undefined;
  return requireNumber(value, field, min, max);
}

function requireNumber(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new HttpError(400, 'invalid_argument', `${field} must be a number between ${min} and ${max}.`);
  }
  return value;
}

function parseAcceptFrom(value: unknown): string[] {
  const list = typeof value === 'string' ? value.split(',') : value;
  if (!Array.isArray(list) || list.some((x) => typeof x !== 'string')) {
    throw new HttpError(400, 'invalid_argument', 'accept_from must be an array of agent ids (or ["*"]).');
  }
  const ids = list.map((x: string) => x.trim()).filter(Boolean);
  if (!ids.length) throw new HttpError(400, 'invalid_argument', 'accept_from must not be empty; use ["*"] to accept everyone.');
  return ids;
}

function parseStatuses(raw: string | null): TaskStatus[] | undefined {
  if (!raw?.trim()) return undefined;
  const out = new Set<TaskStatus>();
  for (const part of raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (part === 'active' || part === 'open') ACTIVE_STATUSES.forEach((s) => out.add(s));
    else if (part === 'terminal' || part === 'done') TERMINAL_STATUSES.forEach((s) => out.add(s));
    else if ((TASK_STATUSES as readonly string[]).includes(part)) out.add(part as TaskStatus);
    else {
      throw new HttpError(400, 'invalid_argument', `Unknown status "${part}".`, `Use ${TASK_STATUSES.join(', ')}, "active" or "terminal".`);
    }
  }
  return out.size ? [...out] : undefined;
}

function parseKind(raw: string | null | undefined): TaskKind | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (raw !== 'task' && raw !== 'message') throw new HttpError(400, 'invalid_argument', 'kind must be "task" or "message".');
  return raw;
}

/** Optional positive integer from a query string or path segment. */
function positiveInt(raw: string | null, field: string): number | undefined {
  if (raw === null || raw === '') return undefined;
  const n = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new HttpError(400, 'invalid_argument', `${field} must be a positive integer.`);
  return n;
}

function parseLimit(raw: string | null): number {
  if (!raw) return DEFAULT_TASK_LIMIT;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'invalid_argument', 'limit must be a positive integer.');
  return Math.min(n, MAX_TASK_LIMIT);
}
