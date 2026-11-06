import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SERVER_NAME, SERVER_VERSION } from '../config.js';
import type { BruceContext } from '../context.js';
import { BruceError } from '../util.js';
import { SERVER_INSTRUCTIONS, runnerInstructions } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';
import { ToolRuntime } from './runtime.js';
import { SessionLink } from './sessions.js';
import { registerTools } from './tools/index.js';

export {
  SERVER_INSTRUCTIONS,
  runnerInstructions,
  MAX_WAIT_SECONDS,
  MAX_WAIT_WITH_PROGRESS_SECONDS,
  MAX_WAIT_ENV,
  LONG_WAIT_CLIENTS,
  waitCapFor,
} from './instructions.js';
export { renderTaskBrief } from './format.js';
export { TOOL_NAMES } from './tools/index.js';
export { heartbeatOpenSessions, trackedSessionCount } from './sessions.js';

/** Per-MCP-session state. One instance per connected client session. */
export interface SessionState {
  /** Agent identity bound to this session (by register_agent, any call passing agent_id, or pre-bound by the transport). */
  agentId?: string;
  /**
   * The identity was pre-bound by the client configuration (`--agent-id`, BRUCE_AGENT_ID, `?agent=`, X-Bruce-Agent).
   * A call passing a different agent_id then acts as that agent for the call only; only register_agent re-binds.
   * Defaults to true when `agentId` is set at creation.
   */
  preBound?: boolean;
  /**
   * The agent id the client configuration pre-bound (set by createBruceServer when `preBound`). Unlike `agentId` it
   * never changes: register_agent may re-bind the window, but the window stays "configured as" this agent. Such a window
   * may change or remove only this agent's profile and agents it created itself (`createdAgentIds`) - so a
   * prompt-injected agent in one configured client cannot rewrite or remove another agent's existing profile.
   */
  configuredAgentId?: string;
  /** Agent ids this MCP session registered (created) itself; a pre-bound window may manage these too. */
  createdAgentIds?: Set<string>;
  /**
   * Set for a one-shot session the runner started for this task (`--runner-task`, BRUCE_COMM_RUNNER_TASK,
   * `?runner_task=`): no work loop - get_next_task is refused and replies tell the CLI to stop after reporting.
   */
  runnerTask?: string;
  transport: 'stdio' | 'http';
  /** Transport-level session id (the HTTP `mcp-session-id`); unset for stdio. */
  sessionId?: string;
  /**
   * Bruce Comm session id ("S-XXXXXXXX", the store's `sessions` row), set by createBruceServer. Used for routing
   * (send_task to_session) and by the HTTP daemon to disconnect a session closed from the dashboard.
   */
  bruceSessionId?: string;
}

/** Validate a runner task marker (a task id such as "T-7K2M9QX4PA"); undefined when empty. Throws on a malformed one. */
export function normalizeRunnerTask(raw: string | null | undefined): string | undefined {
  const value = raw?.trim().toUpperCase();
  if (!value) return undefined;
  if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(value)) {
    throw new BruceError('invalid_argument', `Invalid runner task id "${raw}".`, 'Expected a task id such as T-7K2M9QX4PA.');
  }
  return value;
}

/**
 * Build a fully configured McpServer (tools, resources, prompts, instructions) for ONE session.
 * Everything is registered before returning, so the caller only has to `connect()` a transport.
 * Opens the store session immediately (sets `session.bruceSessionId`); it is closed when the server closes.
 * Do not overwrite `server.server.onclose` / `oninitialized` afterwards - chain them instead.
 */
export function createBruceServer(ctx: BruceContext, session: SessionState): McpServer {
  if (session.agentId) session.agentId = session.agentId.trim().toLowerCase() || undefined;
  session.preBound ??= session.agentId !== undefined;
  if (session.preBound && session.agentId) session.configuredAgentId ??= session.agentId;
  const server = new McpServer(
    {
      name: SERVER_NAME,
      title: 'Bruce Comm',
      version: SERVER_VERSION,
      description: 'Local gateway where AI agents register, discover each other and exchange tasks through a shared queue.',
    },
    {
      // Merged with the capabilities McpServer adds itself (tools, prompts, resources.listChanged, completions).
      capabilities: { resources: { subscribe: true, listChanged: true } },
      instructions: session.runnerTask ? runnerInstructions(session.runnerTask) : SERVER_INSTRUCTIONS,
    },
  );

  const link = new SessionLink(ctx, session, server);
  registerTools(server, new ToolRuntime(ctx, session, link));
  const watcher = registerResources(server, ctx, session);
  registerPrompts(server, ctx);

  // Lifecycle: once the client finished initializing, record who it is (client info, roots) and watch the queue;
  // when the session closes, stop watching and close the store session (its pinned work falls back).
  const previousInitialized = server.server.oninitialized;
  server.server.oninitialized = () => {
    previousInitialized?.();
    link.onInitialized();
    watcher.start();
  };
  const previousClose = server.server.onclose;
  server.server.onclose = () => {
    watcher.close();
    link.close('disconnected');
    previousClose?.();
  };
  return server;
}
