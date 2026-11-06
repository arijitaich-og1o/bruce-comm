import path from 'node:path';
import { BruceError } from '../util.js';
import { loadRunnerConfig } from './config.js';
import { prepareRunner, RunnerWorker } from './worker.js';
import { recoverWorkspaceFiles, restoreAllWorkspaceFiles } from './workspace.js';
export { loadRunnerConfig, parseRunnerConfig, PRESET_IDS, PLACEHOLDERS } from './config.js';
export { checkRunners, detectPresetCommand, writeExampleRunnerConfig } from './setup.js';
export { PRESETS } from './presets.js';
export { resolveCommand, tryResolveCommand } from './spawn.js';
const SHUTDOWN_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];
/**
 * Run the enabled runner entries until SIGINT/SIGTERM or `options.signal` aborts (or, with `once`,
 * until each has processed at most one task). Each runner opens a session of its agent (transport
 * "runner", workspace = its cwd), claims the tasks routed to that session, launches the configured
 * headless CLI and reports the outcome. On shutdown children are killed, in-flight tasks released
 * back to the queue and the sessions closed.
 *
 * Workspace config files a run merged into (Cursor's .cursor/mcp.json) are restored however the process ends: by
 * the run itself, on a forced exit (second Ctrl+C, crash) by the 'exit' hook, and after a hard kill by the next
 * start, which replays the restore records left in <home>/runs.
 */
export async function runRunners(ctx, options) {
    const { runners } = loadRunnerConfig(options.configFile);
    const selected = selectRunners(runners, options.only, options.configFile);
    for (const file of recoverWorkspaceFiles(path.join(ctx.config.home, 'runs'))) {
        ctx.log(`runner: restored ${file}, which an earlier runner process left modified`);
    }
    const stop = new AbortController();
    const workers = [];
    const onExternalAbort = () => stop.abort();
    const onSignal = (signal) => {
        if (stop.signal.aborted) {
            ctx.log(`runner: ${signal} again - exiting immediately`);
            // Hand in-flight tasks back and close the sessions now, so nobody waits for the sweeper to notice.
            for (const worker of workers)
                worker.abandon('runner force-stopped');
            process.exit(130);
        }
        ctx.log(`runner: ${signal} received - stopping (killing agent processes, releasing in-flight tasks; press Ctrl+C again to force)`);
        stop.abort();
    };
    options.signal?.addEventListener('abort', onExternalAbort, { once: true });
    if (options.signal?.aborted)
        stop.abort();
    for (const signal of SHUTDOWN_SIGNALS)
        process.on(signal, onSignal);
    process.on('exit', restoreAllWorkspaceFiles);
    try {
        for (const runner of selected) {
            try {
                const worker = new RunnerWorker(ctx, prepareRunner(ctx, runner), { once: options.once === true, stopSignal: stop.signal });
                worker.register();
                workers.push(worker);
            }
            catch (err) {
                const e = err;
                ctx.log(`runner[${runner.agent.id}] cannot start: ${e.message}${e.hint ? ` ${e.hint}` : ''}`);
            }
        }
        if (!workers.length) {
            throw new BruceError('no_runners', 'No runner could be started.', 'Run "bruce-comm runner check" to see what is wrong.');
        }
        ctx.log(`runner: ${workers.length} runner(s) active: ${workers.map((w) => w.id).join(', ')}${options.once ? ' (once)' : ''}`);
        await Promise.all(workers.map((w) => w.run()));
        ctx.log('runner: stopped');
    }
    finally {
        for (const signal of SHUTDOWN_SIGNALS)
            process.off(signal, onSignal);
        process.off('exit', restoreAllWorkspaceFiles);
        options.signal?.removeEventListener('abort', onExternalAbort);
    }
}
/** Enabled runners, optionally narrowed to `only` (unknown or disabled ids are errors). */
function selectRunners(runners, only, file) {
    const wanted = (only ?? []).map((id) => id.trim().toLowerCase()).filter(Boolean);
    if (wanted.length) {
        const byId = new Map(runners.map((r) => [r.agent.id, r]));
        for (const id of wanted) {
            const runner = byId.get(id);
            if (!runner) {
                throw new BruceError('unknown_runner', `No runner for agent "${id}" in ${file}.`, `Configured: ${[...byId.keys()].join(', ') || '(none)'}.`);
            }
            if (!runner.enabled)
                throw new BruceError('runner_disabled', `Runner "${id}" is disabled.`, `Set "enabled": true for it in ${file}.`);
        }
        return runners.filter((r) => wanted.includes(r.agent.id));
    }
    const enabled = runners.filter((r) => r.enabled);
    if (!enabled.length) {
        throw new BruceError('no_runners', `No enabled runner in ${file}.`, 'Set "enabled": true on at least one entry, then run "bruce-comm runner check".');
    }
    return enabled;
}
//# sourceMappingURL=runner.js.map