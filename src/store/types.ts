/** Task lifecycle, aligned with the A2A protocol task states. */
export type TaskStatus =
  | 'awaiting_approval' // held until the human approves it in the dashboard/CLI (A2A: auth-required)
  | 'queued' // waiting in the queue (A2A: submitted)
  | 'working' // claimed by an assignee holding a lease (A2A: working)
  | 'input_required' // assignee asked the sender a question (A2A: input-required)
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected' // assignee declined the task
  | 'expired'; // never claimed before expires_at

export const TASK_STATUSES: readonly TaskStatus[] = [
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

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'completed',
  'failed',
  'canceled',
  'rejected',
  'expired',
]);

/** `task` expects the recipient to do work and report a result; `message` is informational and is done once delivered. */
export type TaskKind = 'task' | 'message';

/** Agent-declared availability. Presence (active/idle/offline) is derived separately from last_seen_at. */
export type AgentStatus = 'online' | 'busy' | 'away' | 'offline';
export const AGENT_STATUSES: readonly AgentStatus[] = ['online', 'busy', 'away', 'offline'];

/**
 * Derived presence, most to least reachable:
 * listening = blocked in get_next_task right now; active = made a call in the last 2 min;
 * connected = has an open MCP session (IDE/app is running with Bruce Comm loaded); idle = seen in the last 30 min;
 * offline = none of the above.
 */
export type Presence = 'listening' | 'active' | 'connected' | 'idle' | 'offline';

/**
 * One capability an agent offers (mirrors an A2A AgentSkill). Skill ids and tags (like agent tags, platform, to_skill
 * and session labels) are plain text: control characters and < > " ` are refused.
 */
export interface Skill {
  id: string;
  name?: string;
  description?: string;
  tags?: string[];
  examples?: string[];
}

/** Profile an agent submits when registering - its "agent card". */
export interface AgentInput {
  id: string;
  name?: string;
  description?: string;
  /** Host application, e.g. claude-desktop, vscode-copilot, cursor, claude-code, gemini-cli, codex. */
  platform?: string;
  /** REQUIRED: how other agents should communicate with this agent (what to send, format, limits). */
  instructions: string;
  skills?: Skill[];
  tags?: string[];
  /** Agent ids allowed to send to this agent. ["*"] (default) means everyone. */
  accept_from?: string[];
  max_concurrent_tasks?: number;
  /** Every task sent to this agent must be approved by the human first. Agents may turn this on; only the human can turn it off. */
  require_approval?: boolean;
  owner?: string | null;
  workspace?: string | null;
  version?: string | null;
  metadata?: Record<string, unknown>;
  status?: AgentStatus;
  status_message?: string | null;
}

export type AgentPatch = Partial<Omit<AgentInput, 'id'>>;

export interface Agent {
  id: string;
  name: string;
  description: string;
  platform: string;
  instructions: string;
  skills: Skill[];
  tags: string[];
  accept_from: string[];
  max_concurrent_tasks: number;
  require_approval: boolean;
  owner: string | null;
  workspace: string | null;
  version: string | null;
  metadata: Record<string, unknown>;
  status: AgentStatus;
  status_message: string | null;
  registered_at: number;
  updated_at: number;
  last_seen_at: number;
  /** Set while the agent is blocked in a get_next_task long-poll. */
  listening_until: number | null;
  /** Number of currently connected MCP sessions (IDE windows / app instances) bound to this agent. */
  connected_sessions: number;
}

/** How a session reached Bruce Comm. `runner` = the headless runner acting for an agent. */
export type SessionTransport = 'stdio' | 'http' | 'runner';

/**
 * One live connection of an agent: an IDE window, a desktop-app instance, a CLI run. An agent may have several at
 * once (e.g. two VS Code windows on different repos); tasks can be routed to one exact session or to whichever session
 * has a given workspace open.
 */
export interface Session {
  /** Short id, e.g. "S-7K3M9Q2X". */
  id: string;
  agent_id: string | null;
  transport: SessionTransport;
  /** From the MCP initialize handshake, e.g. "Visual Studio Code" 1.140.0, "claude-ai". */
  client_name: string | null;
  client_version: string | null;
  /** Human/agent-chosen label, e.g. "VS Code - bruce-comm repo". */
  label: string | null;
  /** Normalised workspace folders (from MCP roots or declared by the agent). */
  workspaces: string[];
  /** PID of the Bruce Comm process hosting this session (liveness check). */
  host_pid: number | null;
  started_at: number;
  /** Refreshed every ~30 s by the hosting process while the connection is open. */
  heartbeat_at: number;
  /** Last tool call made through this session. */
  last_active_at: number | null;
  listening_until: number | null;
  closed_at: number | null;
  close_reason: string | null;
  /** Derived: open and heartbeat fresh. */
  connected: boolean;
  /** Derived: blocked in a get_next_task long-poll right now. */
  listening: boolean;
}

export interface SessionInput {
  /** Optional explicit id (defaults to a new "S-..." id). */
  id?: string;
  transport: SessionTransport;
  agent_id?: string | null;
  client_name?: string | null;
  client_version?: string | null;
  label?: string | null;
  workspaces?: string[];
  host_pid?: number | null;
}

export interface SessionPatch {
  agent_id?: string | null;
  client_name?: string | null;
  client_version?: string | null;
  label?: string | null;
  workspaces?: string[];
}

export interface SendInput {
  kind?: TaskKind;
  /** Exactly one of to_agent / to_skill / broadcast. to_agent "*" = any registered agent may claim it. */
  to_agent?: string;
  to_skill?: string;
  broadcast?: boolean;
  title: string;
  body?: string;
  input?: unknown;
  /** 0 (lowest) .. 9 (highest). Default 5. */
  priority?: number;
  thread_id?: string;
  parent_task_id?: string;
  idempotency_key?: string;
  /** How long a claim lasts without a progress update before the task is re-queued. */
  lease_seconds?: number;
  max_attempts?: number;
  /** Task expires if not claimed within this many seconds. */
  expires_in_seconds?: number;
  /** Do not deliver before this many seconds from now. */
  delay_seconds?: number;
  /** Hold the task until the human approves it (dashboard / CLI). */
  requires_approval?: boolean;
  /**
   * Deliver only to this session of to_agent (see list_sessions); it must be connected now. While that session is not
   * connected (closed, or no heartbeat for LIMITS.sessionStaleMs) the task falls back to any session of the agent with
   * the same workspace (or any session if it had none); if it reconnects first, the pin binds again.
   */
  to_session?: string;
  /** Deliver only to a session of to_agent that has this workspace folder (path) or label open. */
  to_workspace?: string;
}

export interface Task {
  id: string;
  kind: TaskKind;
  from_agent: string;
  to_agent: string | null;
  to_skill: string | null;
  title: string;
  body: string;
  input: unknown;
  priority: number;
  /** Delegation depth: 0 for a root task, parent.depth + 1 for sub-tasks (loop protection). */
  depth: number;
  requires_approval: boolean;
  approved_by: string | null;
  status: TaskStatus;
  status_message: string | null;
  progress: number | null;
  thread_id: string;
  parent_task_id: string | null;
  broadcast_id: string | null;
  idempotency_key: string | null;
  assignee: string | null;
  /** Session the sender used; follow-ups addressed back to the sender are routed to it. */
  from_session: string | null;
  /**
   * Session routing: only this session may claim it - while that session is connected (open, heartbeat within
   * LIMITS.sessionStaleMs). While it is not, to_workspace decides who may claim it (any session of the agent if none);
   * the pin binds again when the session is back. Cleared when the session closes, or when the task is claimed through
   * another session.
   */
  to_session: string | null;
  /**
   * Set while an answered task waits for the session that asked the question (to_session holds the same id). That pin
   * is temporary and follows the to_session rule: it binds only while that session is connected, and it is dropped
   * when the task is claimed, goes back to the open queue, or that session closes.
   */
  resume_session: string | null;
  /** Workspace routing: only a session with this normalised workspace/label may claim it (unless a to_session pin binds). */
  to_workspace: string | null;
  /** Session that claimed the task; an answered question returns the task to this session. */
  assignee_session: string | null;
  lease_seconds: number;
  lease_expires_at: number | null;
  attempts: number;
  max_attempts: number;
  result: string | null;
  result_data: unknown;
  error: string | null;
  /** Whether the sender has looked at the task since it reached a terminal state. */
  result_seen: boolean;
  created_at: number;
  updated_at: number;
  not_before: number | null;
  expires_at: number | null;
  claimed_at: number | null;
  completed_at: number | null;
}

export type TaskEventType =
  | 'created'
  | 'claimed'
  | 'delivered'
  | 'progress'
  | 'input_requested'
  | 'input_provided'
  | 'completed'
  | 'failed'
  | 'retrying'
  | 'rejected'
  | 'released'
  | 'lease_expired'
  | 'canceled'
  | 'expired'
  | 'approved'
  | 'denied'
  | 'rerouted'
  | 'note';

export interface TaskEvent {
  seq: number;
  task_id: string;
  at: number;
  actor: string;
  type: TaskEventType;
  message: string | null;
  data: unknown;
}

export interface TaskFilter {
  /** Tasks sent by this agent. */
  from_agent?: string;
  /** Tasks addressed to this agent directly. */
  to_agent?: string;
  /** Tasks currently claimed by / reserved for this agent. */
  assignee?: string;
  /** Tasks this agent could claim right now or is working on (direct, skill-routed, open, reserved). */
  inbox_of?: string;
  status?: TaskStatus | TaskStatus[];
  kind?: TaskKind;
  thread_id?: string;
  parent_task_id?: string;
  limit?: number;
  /** Newest first when true (default). */
  newest_first?: boolean;
}

export interface AgentFilter {
  skill?: string;
  platform?: string;
  status?: AgentStatus;
  /** Free-text search over id, name, description, skills, tags. */
  query?: string;
  include_offline?: boolean;
}

export interface ClaimResult {
  task: Task | null;
  /** Why nothing was returned (e.g. concurrency limit), when task is null. */
  reason?: string;
}

export interface QueueStatsAgents {
  total: number;
  listening: number;
  active: number;
  connected: number;
  idle: number;
  offline: number;
}

export interface QueueStats {
  agents: QueueStatsAgents;
  sessions: { connected: number; listening: number };
  tasks: Record<TaskStatus, number>;
  oldest_queued_at: number | null;
}

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
} as const;

/** Counters attached to tool responses so agents notice new work without polling. */
export interface PendingCounts {
  /** Tasks you could claim right now with get_next_task. */
  tasks: number;
  /** Undelivered messages for you. */
  messages: number;
  /** Tasks you are working on. */
  working: number;
  /** Tasks you asked a question on and are waiting for an answer. */
  waiting_for_answer: number;
  /** Tasks you SENT where the assignee asked you a question (answer with reply_to_task). */
  questions_for_you: number;
  /** Tasks you SENT that finished and whose result you have not looked at yet. */
  results_ready: number;
  /** Tasks addressed to you that are waiting for the human's approval. */
  awaiting_approval: number;
}
