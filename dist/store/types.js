export const TASK_STATUSES = [
    'awaiting_approval',
    'queued',
    'working',
    'input_required',
    'completed',
    'failed',
    'canceled',
    'rejected',
    'expired',
];
export const TERMINAL_STATUSES = new Set([
    'completed',
    'failed',
    'canceled',
    'rejected',
    'expired',
]);
export const AGENT_STATUSES = ['online', 'busy', 'away', 'offline'];
/** Reserved actor ids that can never be registered by an agent. */
export const HUMAN_ID = 'human';
export const SYSTEM_ID = 'system';
export const RESERVED_IDS = new Set([HUMAN_ID, SYSTEM_ID, 'all', 'any', 'everyone', '*']);
export const LIMITS = {
    idPattern: /^[a-z0-9][a-z0-9._-]{1,63}$/,
    titleMax: 300,
    bodyMax: 100_000,
    instructionsMax: 20_000,
    resultMax: 200_000,
    noteMax: 20_000,
    jsonMax: 200_000,
    skillsMax: 50,
    defaultLeaseSeconds: 900,
    minLeaseSeconds: 30,
    maxLeaseSeconds: 24 * 3600,
    defaultMaxAttempts: 3,
    maxAttempts: 20,
    defaultPriority: 5,
    /** Agents seen within this window are "active". */
    activeWindowMs: 2 * 60_000,
    /** Agents seen within this window are "idle"; older = "offline". */
    idleWindowMs: 30 * 60_000,
    messagesPerFetch: 20,
    /** Maximum delegation depth (parent_task_id chain) - stops agents from delegating in circles forever. */
    maxDepth: 8,
    /** Maximum tasks one sender may queue for the same recipient within rateWindowMs. */
    rateLimitPerRecipient: 60,
    rateWindowMs: 5 * 60_000,
    /** Maximum unfinished tasks waiting for a single agent. */
    maxQueuedPerAgent: 1000,
    maxBroadcastRecipients: 100,
    /** Hosting processes refresh their sessions' heartbeat this often. */
    sessionHeartbeatMs: 30_000,
    /**
     * A session whose heartbeat is older than this is not connected; the sweeper closes it once its host process has
     * exited (or when no host process is recorded).
     */
    sessionStaleMs: 120_000,
    /**
     * A session whose host process is still running is closed only after its heartbeat has been silent this long (a hung
     * host). Shorter gaps are a machine that slept or a clock that jumped: the host heartbeats again within one interval.
     */
    sessionHungMs: 6 * 3600_000,
};
//# sourceMappingURL=types.js.map