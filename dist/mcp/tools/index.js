import { PC_TOOL_NAMES, registerPcControlTools } from '../../pccontrol/tools.js';
import { registerAgentTools } from './agents.js';
import { registerSendingTools } from './sending.js';
import { registerSessionTools } from './sessions.js';
import { registerWorkingTools } from './working.js';
/** Names of every tool Bruce Comm exposes, in registration order. */
export const TOOL_NAMES = [
    'register_agent',
    'unregister_agent',
    'list_agents',
    'get_agent',
    'bruce_status',
    'send_task',
    'get_task',
    'list_tasks',
    'wait_for_result',
    'cancel_task',
    'reply_to_task',
    'get_next_task',
    'update_task_progress',
    'request_input',
    'complete_task',
    'fail_task',
    'reject_task',
    'release_task',
    'list_sessions',
    ...PC_TOOL_NAMES,
];
/** Register all 33 tools (19 Bruce Comm + 14 PC control) on `server`. */
export function registerTools(server, runtime) {
    registerAgentTools(server, runtime);
    registerSendingTools(server, runtime);
    registerWorkingTools(server, runtime);
    registerSessionTools(server, runtime);
    registerPcControlTools(server, runtime);
}
//# sourceMappingURL=index.js.map