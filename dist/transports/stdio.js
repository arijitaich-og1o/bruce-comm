import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { tolerateBrokenStderr } from '../context.js';
import { createBruceServer, normalizeRunnerTask } from '../mcp/server.js';
import { normalizeAgentId } from '../store/store.js';
/** How often this process sweeps expired leases / stale tasks (other processes sweep too). */
const SWEEP_INTERVAL_MS = 15_000;
/**
 * Serve one MCP session over stdin/stdout. Resolves when the client disconnects: stdin ends or
 * closes, stdout breaks (EPIPE), or the transport closes. Nothing but protocol is written to
 * stdout; diagnostics go to ctx.log (stderr).
 *
 * The identity is pre-bound from `options.agentId` or env `BRUCE_AGENT_ID` (validated; a reserved
 * or malformed id throws a BruceError before anything is served). `options.runnerTask` or env
 * `BRUCE_COMM_RUNNER_TASK` marks a one-shot session the runner started for that task. Callers should
 * close the context and exit once the promise resolves, so an orphaned process never lingers.
 */
export async function startStdioServer(ctx, options = {}) {
    const rawId = options.agentId ?? process.env.BRUCE_AGENT_ID;
    const agentId = rawId && rawId.trim() ? normalizeAgentId(rawId) : undefined;
    const runnerTask = normalizeRunnerTask(options.runnerTask ?? process.env.BRUCE_COMM_RUNNER_TASK);
    const session = { transport: 'stdio', agentId, preBound: agentId !== undefined, runnerTask };
    // A client that stops reading our stderr must not crash the server at its next diagnostic line (EPIPE).
    tolerateBrokenStderr();
    const server = createBruceServer(ctx, session);
    const transport = new StdioServerTransport();
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    let finished = false;
    const sweeper = setInterval(() => {
        try {
            ctx.store.sweep();
        }
        catch (err) {
            ctx.log(`sweep failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    }, SWEEP_INTERVAL_MS);
    sweeper.unref();
    const finish = () => {
        if (finished)
            return;
        finished = true;
        clearInterval(sweeper);
        process.stdin.off('end', onInputGone);
        process.stdin.off('close', onInputGone);
        process.stdout.off('error', onOutputError);
        resolveDone();
    };
    // StdioServerTransport does not react to stdin EOF: shut down explicitly when the client goes away.
    const onInputGone = () => {
        void server.close().catch(() => { }).finally(finish);
    };
    const onOutputError = (err) => {
        if (err.code !== 'EPIPE' && err.code !== 'ERR_STREAM_DESTROYED')
            ctx.log(`stdout error: ${err.message}`);
        onInputGone();
    };
    // Set BEFORE connect(): Protocol.connect() chains a pre-existing onclose / onerror.
    transport.onclose = finish;
    transport.onerror = (err) => ctx.log(`stdio transport: ${err.message}`);
    process.stdin.on('end', onInputGone);
    process.stdin.on('close', onInputGone);
    process.stdout.on('error', onOutputError);
    try {
        await server.connect(transport);
    }
    catch (err) {
        finish();
        throw err;
    }
    ctx.log(`stdio MCP session ready${agentId ? ` as "${agentId}"` : ''}${runnerTask ? ` for runner task ${runnerTask}` : ''} (db: ${ctx.config.dbPath})`);
    return done;
}
//# sourceMappingURL=stdio.js.map