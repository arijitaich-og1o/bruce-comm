import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { SERVER_NAME, SERVER_VERSION } from '../config.js';
import { tolerateBrokenStderr } from '../context.js';
import { handleApiRequest } from '../dashboard/api.js';
import { EventHub } from '../dashboard/events.js';
import { HttpError, headerValue, isJsonContentType, parseCookies, readBody, secretEquals, sendError, sendJson, sendJsonRpcError, setBaseHeaders, } from '../dashboard/http-util.js';
import { DASHBOARD_CSP, DASHBOARD_HTML, FAVICON_SVG } from '../dashboard/page.js';
import { createBruceServer, normalizeRunnerTask } from '../mcp/server.js';
import { startPcGlowKillSync } from '../pccontrol/service.js';
import { normalizeAgentId } from '../store/store.js';
import { BruceError } from '../util.js';
/** Dashboard auth cookie, set by visiting /?token=<token>. */
const TOKEN_COOKIE = 'bruce_token';
const TOKEN_COOKIE_MAX_AGE_S = 30 * 24 * 3600;
/** Upper bound on concurrent MCP sessions (each holds an McpServer). */
const MAX_MCP_SESSIONS = 1000;
/**
 * Start the Streamable HTTP MCP endpoint (/mcp), REST API (/api), dashboard (/) on ctx.config.host:port.
 * Port 0 picks a free port; the handle reports the real one.
 */
export async function startHttpServer(ctx, tuning = {}) {
    tolerateBrokenStderr();
    const startedAt = Date.now();
    const sessions = new McpSessionManager(ctx, tuning.sessionIdleMs ?? 30 * 60_000);
    const events = new EventHub(ctx, startedAt, { heartbeatMs: tuning.heartbeatMs });
    let port = ctx.config.port;
    // Rebuilt once the real port is known (port 0 = pick a free one); no request can arrive before that.
    let guard = new RequestGuard(ctx, port);
    const baseUrl = () => `http://${urlHost(ctx.config.host)}:${port}`;
    const api = {
        ctx,
        events,
        baseUrl,
        startedAt,
        mcpSessionCount: () => sessions.size,
        disconnectSession: (id) => sessions.disconnect(id),
    };
    const server = http.createServer((req, res) => {
        void route(req, res).catch((err) => {
            ctx.log(`HTTP handler error on ${req.method} ${req.url}: ${describe(err)}`);
            if (!res.headersSent)
                sendError(res, 500, 'internal_error', 'Unexpected server error; see the Bruce Comm daemon log.');
            else
                res.destroy();
        });
    });
    const refusalLog = new RefusalLog(ctx);
    async function route(req, res) {
        setBaseHeaders(res);
        const rejection = guard.check(req);
        if (rejection) {
            refusalLog.record(req, rejection);
            req.resume();
            return sendError(res, 403, 'forbidden', rejection, 'Bruce Comm only answers requests addressed to its loopback URL.');
        }
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        const path = url.pathname;
        // Every REST write (dashboard buttons, CLI over HTTP) leaves one line in the daemon log, so a click that did not
        // take effect can be traced. Path only: the query string is never logged.
        if ((path === '/api' || path.startsWith('/api/')) && WRITE_METHODS.has(req.method ?? '')) {
            const started = Date.now();
            const line = `${req.method} ${path}`;
            res.once('finish', () => ctx.log(`${new Date().toISOString()} api ${logSafe(line)} -> ${res.statusCode} (${Date.now() - started} ms)`));
        }
        if (path === '/healthz')
            return serveHealth(req, res);
        if (path === '/mcp') {
            if (!guard.authorized(req, false))
                return guard.rejectMcp(res);
            return sessions.handle(req, res, url);
        }
        if (path === '/api' || path.startsWith('/api/')) {
            if (!guard.authorized(req, true))
                return guard.rejectApi(req, res, baseUrl());
            return handleApiRequest(api, req, res, url);
        }
        if (path === '/' || path === '/index.html')
            return guard.servePage(req, res, url);
        if (path === '/favicon.svg' || path === '/favicon.ico')
            return serveFavicon(req, res);
        req.resume();
        sendError(res, 404, 'not_found', `Nothing at ${path}.`, 'Dashboard: /, MCP endpoint: /mcp, REST API: /api/status.');
    }
    await listen(server, ctx.config.host, ctx.config.port);
    // Only after listening: start-up failures (busy port) are already reported once, as the clean error listen() rejects with.
    server.on('error', (err) => ctx.log(`HTTP server error: ${describe(err)}`));
    port = server.address().port;
    guard = new RequestGuard(ctx, port);
    sessions.start(tuning.reapIntervalMs ?? 60_000);
    const sweeper = setInterval(() => {
        try {
            ctx.store.sweep();
        }
        catch (err) {
            ctx.log(`sweep failed: ${describe(err)}`);
        }
    }, tuning.sweepIntervalMs ?? 5000);
    sweeper.unref();
    // GlowCursor: mirror the PC control stop flag to the cursor (no-op while the bridge is off).
    const stopGlowSync = startPcGlowKillSync(ctx);
    let closing = null;
    return {
        url: baseUrl(),
        port,
        close: () => {
            closing ??= (async () => {
                clearInterval(sweeper);
                stopGlowSync();
                events.close();
                await sessions.closeAll();
                await closeServer(server);
            })();
            return closing;
        },
    };
}
// ---------------------------------------------------------------- request log
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Refused requests logged per minute; the rest are counted and reported once, so a hostile page cannot flood the log. */
export const REFUSAL_LOG_PER_MINUTE = 20;
/** Client-supplied text for one log line: printable ASCII only, capped. */
function logSafe(value, max = 200) {
    const clean = value.replace(/[^\x20-\x7e]/g, '?');
    return clean.length > max ? `${clean.slice(0, max)}...` : clean;
}
/** Logs requests the Host / Origin guard refused (method, path without query, reason), rate-limited. */
class RefusalLog {
    ctx;
    windowStart = 0;
    count = 0;
    suppressed = 0;
    constructor(ctx) {
        this.ctx = ctx;
    }
    record(req, reason) {
        const now = Date.now();
        if (now - this.windowStart >= 60_000) {
            if (this.suppressed)
                this.ctx.log(`${new Date(now).toISOString()} refused ${this.suppressed} more request(s) in the last minute (not logged one by one)`);
            this.windowStart = now;
            this.count = 0;
            this.suppressed = 0;
        }
        if (++this.count > REFUSAL_LOG_PER_MINUTE) {
            this.suppressed++;
            return;
        }
        const path = (req.url ?? '/').split('?')[0];
        this.ctx.log(`${new Date(now).toISOString()} refused ${logSafe(req.method ?? '?', 10)} ${logSafe(path)}: ${logSafe(reason)}`);
    }
}
// ---------------------------------------------------------------- security: Host / Origin / token
/**
 * DNS-rebinding and cross-site protection plus optional bearer-token auth.
 * Host must name the loopback address WITH our port; Origin, when present, must be one of the
 * same loopback origins. Browsers on other sites therefore cannot drive the gateway.
 */
class RequestGuard {
    ctx;
    hosts;
    origins;
    constructor(ctx, port) {
        this.ctx = ctx;
        const names = ['127.0.0.1', 'localhost', '[::1]'];
        this.hosts = new Set(names.map((name) => `${name}:${port}`));
        if (port === 80)
            names.forEach((name) => this.hosts.add(name));
        this.origins = new Set([...this.hosts].map((host) => `http://${host}`));
    }
    /** Returns a reason to refuse the request, or null when it is acceptable. */
    check(req) {
        const host = (headerValue(req, 'host') ?? '').trim().toLowerCase();
        if (!this.hosts.has(host))
            return `Forbidden Host header: ${host || '(none)'}`;
        const origin = headerValue(req, 'origin');
        if (origin !== undefined && !this.origins.has(origin.trim().toLowerCase()))
            return `Forbidden Origin header: ${origin}`;
        // Browsers label requests made by other sites (including other localhost ports) - never serve those.
        const site = headerValue(req, 'sec-fetch-site');
        const path = req.url ?? '/';
        if ((site === 'cross-site' || site === 'same-site') && (path.startsWith('/api') || path.startsWith('/mcp'))) {
            return `Forbidden cross-site request (Sec-Fetch-Site: ${site})`;
        }
        return null;
    }
    /** Whether the request carries the configured token (always true when no token is configured). */
    authorized(req, allowCookie) {
        const token = this.ctx.config.token;
        if (!token)
            return true;
        const auth = headerValue(req, 'authorization');
        const bearer = auth ? /^Bearer\s+(\S+)\s*$/i.exec(auth)?.[1] : undefined;
        if (bearer && secretEquals(token, bearer))
            return true;
        return allowCookie && secretEquals(token, parseCookies(headerValue(req, 'cookie')).get(TOKEN_COOKIE));
    }
    rejectMcp(res) {
        sendJsonRpcError(res, 401, -32000, 'Unauthorized: this Bruce Comm gateway requires "Authorization: Bearer <token>".', {
            'WWW-Authenticate': 'Bearer realm="bruce-comm"',
        });
    }
    rejectApi(req, res, baseUrl) {
        req.resume();
        sendError(res, 401, 'unauthorized', 'This Bruce Comm gateway requires a token.', `Send "Authorization: Bearer <token>", or open ${baseUrl}/?token=<token> once in your browser.`, { 'WWW-Authenticate': 'Bearer realm="bruce-comm"' });
    }
    /** Dashboard page. `/?token=` exchanges the token for an HttpOnly cookie, then redirects to a clean URL. */
    servePage(req, res, url) {
        if (req.method !== 'GET' && req.method !== 'HEAD')
            return methodNotAllowed(req, res, 'GET, HEAD');
        const given = url.searchParams.get('token');
        if (given !== null) {
            const token = this.ctx.config.token;
            if (!token)
                return redirect(res, '/');
            if (!secretEquals(token, given))
                return redirect(res, '/?login=failed');
            const cookie = `${TOKEN_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${TOKEN_COOKIE_MAX_AGE_S}`;
            return redirect(res, '/', { 'Set-Cookie': cookie });
        }
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Content-Length': String(Buffer.byteLength(DASHBOARD_HTML)),
            'Content-Security-Policy': DASHBOARD_CSP,
            'Cache-Control': 'no-store',
            'X-Frame-Options': 'DENY',
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Resource-Policy': 'same-origin',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
        });
        res.end(DASHBOARD_HTML);
    }
}
function serveHealth(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
        return methodNotAllowed(req, res, 'GET, HEAD');
    sendJson(res, 200, { ok: true, name: SERVER_NAME, version: SERVER_VERSION });
}
function serveFavicon(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD')
        return methodNotAllowed(req, res, 'GET, HEAD');
    res.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Content-Length': String(Buffer.byteLength(FAVICON_SVG)),
        'Cache-Control': 'public, max-age=86400',
    });
    res.end(FAVICON_SVG);
}
function methodNotAllowed(req, res, allow) {
    req.resume();
    sendError(res, 405, 'method_not_allowed', `${req.method} is not supported here.`, `Allowed: ${allow}.`, { Allow: allow });
}
function redirect(res, location, headers = {}) {
    res.writeHead(303, { Location: location, 'Cache-Control': 'no-store', 'Content-Length': '0', ...headers });
    res.end();
}
/**
 * Stateful Streamable HTTP sessions: one McpServer + transport per `mcp-session-id`.
 * Sessions end on HTTP DELETE, on transport close, after `idleMs` without traffic (clients that
 * vanish never send DELETE), and when the daemon shuts down.
 */
class McpSessionManager {
    ctx;
    idleMs;
    sessions = new Map();
    reaper = null;
    closed = false;
    constructor(ctx, idleMs) {
        this.ctx = ctx;
        this.idleMs = idleMs;
    }
    get size() {
        return this.sessions.size;
    }
    start(reapIntervalMs) {
        this.reaper = setInterval(() => this.reap(), reapIntervalMs);
        this.reaper.unref();
    }
    /** Serve POST / GET / DELETE on /mcp. */
    async handle(req, res, url) {
        const sid = headerValue(req, 'mcp-session-id');
        if (sid !== undefined)
            return this.handleExisting(sid, req, res);
        if (req.method !== 'POST') {
            req.resume();
            return sendJsonRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
        }
        const body = await this.readMessage(req, res);
        if (body === NO_BODY)
            return;
        if (!isInitializeRequest(body)) {
            return sendJsonRpcError(res, 400, -32000, 'Bad Request: no valid session ID and not an initialize request');
        }
        return this.create(req, res, url, body);
    }
    async handleExisting(sid, req, res) {
        const session = this.sessions.get(sid);
        if (!session || session.closing) {
            req.resume();
            return sendJsonRpcError(res, 404, -32001, 'Session not found');
        }
        this.track(session, res);
        let body;
        if (req.method === 'POST') {
            body = await this.readMessage(req, res, true);
            if (body === NO_BODY)
                return;
            this.cancelOnDisconnect(session, res, body);
        }
        await session.transport.handleRequest(req, res, body);
    }
    /**
     * The SDK does not abort a request handler when the HTTP response carrying its answer is dropped (client crashed,
     * exited or reloaded without notifications/cancelled or DELETE): a get_next_task long-poll would live on, claim the
     * next task and take messages for nobody. When the response closes before it finished, cancel every JSON-RPC request
     * of that POST as if the client had sent notifications/cancelled, so the handlers' signals abort.
     */
    cancelOnDisconnect(session, res, body) {
        const ids = (Array.isArray(body) ? body : [body])
            .filter((m) => isRecord(m) && typeof m.method === 'string' && (typeof m.id === 'string' || typeof m.id === 'number'))
            .map((m) => m.id);
        if (!ids.length)
            return;
        res.once('close', () => {
            if (res.writableFinished || session.closing)
                return;
            for (const requestId of ids) {
                session.transport.onmessage?.({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId, reason: 'client disconnected' } });
            }
        });
    }
    async create(req, res, url, body) {
        if (this.closed)
            return sendJsonRpcError(res, 503, -32000, 'Server is shutting down');
        if (this.sessions.size >= MAX_MCP_SESSIONS) {
            return sendJsonRpcError(res, 503, -32000, `Too many MCP sessions (max ${MAX_MCP_SESSIONS}); idle ones are closed after a while.`);
        }
        let agentId;
        let runnerTask;
        try {
            agentId = preboundAgent(req, url);
        }
        catch (err) {
            const message = err instanceof BruceError ? `${err.message}${err.hint ? ` ${err.hint}` : ''}` : describe(err);
            return sendJsonRpcError(res, 400, -32602, `Invalid agent identity in ?agent= / X-Bruce-Agent: ${message}`);
        }
        try {
            // `?runner_task=<task id>`: a one-shot session the runner started for that task (see SessionState.runnerTask).
            runnerTask = normalizeRunnerTask(url.searchParams.get('runner_task'));
        }
        catch (err) {
            return sendJsonRpcError(res, 400, -32602, `Invalid ?runner_task=: ${describe(err)}`);
        }
        const state = { transport: 'http', agentId, preBound: agentId !== undefined, runnerTask };
        let session;
        let closeReason = 'transport closed';
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            onsessioninitialized: (id) => {
                state.sessionId = id;
                session = { id, transport, server, state, lastSeen: Date.now(), inflight: 0, closing: false };
                this.sessions.set(id, session);
                this.track(session, res);
            },
            onsessionclosed: () => {
                closeReason = 'ended by client';
            },
            // enableJsonResponse stays false: JSON mode silently drops long-poll progress notifications.
        });
        // Set BEFORE connect(): Protocol.connect() chains a pre-existing onclose / onerror.
        transport.onclose = () => {
            if (session && this.sessions.get(session.id) === session) {
                this.sessions.delete(session.id);
                this.ctx.log(`MCP session ${short(session.id)} closed (${closeReason}; ${this.sessions.size} live)`);
            }
        };
        transport.onerror = (err) => this.ctx.log(`MCP transport: ${describe(err)}`);
        let server;
        try {
            server = createBruceServer(this.ctx, state);
            await server.connect(transport);
        }
        catch (err) {
            this.ctx.log(`could not create MCP session: ${describe(err)}`);
            return sendJsonRpcError(res, 500, -32603, 'Internal error: could not create an MCP session (see the daemon log).');
        }
        await transport.handleRequest(req, res, body);
        if (!session) {
            // Initialization was refused by the transport (e.g. wrong Accept header): release everything.
            await server.close().catch(() => { });
            return;
        }
        const client = server.server.getClientVersion();
        this.ctx.log(`MCP session ${short(session.id)} opened by ${client ? `${client.name} ${client.version}` : 'unknown client'}` +
            `${agentId ? ` as "${agentId}"` : ''} (${this.sessions.size} live)`);
    }
    /**
     * Read and parse a JSON-RPC POST body (1 MB limit). On failure the error response has already
     * been sent and NO_BODY is returned. Non-JSON content types are left for the transport to
     * refuse (415) when `passThrough` is set.
     */
    async readMessage(req, res, passThrough = false) {
        let raw;
        try {
            raw = await readBody(req);
        }
        catch (err) {
            if (err instanceof HttpError && err.status === 413) {
                sendJsonRpcError(res, 413, -32000, err.message);
            }
            else {
                sendJsonRpcError(res, 400, -32700, 'Parse error: could not read request body');
            }
            return NO_BODY;
        }
        if (!isJsonContentType(headerValue(req, 'content-type'))) {
            if (passThrough)
                return undefined;
            sendJsonRpcError(res, 415, -32000, 'Unsupported Media Type: Content-Type must be application/json');
            return NO_BODY;
        }
        try {
            return JSON.parse(raw.toString('utf8'));
        }
        catch {
            sendJsonRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
            return NO_BODY;
        }
    }
    /** Count a request against the session until its response closes (keeps the reaper away). */
    track(session, res) {
        session.inflight++;
        session.lastSeen = Date.now();
        res.once('close', () => {
            session.inflight = Math.max(0, session.inflight - 1);
            session.lastSeen = Date.now();
        });
    }
    /** Close sessions with no traffic for idleMs and nothing in flight. */
    reap(now = Date.now()) {
        for (const session of [...this.sessions.values()]) {
            if (session.inflight === 0 && now - session.lastSeen >= this.idleMs) {
                void this.closeSession(session, 'idle');
            }
        }
    }
    /** End the MCP connection whose Bruce session row is `bruceSessionId`, if this daemon hosts it. */
    async disconnect(bruceSessionId) {
        const target = bruceSessionId.trim().toUpperCase();
        const session = [...this.sessions.values()].find((s) => bruceSessionIdOf(s.state)?.toUpperCase() === target);
        if (!session)
            return false;
        await this.closeSession(session, 'closed from the dashboard');
        return true;
    }
    async closeAll() {
        this.closed = true;
        if (this.reaper)
            clearInterval(this.reaper);
        this.reaper = null;
        await Promise.all([...this.sessions.values()].map((session) => this.closeSession(session, 'shutdown')));
    }
    async closeSession(session, reason) {
        if (session.closing)
            return;
        session.closing = true;
        if (this.sessions.get(session.id) === session) {
            this.sessions.delete(session.id);
            this.ctx.log(`MCP session ${short(session.id)} closed (${reason}; ${this.sessions.size} live)`);
        }
        // McpServer.close() closes the transport too; closing the transport again is a harmless no-op.
        await session.server.close().catch(() => { });
        await session.transport.close().catch(() => { });
    }
}
/** The store session row id the MCP layer records on the session state (see SPEC-SESSIONS), if any. */
function bruceSessionIdOf(state) {
    const value = state.bruceSessionId;
    return typeof value === 'string' ? value : undefined;
}
/** Sentinel: the request was already answered with an error. */
const NO_BODY = Symbol('no-body');
/** Identity pre-bound by the client config: `/mcp?agent=<id>` or `X-Bruce-Agent: <id>`. */
function preboundAgent(req, url) {
    const raw = url.searchParams.get('agent') ?? headerValue(req, 'x-bruce-agent');
    if (raw === undefined || raw === null || raw.trim() === '')
        return undefined;
    return normalizeAgentId(raw);
}
// ---------------------------------------------------------------- helpers
function listen(server, host, port) {
    return new Promise((resolve, reject) => {
        const onError = (err) => {
            server.off('listening', onListening);
            if (err.code === 'EADDRINUSE') {
                reject(new BruceError('port_in_use', `Port ${port} on ${host} is already in use.`, `Another Bruce Comm daemon may already be running (check http://${urlHost(host)}:${port}/healthz), ` +
                    'or choose another port with --port / BRUCE_COMM_PORT.'));
            }
            else {
                reject(err);
            }
        };
        const onListening = () => {
            server.off('error', onError);
            resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port, host, exclusive: true });
    });
}
function closeServer(server) {
    return new Promise((resolve) => {
        if (!server.listening)
            return resolve();
        server.close(() => resolve());
        server.closeIdleConnections();
        // Anything still open (a response mid-flight) gets a short grace period, then is cut.
        setTimeout(() => server.closeAllConnections(), 1000).unref();
    });
}
function urlHost(host) {
    return host.includes(':') ? `[${host}]` : host;
}
function short(sessionId) {
    return sessionId.slice(0, 8);
}
function isRecord(value) {
    return value !== null && typeof value === 'object';
}
function describe(err) {
    return err instanceof Error ? err.message : String(err);
}
//# sourceMappingURL=http.js.map