import { z } from 'zod';
import { clientOf, sessionRow, truncate } from '../format.js';
/** Register list_sessions. */
export function registerSessionTools(server, runtime) {
    registerListSessions(server, runtime);
}
// ---------------------------------------------------------------- list_sessions
function registerListSessions(server, runtime) {
    server.registerTool('list_sessions', {
        title: 'List open sessions (windows)',
        description: 'List the live sessions (IDE windows / app instances) of agents. Use a session id with send_task(to_session) to reach one ' +
            'specific window, or send_task(to_workspace) to reach whichever window has that repo open. Each row: session id, agent, client ' +
            '(name + version), transport, label, workspaces, connected / listening, started, last active; this_is_you marks your own session.',
        inputSchema: {
            agent_id: z
                .string()
                .optional()
                .describe('Only the sessions of this agent (the agent to look up - not necessarily you). Omit to list every agent\'s sessions.'),
            include_closed: z.boolean().default(false).describe('Also list recently closed sessions with their close reason (default false).'),
        },
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    }, async (args, extra) => runtime.run(extra, (call) => {
        const store = runtime.ctx.store;
        // Identity comes from the session binding (agent_id here is a filter); it only feeds the _bruce footer.
        call.optionalCaller(undefined);
        const filterId = args.agent_id?.trim().toLowerCase() || undefined;
        const sessions = sortSessions(store.listSessions({ agent_id: filterId, include_closed: args.include_closed, limit: 200 }));
        const you = call.sessionId;
        const live = sessions.filter((s) => s.connected);
        const agents = new Set(live.map((s) => s.agent_id ?? '?'));
        const scope = filterId ? ` of "${filterId}"` : agents.size ? ` of ${agents.size} agent(s)` : '';
        const closed = sessions.length - live.length;
        const headline = sessions.length
            ? `${live.length} live session(s)${scope}${closed ? ` and ${closed} closed` : ''}. Target one window with send_task(to_agent=..., to_session="<id>") or to_workspace="<folder or label>".`
            : filterId && !store.getAgent(filterId)
                ? `No agent registered with id "${filterId}" and no session uses that id. Use list_agents to see registered agents.`
                : `No live sessions${filterId ? ` for "${filterId}"` : ''}. Tasks sent with to_agent still wait in the queue until the agent connects.`;
        return {
            headline,
            payload: {
                count: sessions.length,
                sessions: sessions.map((s) => sessionRow(s, { youId: you })),
                your_session: you,
                by_agent: filterId ? undefined : summarizeByAgent(live),
            },
        };
    }));
}
/** Live sessions first, then by agent, newest first within an agent. */
function sortSessions(sessions) {
    return [...sessions].sort((a, b) => Number(b.connected) - Number(a.connected) ||
        (a.agent_id ?? '~').localeCompare(b.agent_id ?? '~') ||
        b.started_at - a.started_at);
}
/** "agent-b": ["S-1 Visual Studio Code \"frontend\"", ...] - a compact overview for agents with several windows. */
function summarizeByAgent(sessions) {
    const out = {};
    for (const s of sessions) {
        const key = s.agent_id ?? '(not identified yet)';
        (out[key] ??= []).push(`${s.id} ${clientOf(s)}${s.label ? ` "${truncate(s.label, 60)}"` : ''}${s.workspaces.length ? ` [${s.workspaces.slice(0, 3).join(', ')}]` : ''}`);
    }
    return Object.keys(out).length ? out : undefined;
}
//# sourceMappingURL=sessions.js.map