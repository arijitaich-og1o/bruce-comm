import { BruceError } from '../util.js';
/** The identity a call claims: its `agent_id` argument first, then the session binding. */
export function claimedIdentity(session, argId) {
    const explicit = typeof argId === 'string' ? argId.trim().toLowerCase() : '';
    if (explicit)
        return { id: explicit, explicit: true };
    if (session.agentId)
        return { id: session.agentId, explicit: false };
    return undefined;
}
/**
 * Resolve the caller or throw `not_registered` with a hint telling the agent how to fix it.
 * Touches the agent's last_seen_at.
 */
export function requireCaller(ctx, session, argId) {
    const claim = claimedIdentity(session, argId);
    if (!claim) {
        throw new BruceError('not_registered', 'You have not identified yourself to Bruce Comm in this session.', 'Call register_agent first (agent_id, name, instructions), or pass agent_id=<your id> if you registered before.');
    }
    const agent = ctx.store.getAgent(claim.id);
    if (!agent) {
        throw new BruceError('not_registered', claim.explicit
            ? `Agent "${claim.id}" is not registered.`
            : `This session was bound to agent "${claim.id}", which is no longer registered (it may have been removed from the dashboard).`, `Call register_agent with agent_id="${claim.id}" (instructions are required on first registration), then retry.`);
    }
    ctx.store.touchAgent(agent.id);
    return { id: agent.id, agent, explicit: claim.explicit };
}
/**
 * Whether this MCP session may change or remove the profile of agent `targetId`. Identity is claim-based by design, so
 * an ordinary session may; a session whose identity the client configuration pre-bound (`--agent-id`, BRUCE_AGENT_ID,
 * `?agent=`, X-Bruce-Agent) may only manage its configured agent and agents it created itself. Task operations naming
 * another agent are not affected (the vscode-chat runner flow completes its tasks from a configured window).
 */
export function mayManageProfile(session, targetId) {
    const configured = session.configuredAgentId;
    if (!session.preBound || !configured)
        return true;
    return targetId === configured || session.createdAgentIds?.has(targetId) === true;
}
/** Throw `not_allowed` unless {@link mayManageProfile}; `action` words the refusal ("change", "unregister"). */
export function assertMayManageProfile(session, targetId, action) {
    if (mayManageProfile(session, targetId))
        return;
    const configured = session.configuredAgentId;
    const what = action === 'change' ? 'change its profile' : 'unregister it';
    throw new BruceError('not_allowed', `"${targetId}" is another existing agent and this window is configured as "${configured}" - it cannot ${what}.`, `A window pre-bound by its client configuration manages only its own agent ("${configured}") and agents it created. ` +
        `Pass agent_id="${configured}" for your own profile, or pick a new agent id. "${targetId}" itself (or the human, ` +
        'in the Bruce Comm dashboard / CLI) can change it.');
}
/** Resolve the caller when known and registered; otherwise undefined (never throws for identity reasons). */
export function optionalCaller(ctx, session, argId) {
    const claim = claimedIdentity(session, argId);
    if (!claim)
        return undefined;
    const agent = ctx.store.getAgent(claim.id);
    if (!agent)
        return undefined;
    ctx.store.touchAgent(agent.id);
    return { id: agent.id, agent, explicit: claim.explicit };
}
//# sourceMappingURL=identity.js.map