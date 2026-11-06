import { BruceError } from '../util.js';
import { compact, escapeUntrusted } from './format.js';
import { optionalCaller, requireCaller, claimedIdentity } from './identity.js';
import { waitCapFor } from './instructions.js';
/** How often a long-poll sends notifications/progress when the client gave a progressToken. */
export const PROGRESS_INTERVAL_MS = 10_000;
/** Long-polls re-check at least this often (delayed tasks becoming due, expired leases). */
const RECHECK_MS = 3_000;
/** Per-call helper handed to tool bodies: identity resolution, session binding and long-polling. */
export class ToolCall {
    ctx;
    session;
    extra;
    link;
    footerId;
    binding;
    constructor(ctx, session, extra, 
    /** The store session of this MCP connection. */
    link) {
        this.ctx = ctx;
        this.session = session;
        this.extra = extra;
        this.link = link;
    }
    /** This connection's Bruce Comm session id ("S-..."), when recorded. */
    get sessionId() {
        return this.link.id;
    }
    /** The calling agent (from `agent_id` or the session). Throws `not_registered` with a recovery hint. */
    requireCaller(argId) {
        this.footerId = claimedIdentity(this.session, argId)?.id;
        const caller = requireCaller(this.ctx, this.session, argId);
        this.adopt(caller);
        return caller;
    }
    /**
     * An explicit agent_id binds the session once the call succeeds - unless the session's identity was pre-bound by
     * the client configuration and the call names someone else: then that agent acts for this call only (e.g. a VS Code
     * window completing a task its runner agent claimed) and the footer keeps describing the window's own agent.
     * "Someone else" is anyone but the current binding - or, for a window left unbound (it unregistered the agent it was
     * bound to), anyone but its configured agent: only register_agent re-binds a pre-bound window to another agent.
     */
    adopt(caller) {
        this.footerId = caller.id;
        if (!caller.explicit)
            return;
        const bound = this.session.agentId;
        if (this.session.preBound && caller.id !== (bound ?? this.session.configuredAgentId)) {
            if (bound)
                this.footerId = bound;
            return;
        }
        this.binding = { id: caller.id };
    }
    /**
     * The calling agent when known and registered, otherwise undefined. An explicit `agent_id` that is
     * not registered is an error (the caller claimed an identity) unless `lenient` is set - for tools that
     * are useful before registering (bruce_status, list_agents).
     */
    optionalCaller(argId, options = {}) {
        const claim = claimedIdentity(this.session, argId);
        if (claim?.explicit && !options.lenient)
            return this.requireCaller(argId);
        this.footerId = claim?.id;
        const caller = optionalCaller(this.ctx, this.session, argId);
        if (caller)
            this.adopt(caller);
        return caller;
    }
    /**
     * Bind the session to `id` once the call succeeds (register_agent, after the profile was saved). The store session
     * is re-bound right away - forced, since an unregister elsewhere may have cleared it - so the reply already counts
     * this window among the agent's connected sessions.
     */
    bind(id) {
        this.binding = { id };
        this.footerId = id;
        this.link.bindAgent(id, true);
    }
    /** Remove the session binding once the call succeeds (unregister_agent). */
    unbind(id) {
        if (this.session.agentId === id)
            this.binding = { id: null };
        if (this.footerId === id)
            this.footerId = undefined;
    }
    /** Identity used for the `_bruce` attention footer. */
    get attentionId() {
        return this.footerId;
    }
    /** Apply the pending session binding (called after the tool body succeeded) and mirror it into the store session. */
    commit() {
        if (!this.binding)
            return;
        const previous = this.session.agentId;
        this.session.agentId = this.binding.id ?? undefined;
        if (previous !== this.session.agentId) {
            const name = this.link.id ?? this.session.sessionId ?? `(${this.session.transport})`;
            this.ctx.log(`session ${name} bound to ${this.session.agentId ?? '(nobody)'}`);
        }
        this.link.bindAgent(this.session.agentId ?? null);
    }
    /** Whether the client asked for progress notifications on this request. */
    get hasProgressToken() {
        return this.extra._meta?.progressToken !== undefined;
    }
    /** The wait cap for this request and the rule that produced it (client, progress token, env override). */
    get waitCap() {
        return waitCapFor(this.link.clientName, this.hasProgressToken);
    }
    /** Longest wait this request may block. */
    get maxWaitSeconds() {
        return this.waitCap.seconds;
    }
    /**
     * Run `attempt` now; if it yields nothing and `requestedSeconds` > 0, block until it does, the wait
     * limit passes or the client cancels. Wakes instantly on queue changes (and within ~400 ms on changes
     * by other processes). Sends notifications/progress every ~10 s when the client gave a progressToken.
     */
    async longPoll(requestedSeconds, attempt, options) {
        const requested = Number.isFinite(requestedSeconds) ? Math.max(0, Number(requestedSeconds)) : 0;
        const max = this.maxWaitSeconds;
        const limit = Math.min(requested, max);
        const capped = requested > max;
        const signal = this.extra.signal;
        // Canceled before we started (e.g. the cancel arrived with the request): take nothing for a reply nobody reads.
        if (signal.aborted)
            return { value: null, waitedSeconds: 0, limitSeconds: limit, capped, aborted: true };
        const first = attempt();
        if (first !== null || limit <= 0 || signal.aborted) {
            return { value: first, waitedSeconds: 0, limitSeconds: limit, capped, aborted: signal.aborted };
        }
        const started = Date.now();
        const stopProgress = this.startProgress(started, limit, options.label);
        try {
            options.onWaitStart?.(limit);
            const value = await this.ctx.notifier.pollUntil(attempt, { timeoutMs: limit * 1000, signal, recheckMs: RECHECK_MS });
            return { value, waitedSeconds: Math.round((Date.now() - started) / 100) / 10, limitSeconds: limit, capped, aborted: signal.aborted };
        }
        finally {
            stopProgress();
            try {
                options.onWaitEnd?.();
            }
            catch (err) {
                this.ctx.log(`long-poll cleanup failed: ${err.message}`);
            }
        }
    }
    /** Send progress now and every PROGRESS_INTERVAL_MS; returns a stop function. No-op without a progressToken. */
    startProgress(started, limitSeconds, label) {
        const progressToken = this.extra._meta?.progressToken;
        if (progressToken === undefined)
            return () => { };
        let last = -1;
        const send = () => {
            if (this.extra.signal.aborted)
                return;
            let elapsed = Math.round((Date.now() - started) / 1000);
            if (elapsed <= last)
                elapsed = last + 1; // progress must strictly increase
            last = elapsed;
            this.extra
                .sendNotification({
                method: 'notifications/progress',
                params: { progressToken, progress: elapsed, total: limitSeconds, message: `${label}… ${elapsed}s of ${limitSeconds}s` },
            })
                .catch(() => {
                // the client may have gone away; the long-poll ends via the abort signal
            });
        };
        send();
        const timer = setInterval(send, PROGRESS_INTERVAL_MS);
        timer.unref();
        return () => clearInterval(timer);
    }
}
/** Builds tool results: never throws, formats errors, attaches the `_bruce` attention footer. */
export class ToolRuntime {
    ctx;
    session;
    link;
    constructor(ctx, session, 
    /** The store session of this MCP connection (touched on every call). */
    link) {
        this.ctx = ctx;
        this.session = session;
        this.link = link;
    }
    /** Execute a tool body and convert its outcome (or any error) into a CallToolResult. */
    async run(extra, body) {
        const call = new ToolCall(this.ctx, this.session, extra, this.link);
        this.link.touch(extra);
        try {
            const reply = await body(call);
            call.commit();
            return this.success(reply, call.attentionId);
        }
        catch (err) {
            return errorResult(err, this.ctx.log);
        }
    }
    success(reply, attentionId) {
        const payload = { ...(reply.payload ?? {}) };
        let nudge = null;
        if (attentionId) {
            const attention = this.attention(attentionId, !this.session.runnerTask);
            payload._bruce = attention.footer;
            nudge = attention.nudge;
        }
        const parts = [reply.headline.trim()];
        for (const block of reply.blocks ?? [])
            parts.push(block);
        const json = compact(payload);
        // Payloads carry agent-written strings too (task titles, result previews, session labels, profiles): neutralise
        // wrapper look-alikes there as well, so nothing outside the real <bruce_task> block can fake one. Our own payload
        // text never contains "<bruce", and the JSON stays valid.
        if (Object.keys(json).length)
            parts.push(escapeUntrusted(JSON.stringify(json, null, 2)));
        if (nudge)
            parts.push(nudge);
        return {
            content: [
                { type: 'text', text: parts.join('\n') },
                ...(reply.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mimeType })),
            ],
        };
    }
    /**
     * Attention counters for the footer (scoped to this session); tolerant of agents that vanished mid-call. A one-shot
     * runner session (`worker` false) is never told to fetch more work.
     */
    attention(agentId, worker) {
        try {
            const counts = this.ctx.store.pendingCounts(agentId, this.link.id);
            return { footer: { you: agentId, ...counts }, nudge: nudgeLine(counts, { worker }) };
        }
        catch {
            return {
                footer: { you: agentId, registered: false },
                nudge: `You are not registered as "${agentId}" - call register_agent to receive tasks.`,
            };
        }
    }
}
/**
 * One line telling the agent what needs its attention, or null when nothing does. `worker: false` (a one-shot runner
 * session) leaves out the waiting tasks and messages: that session must not call get_next_task.
 */
export function nudgeLine(counts, options = {}) {
    const parts = [];
    if (options.worker !== false && (counts.tasks || counts.messages)) {
        const what = [counts.tasks ? `${counts.tasks} task(s)` : '', counts.messages ? `${counts.messages} message(s)` : '']
            .filter(Boolean)
            .join(' and ');
        parts.push(`You have ${what} waiting - call get_next_task.`);
    }
    if (counts.questions_for_you) {
        parts.push(`${counts.questions_for_you} task(s) you sent have a question for you - see list_tasks(status="input_required") and answer with reply_to_task.`);
    }
    if (counts.results_ready) {
        parts.push(`${counts.results_ready} result(s) ready for tasks you sent - call list_tasks or get_task to read them.`);
    }
    return parts.length ? parts.join(' ') : null;
}
/** Format any error as an MCP tool error: `Error [<code>]: <message>` + `Hint: <hint>`. */
export function errorResult(err, log) {
    let code = 'internal_error';
    let message = err instanceof Error ? err.message : String(err);
    let hint = 'This looks like a Bruce Comm problem. Retry once; if it persists, tell your user (see the bruce-comm logs).';
    if (err instanceof BruceError) {
        code = err.code;
        hint = err.hint;
    }
    else if (/database is locked|SQLITE_BUSY/i.test(message)) {
        code = 'busy';
        message = 'The Bruce Comm database is busy.';
        hint = 'Retry in a moment.';
    }
    else {
        log(`tool error: ${err instanceof Error ? (err.stack ?? err.message) : message}`);
    }
    const text = `Error [${code}]: ${message}${hint ? `\nHint: ${hint}` : ''}`;
    return { isError: true, content: [{ type: 'text', text }] };
}
//# sourceMappingURL=runtime.js.map