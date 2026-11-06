import { createHash } from 'node:crypto';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ErrorCode, McpError, SubscribeRequestSchema, UnsubscribeRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { compact, agentMarkdown, agentSummary, routeOf, sessionRow, taskJson, taskRow, truncate } from './format.js';
import { GUIDE_MARKDOWN } from './instructions.js';
const MARKDOWN = 'text/markdown';
const JSON_MIME = 'application/json';
/** Coalesce bursts of queue changes before re-rendering subscribed resources. */
const UPDATE_DEBOUNCE_MS = 150;
/** Coalesce agent registrations / removals before telling the client the resource list changed. */
const LIST_CHANGED_DEBOUNCE_MS = 1_000;
const RECENT_TASKS = 50;
function variable(value) {
    const raw = Array.isArray(value) ? (value[0] ?? '') : (value ?? '');
    try {
        return decodeURIComponent(raw);
    }
    catch {
        return raw;
    }
}
function json(value) {
    return { mimeType: JSON_MIME, text: JSON.stringify(compact(value), null, 2) };
}
/** Whether `uri` names one of Bruce Comm's resources (it may not exist yet). */
function isBruceUri(uri) {
    return /^bruce:\/\/(guide|agents|sessions|agents\/[^/]+|tasks\/[^/]+|inbox\/[^/]+)$/.test(uri);
}
/** Render a Bruce Comm resource by URI, or null when it does not exist. */
export function renderResource(ctx, uri) {
    const store = ctx.store;
    if (uri === 'bruce://guide')
        return { mimeType: MARKDOWN, text: GUIDE_MARKDOWN };
    if (uri === 'bruce://agents') {
        const agents = store.listAgents();
        // Volatile last-seen timestamps are left out so subscribers only hear about meaningful changes.
        return json({ count: agents.length, agents: agents.map((a) => agentSummary(store, a, undefined, { volatile: false })) });
    }
    if (uri === 'bruce://sessions') {
        const sessions = store.listSessions({ limit: 500 });
        // Heartbeat / last-active timestamps are left out so subscribers only hear about opened, closed or changed sessions.
        return json({ count: sessions.length, sessions: sessions.map((s) => sessionRow(s, { volatile: false })) });
    }
    const match = /^bruce:\/\/(agents|tasks|inbox)\/([^/]+)$/.exec(uri);
    if (!match)
        return null;
    const id = variable(match[2]);
    if (match[1] === 'agents') {
        const agent = store.getAgent(id);
        return agent ? { mimeType: MARKDOWN, text: agentMarkdown(store, agent) } : null;
    }
    if (match[1] === 'tasks') {
        const task = store.getTask(id);
        return task ? json(taskJson(task, store.getEvents(task.id))) : null;
    }
    const agent = store.getAgent(id);
    if (!agent)
        return null;
    const now = Date.now();
    const claimable = store
        .listTasks({ inbox_of: agent.id, status: 'queued', limit: 100 })
        .filter((t) => (t.not_before == null || t.not_before <= now) && (t.assignee == null || t.assignee === agent.id));
    const working = store.listTasks({ assignee: agent.id, status: ['working', 'input_required'], limit: 100 });
    return json({
        agent_id: agent.id,
        counts: store.pendingCounts(agent.id),
        claimable: claimable.map((t) => taskRow(t)),
        working: working.map((t) => taskRow(t)),
    });
}
function readOrThrow(ctx, uri) {
    const rendered = renderResource(ctx, uri.href);
    if (!rendered)
        throw new McpError(ErrorCode.InvalidParams, `Resource ${uri.href} not found`);
    return { contents: [{ uri: uri.href, mimeType: rendered.mimeType, text: rendered.text }] };
}
function hashOf(rendered) {
    return rendered ? createHash('sha1').update(rendered.mimeType).update('\0').update(rendered.text).digest('hex') : 'absent';
}
/**
 * ONE listener per context for notifications/resources/list_changed: on queue changes it computes the set of agent
 * ids once (not once per session) and tells every member session when it changed. Subscribed to the notifier only
 * while at least one initialized session is a member.
 */
class AgentSetWatch {
    ctx;
    members = new Set();
    unsubscribeNotifier;
    timer;
    agentSet = '';
    constructor(ctx) {
        this.ctx = ctx;
    }
    add(member) {
        this.members.add(member);
        if (this.unsubscribeNotifier)
            return;
        this.agentSet = this.currentAgentSet() ?? '';
        this.unsubscribeNotifier = this.ctx.notifier.subscribe(() => this.schedule());
    }
    remove(member) {
        this.members.delete(member);
        if (this.members.size)
            return;
        this.unsubscribeNotifier?.();
        this.unsubscribeNotifier = undefined;
        if (this.timer)
            clearTimeout(this.timer);
        this.timer = undefined;
    }
    schedule() {
        if (this.timer || !this.unsubscribeNotifier)
            return;
        this.timer = setTimeout(() => {
            this.timer = undefined;
            this.flush();
        }, UPDATE_DEBOUNCE_MS);
        this.timer.unref();
    }
    flush() {
        const agentSet = this.currentAgentSet();
        if (agentSet === undefined || agentSet === this.agentSet)
            return;
        this.agentSet = agentSet;
        for (const member of [...this.members])
            member.agentSetChanged();
    }
    currentAgentSet() {
        try {
            return this.ctx.store
                .listAgents()
                .map((a) => a.id)
                .join('\n');
        }
        catch {
            return undefined;
        }
    }
}
const agentSetWatches = new WeakMap();
function agentSetWatch(ctx) {
    let watch = agentSetWatches.get(ctx);
    if (!watch)
        agentSetWatches.set(ctx, (watch = new AgentSetWatch(ctx)));
    return watch;
}
/**
 * Per-session watcher. While the client has resources/subscribe'd something, it re-renders those resources when the
 * queue changes and sends notifications/resources/updated only when the content actually changed (sessions without
 * subscriptions cost nothing per change). Once initialized, the session also gets a debounced
 * notifications/resources/list_changed when the set of agents changes (computed once per context, see AgentSetWatch).
 */
export class ResourceWatcher {
    server;
    ctx;
    subscribed = new Map();
    unsubscribeNotifier;
    updateTimer;
    listTimer;
    started = false;
    closed = false;
    constructor(server, ctx) {
        this.server = server;
        this.ctx = ctx;
    }
    /** The session finished initializing: start hearing about agent-set changes (idempotent). */
    start() {
        if (this.closed || this.started)
            return;
        this.started = true;
        agentSetWatch(this.ctx).add(this);
    }
    subscribe(uri) {
        if (!isBruceUri(uri))
            throw new McpError(ErrorCode.InvalidParams, `Unknown resource ${uri}; Bruce Comm resources start with bruce://`);
        if (this.closed)
            return;
        this.subscribed.set(uri, hashOf(this.safeRender(uri)));
        this.unsubscribeNotifier ??= this.ctx.notifier.subscribe(() => this.schedule());
    }
    unsubscribe(uri) {
        this.subscribed.delete(uri);
        if (this.subscribed.size)
            return;
        this.unsubscribeNotifier?.();
        this.unsubscribeNotifier = undefined;
    }
    /** Stop everything (session closed). */
    close() {
        this.closed = true;
        if (this.started)
            agentSetWatch(this.ctx).remove(this);
        this.unsubscribeNotifier?.();
        this.unsubscribeNotifier = undefined;
        if (this.updateTimer)
            clearTimeout(this.updateTimer);
        if (this.listTimer)
            clearTimeout(this.listTimer);
        this.updateTimer = this.listTimer = undefined;
        this.subscribed.clear();
    }
    /** Called by AgentSetWatch: an agent was registered or removed. */
    agentSetChanged() {
        // Covers transports whose owner replaced server.onclose: a disconnected session cleans up by itself.
        if (this.closed || !this.server.isConnected())
            return this.close();
        if (this.listTimer)
            return;
        this.listTimer = setTimeout(() => {
            this.listTimer = undefined;
            if (!this.closed && this.server.isConnected())
                this.server.sendResourceListChanged();
        }, LIST_CHANGED_DEBOUNCE_MS);
        this.listTimer.unref();
    }
    schedule() {
        if (this.updateTimer || this.closed)
            return;
        this.updateTimer = setTimeout(() => {
            this.updateTimer = undefined;
            this.flush();
        }, UPDATE_DEBOUNCE_MS);
        this.updateTimer.unref();
    }
    flush() {
        if (this.closed || !this.server.isConnected())
            return this.close();
        for (const [uri, previous] of this.subscribed) {
            const hash = hashOf(this.safeRender(uri));
            if (hash === previous)
                continue;
            this.subscribed.set(uri, hash);
            this.server.server.sendResourceUpdated({ uri }).catch((err) => {
                this.ctx.log(`resources/updated for ${uri} failed: ${err.message}`);
            });
        }
    }
    safeRender(uri) {
        try {
            return renderResource(this.ctx, uri);
        }
        catch {
            return null;
        }
    }
}
/** Register resources, resource templates and the subscribe / unsubscribe handlers. */
export function registerResources(server, ctx, session) {
    const store = ctx.store;
    const agentIds = (prefix) => store
        .listAgents()
        .map((a) => a.id)
        .filter((id) => id.startsWith(prefix.toLowerCase()))
        .slice(0, 100);
    server.registerResource('guide', 'bruce://guide', { title: 'Bruce Comm guide', description: 'How agents use Bruce Comm: identity, delegating, the worker loop, safety rules.', mimeType: MARKDOWN }, async (uri) => readOrThrow(ctx, uri));
    server.registerResource('agents', 'bruce://agents', { title: 'Agent directory', description: 'All registered agents with skills, presence and status.', mimeType: JSON_MIME }, async (uri) => readOrThrow(ctx, uri));
    server.registerResource('sessions', 'bruce://sessions', {
        title: 'Live sessions',
        description: 'Every open session (IDE window / app instance) of every agent: client, label, workspaces, listening. Target one with send_task(to_session / to_workspace).',
        mimeType: JSON_MIME,
    }, async (uri) => readOrThrow(ctx, uri));
    server.registerResource('agent', new ResourceTemplate('bruce://agents/{agent_id}', {
        list: async () => ({
            resources: store.listAgents().map((a) => ({
                uri: `bruce://agents/${encodeURIComponent(a.id)}`,
                name: `agent ${a.id}`,
                title: `${a.name} (${a.platform})`,
                description: truncate(a.description || `Agent card of ${a.id}`, 200),
                mimeType: MARKDOWN,
            })),
        }),
        complete: { agent_id: (value) => agentIds(value) },
    }), { title: 'Agent card', description: "One agent's card, including the instructions other agents must follow.", mimeType: MARKDOWN }, async (uri) => readOrThrow(ctx, uri));
    server.registerResource('task', new ResourceTemplate('bruce://tasks/{task_id}', {
        list: async () => ({
            resources: store.listTasks({ limit: RECENT_TASKS }).map((t) => ({
                uri: `bruce://tasks/${t.id}`,
                name: `${t.kind} ${t.id}`,
                title: truncate(`${t.id}: ${t.title}`, 120),
                description: `${t.from_agent} -> ${routeOf(t)}, ${t.status}`,
                mimeType: JSON_MIME,
            })),
        }),
        complete: {
            task_id: (value) => store
                .listTasks({ limit: RECENT_TASKS })
                .map((t) => t.id)
                .filter((id) => id.startsWith(value.toUpperCase())),
        },
    }), { title: 'Task', description: 'A task or message with its full event history.', mimeType: JSON_MIME }, async (uri) => readOrThrow(ctx, uri));
    server.registerResource('inbox', new ResourceTemplate('bruce://inbox/{agent_id}', {
        list: async () => {
            const me = session.agentId ? store.getAgent(session.agentId) : undefined;
            return {
                resources: me
                    ? [{ uri: `bruce://inbox/${encodeURIComponent(me.id)}`, name: `inbox ${me.id}`, title: `My inbox (${me.id})`, mimeType: JSON_MIME }]
                    : [],
            };
        },
        complete: { agent_id: (value) => agentIds(value) },
    }), { title: 'Agent inbox', description: 'What an agent could claim right now and the tasks it is working on.', mimeType: JSON_MIME }, async (uri) => readOrThrow(ctx, uri));
    const watcher = new ResourceWatcher(server, ctx);
    server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
        watcher.subscribe(request.params.uri);
        return {};
    });
    server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
        watcher.unsubscribe(request.params.uri);
        return {};
    });
    return watcher;
}
//# sourceMappingURL=resources.js.map