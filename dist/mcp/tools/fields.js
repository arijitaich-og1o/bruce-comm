import { z } from 'zod';
import { TASK_STATUSES } from '../../store/types.js';
import { waitCapSentence } from '../instructions.js';
// Factories (not shared instances) so every tool gets its own schema objects.
/** The caller's own identity, accepted by every tool. */
export function callerIdField() {
    return z
        .string()
        .optional()
        .describe('YOUR OWN agent id (the caller). Optional once register_agent has bound this session; passing it on every call is always safe.');
}
/** A task or message id. */
export function taskIdField(what = 'The task id') {
    return z.string().min(1).describe(`${what}, e.g. "T-7K2M9QX4PA" (messages: "M-...").`);
}
/** Long-poll duration. */
export function waitSecondsField(defaultSeconds, purpose) {
    return z
        .number()
        .min(0)
        .default(defaultSeconds)
        .describe(`${purpose} Default ${defaultSeconds}. ${waitCapSentence()} Use 25 if your client times out tool calls sooner than 60 s.`);
}
/** Any JSON value. */
export function jsonField(description) {
    return z.unknown().optional().describe(description);
}
/** Status filter: one status or several. */
export function statusFilterField() {
    return z
        .union([z.string(), z.array(z.string())])
        .optional()
        .describe(`Only tasks in this status (or any of these). One of: ${TASK_STATUSES.join(', ')}. A comma-separated string also works.`);
}
//# sourceMappingURL=fields.js.map