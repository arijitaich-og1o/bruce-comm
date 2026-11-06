import { SERVER_NAME, SERVER_VERSION } from '../config.js';
import { sendError } from './http-util.js';
/** A slow client whose unsent backlog exceeds this is dropped instead of buffering without bound. */
const MAX_BACKLOG_BYTES = 1024 * 1024;
/**
 * Fan-out of queue changes to dashboard browsers over Server-Sent Events (`GET /api/events`).
 *
 * Subscribes to the ChangeNotifier only while at least one client is connected (the notifier's
 * cross-process `data_version` polling stops when nobody listens). Bursts of changes are
 * coalesced; a change whose task/agent ids are unknown (made by another process) is sent with
 * empty id lists, meaning "something changed - refresh".
 */
export class EventHub {
    ctx;
    startedAt;
    clients = new Set();
    heartbeatMs;
    coalesceMs;
    maxClients;
    unsubscribe = null;
    heartbeat = null;
    flushTimer = null;
    pending = null;
    closed = false;
    constructor(ctx, startedAt, options = {}) {
        this.ctx = ctx;
        this.startedAt = startedAt;
        this.heartbeatMs = options.heartbeatMs ?? 20_000;
        this.coalesceMs = options.coalesceMs ?? 150;
        this.maxClients = options.maxClients ?? 100;
    }
    /** Number of connected SSE clients. */
    get size() {
        return this.clients.size;
    }
    /** Take over `res` as an event stream until the client disconnects or the hub closes. */
    open(req, res) {
        if (this.closed)
            return sendError(res, 503, 'shutting_down', 'The gateway is shutting down.');
        if (this.clients.size >= this.maxClients) {
            return sendError(res, 503, 'too_many_streams', `Too many open event streams (max ${this.maxClients}).`, 'Close some dashboard tabs.');
        }
        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-store, no-transform',
            Connection: 'keep-alive',
            'X-Accel-Buffering': 'no',
        });
        req.socket.setNoDelay(true);
        req.socket.setKeepAlive(true);
        req.socket.setTimeout(0);
        const client = { res };
        this.clients.add(client);
        const drop = () => this.drop(client);
        res.on('close', drop);
        res.on('error', drop);
        const hello = { name: SERVER_NAME, version: SERVER_VERSION, started_at: this.startedAt, now: Date.now() };
        this.write(client, `retry: 3000\nevent: hello\ndata: ${JSON.stringify(hello)}\n\n`);
        this.start();
    }
    /** End every stream and stop listening. Idempotent. */
    close() {
        this.closed = true;
        this.stop();
        for (const client of [...this.clients]) {
            this.clients.delete(client);
            try {
                client.res.end();
            }
            catch {
                // already gone
            }
        }
    }
    start() {
        if (!this.unsubscribe)
            this.unsubscribe = this.ctx.notifier.subscribe((change) => this.onChange(change));
        if (!this.heartbeat) {
            this.heartbeat = setInterval(() => this.broadcast(`: ping ${Date.now()}\n\n`), this.heartbeatMs);
            this.heartbeat.unref();
        }
    }
    stop() {
        this.unsubscribe?.();
        this.unsubscribe = null;
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = null;
        if (this.flushTimer)
            clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.pending = null;
    }
    drop(client) {
        if (!this.clients.delete(client))
            return;
        if (this.clients.size === 0)
            this.stop();
    }
    onChange(change) {
        const pending = (this.pending ??= { taskIds: new Set(), agentIds: new Set(), unknown: false });
        if (change.taskIds.length === 0 && change.agentIds.length === 0)
            pending.unknown = true;
        for (const id of change.taskIds)
            pending.taskIds.add(id);
        for (const id of change.agentIds)
            pending.agentIds.add(id);
        if (!this.flushTimer) {
            this.flushTimer = setTimeout(() => this.flush(), this.coalesceMs);
            this.flushTimer.unref();
        }
    }
    flush() {
        this.flushTimer = null;
        const pending = this.pending;
        this.pending = null;
        if (!pending)
            return;
        // Empty lists = "unknown" (cross-process change): clients must refresh everything.
        const payload = pending.unknown
            ? { taskIds: [], agentIds: [] }
            : { taskIds: [...pending.taskIds], agentIds: [...pending.agentIds] };
        this.broadcast(`event: change\ndata: ${JSON.stringify(payload)}\n\n`);
    }
    broadcast(text) {
        for (const client of [...this.clients])
            this.write(client, text);
    }
    write(client, text) {
        const { res } = client;
        if (res.writableEnded || res.destroyed)
            return this.drop(client);
        if (res.writableLength > MAX_BACKLOG_BYTES) {
            this.drop(client);
            res.destroy();
            return;
        }
        try {
            res.write(text);
        }
        catch {
            this.drop(client);
        }
    }
}
//# sourceMappingURL=events.js.map