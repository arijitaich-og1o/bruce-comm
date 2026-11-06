import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bruceBinPath, bruceServerSpec, nodePath, packageVersion } from '../clients.js';
import { LIMITS } from '../store/types.js';
import { BruceError, clamp, iso, sleep } from '../util.js';
import { runnerAgentInput, runnerCwd, substitute } from './config.js';
import { PRESETS } from './presets.js';
import { buildPrompt } from './prompt.js';
import { processAlive, resolveCommand, runProcess } from './spawn.js';
import { acquireWorkspaceFiles, lockWorkspace, workspaceLocked } from './workspace.js';
/** `client_name` of the store session every runner agent opens (transport "runner"). */
export const RUNNER_CLIENT_NAME = 'bruce-comm-runner';
/** How often presence (listening_until) is refreshed. */
const PRESENCE_INTERVAL_MS = 30_000;
/** How long the agent counts as listening after each refresh. */
const PRESENCE_TTL_MS = 90_000;
/** Longest idle wait before re-checking the queue (also covers delayed tasks becoming due). */
const IDLE_WAIT_MS = 30_000;
/** Characters of stderr / stdout kept in failure messages. */
const TAIL_CHARS = 2000;
/** Wait before judging a failed exit, so a console Ctrl+C that also hit the child is seen as a shutdown. */
const CTRL_C_GRACE_MS = 300;
/**
 * After the agent asked a question (request_input), how long its CLI may wind down before the run is ended. The run
 * reports nothing: the task waits for the answer and is then started again in a new run.
 */
export const INPUT_GRACE_MS = 10_000;
/** Resolve a runner's command and working directory. Throws a BruceError explaining what to fix. */
export function prepareRunner(ctx, runner) {
    const preset = PRESETS[runner.preset];
    const names = runner.command ? [runner.command] : preset.commands;
    let lastError;
    let resolved;
    for (const name of names) {
        try {
            resolved = { name, command: resolveCommand(name) };
            break;
        }
        catch (err) {
            lastError ??= err;
        }
    }
    if (!resolved) {
        throw lastError ?? new BruceError('command_not_found', `No command configured for preset "${runner.preset}".`);
    }
    const { cwd, isDefault } = runnerCwd(ctx.config, runner);
    if (isDefault) {
        fs.mkdirSync(cwd, { recursive: true });
    }
    else if (!isDirectory(cwd)) {
        throw new BruceError('invalid_cwd', `Working directory does not exist: ${cwd}`, 'Fix "cwd" in runners.json, or remove it to use the default.');
    }
    return {
        runner,
        preset,
        commandName: resolved.name,
        command: resolved.command,
        cwd,
        resultFrom: runner.resultFrom ?? preset.resultFrom,
    };
}
function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    }
    catch {
        return false;
    }
}
/** Default profile instructions for a runner agent that did not configure its own. */
export function defaultRunnerInstructions(preset, resultFrom, timeoutSeconds) {
    const minutes = Math.max(1, Math.round(timeoutSeconds / 60));
    return [
        `Headless ${preset.title} worker started by the Bruce Comm runner.`,
        'Send me ONE self-contained task per send_task: the goal, all context I need (file paths, repository, constraints) and the exact',
        'output you expect, in the title/body. I cannot see your conversation.',
        resultFrom === 'mcp' ? 'I report the result with complete_task.' : 'My final answer becomes the task result.',
        `I may ask a question with request_input. Each run is limited to about ${minutes} minute(s).`,
    ].join(' ');
}
/**
 * Runs one runner entry: keeps the agent registered and present, claims tasks up to `concurrency`,
 * launches the CLI for each, supervises it (lease renewal, cancel, timeout) and reports the outcome.
 *
 * The runner is one SESSION of its agent (transport "runner", workspace = its cwd), shared by all concurrent
 * runs: it claims only work that is not pinned to another session/workspace, heartbeats the session, and closes
 * it on shutdown. If the process dies without closing it, the store's sweeper (host PID gone) or the next runner
 * start closes it and re-queues the tasks it was working on.
 */
export class RunnerWorker {
    ctx;
    prepared;
    options;
    id;
    /** In-flight runs by claim (runKey): an answered task can be claimed again while its previous run winds down. */
    active = new Map();
    stopping = false;
    wakeController = null;
    /** Pending-count signature for which a claim attempt found nothing deliverable (avoids busy loops). */
    fruitless = null;
    /** The store session this runner claims through (null until opened, and after it was closed). */
    sessionId = null;
    constructor(ctx, prepared, options) {
        this.ctx = ctx;
        this.prepared = prepared;
        this.options = options;
        this.id = prepared.runner.agent.id;
    }
    /**
     * How the CLI of one run reaches Bruce Comm: identity pre-bound to the runner agent, same database, and marked as a
     * one-shot runner child of `taskId` (the server then leaves out work-loop guidance and refuses get_next_task).
     */
    runSpec(taskId) {
        return bruceServerSpec(this.ctx.config, {
            transport: this.prepared.runner.mcpTransport,
            agentId: this.id,
            bindVia: 'arg',
            env: { BRUCE_COMM_HOME: this.ctx.config.home, BRUCE_COMM_DB: this.ctx.config.dbPath },
            runnerTask: taskId,
        });
    }
    get concurrency() {
        return this.prepared.runner.concurrency;
    }
    log(message) {
        this.ctx.log(`runner[${this.id}] ${message}`);
    }
    /** Register (or update) the runner agent's profile. */
    register() {
        const { runner, preset, resultFrom } = this.prepared;
        if (runner.keepAgentProfile && this.ctx.store.getAgent(this.id)) {
            this.log(`using the existing profile (keepAgentProfile; ${preset.id}: ${this.prepared.command.via})`);
            return;
        }
        const input = runnerAgentInput(runner, { platform: preset.platform, instructions: defaultRunnerInstructions(preset, resultFrom, runner.timeoutSeconds), resultFrom }, os.hostname());
        const { created } = this.ctx.store.registerAgent(input, { asHuman: true });
        this.log(`${created ? 'registered' : 'profile updated'} (${preset.id}: ${this.prepared.command.via})`);
    }
    /**
     * Main loop (call register() first). Resolves after shutdown, or after at most one task in once
     * mode. Never throws for task errors.
     */
    async run() {
        const stopSignal = this.options.stopSignal;
        const onStop = () => this.beginStop();
        stopSignal.addEventListener('abort', onStop, { once: true });
        // Process-local timer: "this runner is still alive". Unref'd - it must never keep the process up by itself.
        const heartbeat = setInterval(() => this.heartbeat(), LIMITS.sessionHeartbeatMs);
        heartbeat.unref();
        let presence;
        let claimed = 0;
        try {
            this.startup();
            presence = setInterval(() => this.keepAlive(), PRESENCE_INTERVAL_MS);
            if (stopSignal.aborted)
                this.beginStop();
            while (!this.stopping) {
                try {
                    const sessionId = this.ensureSession();
                    // A fallback twin leaves messages to the interactive agent.
                    const delivered = this.fallbackMs === null ? this.deliverMessages(sessionId) : 0;
                    if (this.options.once && claimed >= 1)
                        break;
                    if (this.active.size < this.concurrency) {
                        const task = this.claim(delivered, sessionId);
                        if (task) {
                            claimed++;
                            this.start(task);
                            continue;
                        }
                        if (this.options.once) {
                            this.log('once: no task waiting - exiting');
                            break;
                        }
                    }
                    await this.waitForWork();
                }
                catch (err) {
                    await this.recover(err);
                }
            }
        }
        finally {
            clearInterval(presence);
            await Promise.allSettled([...this.active.values()].map((run) => run.promise));
            clearInterval(heartbeat);
            stopSignal.removeEventListener('abort', onStop);
            this.markStopped();
            // After the in-flight runs were released: closing earlier would re-queue them at the cost of an attempt.
            this.closeSession('runner stopped');
        }
    }
    /**
     * Last-resort cleanup when the process is about to exit without the normal shutdown (second Ctrl+C):
     * hand in-flight tasks back without using up an attempt, restore workspace config files, mark the agent offline
     * and close the session. Synchronous - it runs right before process.exit().
     */
    abandon(reason) {
        this.stopping = true;
        for (const run of this.active.values()) {
            this.releaseTask(run.task, `Runner exited (${reason}); the task was handed back unchanged.`);
            run.releaseWorkspace?.();
        }
        this.markStopped();
        this.closeSession(reason);
    }
    beginStop() {
        if (this.stopping)
            return;
        this.stopping = true;
        for (const run of this.active.values()) {
            run.abort.abort();
            run.proc?.kill('shutdown');
        }
        this.wakeController?.abort();
    }
    async recover(err) {
        if (err instanceof BruceError && err.code === 'unknown_agent') {
            this.log('agent profile was removed (e.g. from the dashboard) - registering it again');
            try {
                this.register();
                return;
            }
            catch (again) {
                this.log(`re-register failed: ${again.message}`);
            }
        }
        else {
            this.log(`loop error: ${err.message}`);
        }
        await sleep(5000, this.options.stopSignal);
    }
    /** Open the session, recover work left by a crashed earlier runner, announce presence. Never throws. */
    startup() {
        try {
            this.ensureSession();
        }
        catch (err) {
            this.log(`cannot open a session yet (retrying in the main loop): ${err.message}`);
        }
        try {
            this.recoverStaleWork();
        }
        catch (err) {
            this.log(`could not check for work left by an earlier run: ${err.message}`);
        }
        this.keepAlive();
    }
    /**
     * The runner's store session, opened on first use. If it was closed meanwhile - by the human (close-session,
     * dashboard) or by the sweeper after the machine slept past the stale window - a new one is opened: a running
     * runner is reachable again, and the closed session's work has already gone back to the queue.
     */
    ensureSession() {
        const store = this.ctx.store;
        if (this.sessionId) {
            const current = store.getSession(this.sessionId);
            if (current && current.closed_at === null) {
                // Unregistering the agent (dashboard / CLI) unbinds its sessions; the runner re-registered, so re-bind.
                if (current.agent_id !== this.id)
                    store.updateSession(current.id, { agent_id: this.id });
                else if (!current.connected)
                    store.heartbeatSessions([current.id]);
                return current.id;
            }
            this.log(`session ${this.sessionId} was closed${current?.close_reason ? ` (${current.close_reason})` : ''} - opening a new one`);
            this.sessionId = null;
        }
        const { preset, cwd } = this.prepared;
        const session = store.openSession({
            transport: 'runner',
            agent_id: this.id,
            client_name: RUNNER_CLIENT_NAME,
            client_version: packageVersion(),
            label: `${preset.id} runner`,
            workspaces: [cwd],
        });
        this.sessionId = session.id;
        this.log(`session ${session.id} open (workspace ${cwd})`);
        return session.id;
    }
    heartbeat() {
        if (!this.sessionId)
            return;
        try {
            this.ctx.store.heartbeatSessions([this.sessionId]);
        }
        catch (err) {
            this.log(`session heartbeat failed: ${err.message}`);
        }
    }
    closeSession(reason) {
        const id = this.sessionId;
        if (!id)
            return;
        this.sessionId = null;
        try {
            this.ctx.store.closeSession(id, reason);
            this.log(`session ${id} closed (${reason})`);
        }
        catch (err) {
            this.log(`could not close session ${id}: ${err.message}`);
        }
    }
    /**
     * Work left behind by an earlier runner process for this agent that died without closing its session (crash,
     * taskkill /F, power loss). The store sweeper closes such a session once its host PID is gone AND its heartbeat
     * is ~45 s old; a runner restarted sooner closes it right away, which re-queues the tasks it was working on so
     * this runner can pick them up. Tasks still marked working without any live session (claimed by a client that
     * has no session) only return to the queue when their lease expires - those are reported.
     */
    recoverStaleWork() {
        const store = this.ctx.store;
        for (const s of store.listSessions({ agent_id: this.id, limit: 500 })) {
            if (s.id === this.sessionId || s.transport !== 'runner' || s.host_pid == null || s.host_pid === process.pid)
                continue;
            if (processAlive(s.host_pid)) {
                const beat = Math.round((Date.now() - s.heartbeat_at) / 1000);
                this.log(`note: another runner process (pid ${s.host_pid}, session ${s.id}, last heartbeat ${beat}s ago) also serves this agent; ` +
                    'tasks go to whichever claims first.');
                continue;
            }
            const held = store.listTasks({ assignee: this.id, status: 'working', limit: 500 }).filter((t) => t.assignee_session === s.id);
            store.closeSession(s.id, 'host process exited');
            this.log(`closed session ${s.id} of an earlier runner process (pid ${s.host_pid} is gone)` +
                (held.length ? `; re-queued the task(s) it was working on: ${held.map((t) => t.id).join(', ')}` : ''));
        }
        const orphans = store.listTasks({ assignee: this.id, status: 'working', limit: 50 }).filter((t) => {
            if (!t.assignee_session)
                return true;
            const holder = store.getSession(t.assignee_session);
            return !holder || !holder.connected;
        });
        if (!orphans.length)
            return;
        const until = Math.max(...orphans.map((t) => t.lease_expires_at ?? 0));
        this.log(`${orphans.length} task(s) are still marked working for this agent without a live session (${orphans.map((t) => t.id).join(', ')}); ` +
            `they return to the queue when their lease expires (by ${iso(until)}).`);
    }
    /** Fallback delay in ms, or null when the runner claims work immediately. */
    get fallbackMs() {
        const s = this.prepared.runner.fallbackAfterSeconds;
        return s == null ? null : s * 1000;
    }
    /**
     * Fallback mode: ids of queued tasks for this agent that have waited at least the fallback delay, or [] when none
     * (or when an interactive session of the agent is listening and will take them itself).
     */
    agedTasks() {
        const delay = this.fallbackMs;
        if (delay === null)
            return [];
        const store = this.ctx.store;
        const interactiveListening = store
            .listSessions({ agent_id: this.id })
            .some((s) => s.id !== this.sessionId && s.transport !== 'runner' && s.listening);
        if (interactiveListening)
            return [];
        const cutoff = Date.now() - delay;
        return store
            .listTasks({ inbox_of: this.id, status: 'queued', kind: 'task', limit: 200 })
            .filter((t) => t.updated_at <= cutoff && (t.not_before == null || t.not_before <= Date.now()))
            .map((t) => t.id);
    }
    keepAlive() {
        try {
            const until = Date.now() + PRESENCE_TTL_MS;
            if (this.fallbackMs !== null) {
                // A twin must not make the agent look "listening": senders would then skip waking the interactive session.
                if (this.sessionId)
                    this.ctx.store.touchSession(this.sessionId);
                return;
            }
            this.ctx.store.touchAgent(this.id, until);
            if (this.sessionId)
                this.ctx.store.touchSession(this.sessionId, { listeningUntil: until });
        }
        catch (err) {
            this.log(`presence update failed: ${err.message}`);
        }
    }
    markStopped() {
        if (this.fallbackMs !== null)
            return; // the twin never changes the interactive agent's status
        try {
            if (!this.options.once) {
                this.ctx.store.updateAgent(this.id, {
                    status: 'offline',
                    status_message: `Runner stopped at ${iso(Date.now())}; tasks wait in the queue until it restarts.`,
                });
            }
            this.ctx.store.touchAgent(this.id, null);
        }
        catch {
            // the agent may have been removed meanwhile
        }
    }
    /** Deliver pending messages (kind=message) routed to this session and log them. Returns how many were delivered. */
    deliverMessages(sessionId) {
        const messages = this.ctx.store.takeMessages(this.id, LIMITS.messagesPerFetch, sessionId);
        for (const m of messages) {
            const body = m.body ? ` - ${oneLine(m.body, 300)}` : '';
            this.log(`message ${m.id} from ${m.from_agent}: ${oneLine(m.title, 200)}${body}`);
        }
        return messages.length;
    }
    /** Claim the next task this session may take (work pinned to another session or workspace is skipped). */
    claim(delivered, sessionId) {
        if (this.fallbackMs !== null) {
            const aged = this.agedTasks();
            if (!aged.length)
                return null;
            const result = this.ctx.store.claimNext(this.id, sessionId);
            if (result.task) {
                this.fruitless = null;
                this.log(`${result.task.id}: nobody took it within ${this.prepared.runner.fallbackAfterSeconds}s - handling it headless`);
                return result.task;
            }
            this.fruitless = `aged:${aged.join(',')}`;
            return null;
        }
        const result = this.ctx.store.claimNext(this.id, sessionId);
        if (result.task) {
            this.fruitless = null;
            return result.task;
        }
        const counts = this.ctx.store.pendingCounts(this.id, sessionId);
        this.fruitless = delivered === 0 && (counts.tasks > 0 || counts.messages > 0) ? signature(counts) : null;
        if (result.reason)
            this.log(result.reason);
        return null;
    }
    /** Block until there may be work (or a slot frees, or shutdown), at most IDLE_WAIT_MS. Read-only checks. */
    async waitForWork() {
        const wake = new AbortController();
        this.wakeController = wake;
        try {
            await this.ctx.notifier.pollUntil(() => {
                if (this.stopping)
                    return true;
                // Our session was closed from outside: loop round so ensureSession() opens a new one right away.
                if (this.sessionId && this.ctx.store.getSession(this.sessionId)?.closed_at != null)
                    return true;
                if (this.active.size >= this.concurrency)
                    return null;
                if (this.fallbackMs !== null) {
                    const aged = this.agedTasks();
                    return aged.length && `aged:${aged.join(',')}` !== this.fruitless ? true : null;
                }
                const counts = this.ctx.store.pendingCounts(this.id, this.sessionId);
                if (counts.tasks + counts.messages === 0)
                    return null;
                return signature(counts) === this.fruitless ? null : true;
            }, { timeoutMs: IDLE_WAIT_MS, recheckMs: 5000, signal: AbortSignal.any([this.options.stopSignal, wake.signal]) });
        }
        finally {
            this.wakeController = null;
        }
    }
    start(task) {
        const run = { task, abort: new AbortController() };
        const key = runKey(task);
        this.active.set(key, run);
        run.promise = this.execute(run)
            .catch((err) => this.log(`${task.id}: unexpected error: ${err.message}`))
            .finally(() => {
            this.active.delete(key);
            this.wakeController?.abort();
        });
    }
    // ---------------------------------------------------------------- one task
    async execute(run) {
        const { task } = run;
        const { runner, preset } = this.prepared;
        let started = Date.now();
        const runsDir = path.join(this.ctx.config.home, 'runs');
        // One directory per claim: a resumed or re-queued task keeps its attempt number, and the previous run may still
        // be winding down - its cleanup must never delete the files of the new run.
        const runDir = path.join(runsDir, runKey(task).replace(/:/g, '-'));
        const ictx = {
            agentId: this.id,
            taskId: task.id,
            resultFrom: this.prepared.resultFrom,
            spec: this.runSpec(task.id),
            cwd: this.prepared.cwd,
            runDir,
            promptFile: path.join(runDir, 'prompt.md'),
            mcpConfigFile: path.join(runDir, preset.id === 'gemini-cli' ? 'gemini-settings.json' : 'mcp-config.json'),
            outputFile: path.join(runDir, 'output.txt'),
        };
        this.log(`claimed ${task.id} (attempt ${task.attempts}/${task.max_attempts}) from ${task.from_agent}: ${oneLine(task.title, 120)}`);
        try {
            const files = preset.files?.(ictx) ?? [];
            if (files.some((file) => file.workspace)) {
                // The workspace files can carry only one run's task marker: runs in this cwd take turns.
                const unlock = await this.waitForWorkspace(run);
                if (!unlock)
                    return;
                run.unlockWorkspace = unlock;
                started = Date.now();
            }
            fs.mkdirSync(runDir, { recursive: true });
            const prompt = buildPrompt(this.ctx.store, task, {
                agentId: this.id,
                presetTitle: preset.title,
                resultFrom: ictx.resultFrom,
                timeoutSeconds: runner.timeoutSeconds,
                borrowedSession: preset.borrowedSession,
            });
            fs.writeFileSync(ictx.promptFile, prompt, 'utf8');
            writeJson(ictx.mcpConfigFile, preset.mcpConfig(ictx.spec));
            run.releaseWorkspace = acquireWorkspaceFiles(files, runsDir);
            if (run.abort.signal.aborted) {
                this.releaseTask(task, 'Runner shutting down before the task started.');
                return;
            }
            const proc = runProcess({
                command: this.prepared.command,
                args: this.buildArgs(ictx),
                cwd: this.prepared.cwd,
                env: this.buildEnv(ictx),
                stdinText: preset.promptVia === 'stdin' ? prompt : '',
                timeoutMs: runner.timeoutSeconds * 1000,
            });
            run.proc = proc;
            if (proc.pid)
                this.log(`${task.id}: started pid ${proc.pid}`);
            const supervisor = this.supervise(run, proc);
            let outcome;
            let detached;
            try {
                outcome = await proc.done;
                if (outcome.exitCode !== 0 && !outcome.killedReason && !this.stopping) {
                    // Ctrl+C in a console reaches the child CLI too and may kill it before our own SIGINT handler
                    // runs: give the handler a moment so the task is released rather than failed.
                    await sleep(CTRL_C_GRACE_MS);
                }
                if (preset.detached && ictx.resultFrom === 'mcp' && outcome.exitCode === 0 && !outcome.killedReason) {
                    detached = await this.waitForMcpReport(run, started);
                }
            }
            finally {
                supervisor.stop();
            }
            if (runner.keepRunFiles) {
                fs.writeFileSync(path.join(runDir, 'stdout.txt'), outcome.stdout, 'utf8');
                fs.writeFileSync(path.join(runDir, 'stderr.txt'), outcome.stderr, 'utf8');
            }
            this.finish(run, outcome, detached, ictx, started);
        }
        catch (err) {
            const e = err;
            this.log(`${task.id}: ${e.message}`);
            this.failTask(task, `Runner error (${preset.id}): ${e.message}${e.hint ? ` ${e.hint}` : ''}`);
        }
        finally {
            run.releaseWorkspace?.();
            run.unlockWorkspace?.();
            if (!runner.keepRunFiles) {
                try {
                    fs.rmSync(runDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
                }
                catch {
                    // a CLI may still hold a file open on Windows; leftovers are harmless
                }
            }
        }
    }
    buildArgs(ictx) {
        const { runner, preset } = this.prepared;
        const values = this.placeholders(ictx);
        const base = runner.args ? runner.args.map((a) => substitute(a, values)) : preset.args(ictx);
        return [...base, ...(runner.extraArgs ?? []).map((a) => substitute(a, values))];
    }
    buildEnv(ictx) {
        const values = this.placeholders(ictx);
        const env = { ...(this.prepared.preset.env?.(ictx) ?? {}) };
        for (const [key, value] of Object.entries(this.prepared.runner.env ?? {}))
            env[key] = substitute(value, values);
        return env;
    }
    placeholders(ictx) {
        return {
            promptFile: ictx.promptFile,
            taskId: ictx.taskId,
            agentId: ictx.agentId,
            mcpConfigFile: ictx.mcpConfigFile,
            mcpUrl: ictx.spec.url,
            cwd: ictx.cwd,
            runDir: ictx.runDir,
            outputFile: ictx.outputFile,
            nodePath: nodePath(),
            bruceBin: bruceBinPath(),
        };
    }
    /**
     * Take the workspace lock of the cwd (lockWorkspace): wait while another run - of this or another runner entry in
     * this process - has its entries in the cwd's workspace files. The claim is supervised meanwhile as during a run
     * (lease renewed; a cancel or reassignment ends the wait). Returns the unlock function, or null when the run must
     * not start: on shutdown the task was handed back, otherwise it is no longer this run's.
     */
    async waitForWorkspace(run) {
        const { task } = run;
        const { cwd } = this.prepared;
        const busy = workspaceLocked(cwd);
        if (busy)
            this.log(`${task.id}: waiting for the workspace files in ${cwd} (another run is using them)`);
        const stopWait = new AbortController();
        let why = '';
        const supervisor = this.supervise(run, {
            kill: (reason) => {
                why ||= reason;
                stopWait.abort();
            },
        });
        let unlock;
        try {
            unlock = await lockWorkspace(cwd, AbortSignal.any([run.abort.signal, stopWait.signal]));
        }
        finally {
            supervisor.stop();
        }
        if (unlock) {
            if (busy)
                this.log(`${task.id}: workspace files free - starting`);
            return unlock;
        }
        if (run.abort.signal.aborted)
            this.releaseTask(task, 'Runner shutting down before the task started.');
        else
            this.log(`${task.id}: stopped waiting for the workspace (${why}); nothing was started`);
        return null;
    }
    /**
     * While the process runs: renew the lease (every lease/2, at most 60 s) and watch the task. If it was
     * canceled, reassigned or finished by someone else, kill the process tree. If the agent asked a question
     * (input_required), end the run after INPUT_GRACE_MS - at once when the answer is already there: the task then
     * waits, reserved for this runner, and is started again in a new run with the answer in its history.
     * Also used while a run waits for the workspace lock, with a `proc` whose kill() ends the wait.
     */
    supervise(run, proc) {
        const { task } = run;
        const store = this.ctx.store;
        let ending = null;
        const endRun = (reason, graceMs) => {
            if (graceMs > 0) {
                if (ending)
                    return;
                this.log(`${task.id}: the agent asked for input - ending the run in ${Math.round(graceMs / 1000)}s; it runs again once the answer arrives`);
                ending = setTimeout(() => proc.kill(reason), graceMs);
                return;
            }
            if (ending)
                clearTimeout(ending);
            proc.kill(reason);
        };
        const check = () => {
            const current = store.getTask(task.id);
            if (!current)
                return proc.kill('task deleted');
            if (current.status === 'canceled')
                return proc.kill('canceled');
            if (current.assignee !== this.id)
                return proc.kill(`reassigned to ${current.assignee ?? 'the queue'}`);
            if (current.status === 'failed' || current.status === 'rejected' || current.status === 'expired') {
                return proc.kill(current.status);
            }
            // Re-queued (lease expired, or this runner's session was closed) and claimed again - a newer run owns it.
            if (current.status === 'working' && !sameClaim(current, task)) {
                return proc.kill(`claimed again${current.assignee_session ? ` by session ${current.assignee_session}` : ''}`);
            }
            if (sameClaim(current, task)) {
                if (current.status === 'input_required')
                    return endRun('waiting for input', INPUT_GRACE_MS);
                // Answered while the CLI was still winding down: it waits for a fresh run.
                if (current.status === 'queued')
                    return endRun('input provided', 0);
            }
        };
        const safeCheck = () => {
            try {
                check();
            }
            catch (err) {
                this.log(`${task.id}: status check failed: ${err.message}`);
            }
        };
        const renewMs = clamp(task.lease_seconds * 500, 5_000, 60_000);
        const timer = setInterval(() => {
            try {
                // Renew only our own claim - never the lease of a newer claim of the same task.
                const current = store.getTask(task.id);
                if (current?.status === 'working' && sameClaim(current, task))
                    store.progress(this.id, task.id);
                else
                    safeCheck();
            }
            catch {
                safeCheck();
            }
        }, renewMs);
        let pending = null;
        const unsubscribe = this.ctx.notifier.subscribe((change) => {
            if (change.taskIds.length && !change.taskIds.includes(task.id))
                return;
            if (pending)
                return;
            pending = setTimeout(() => {
                pending = null;
                safeCheck();
            }, 100);
        });
        return {
            stop: () => {
                clearInterval(timer);
                unsubscribe();
                if (pending)
                    clearTimeout(pending);
                if (ending)
                    clearTimeout(ending);
            },
        };
    }
    /** Fire-and-forget presets: wait until the agent reports via MCP, the deadline passes, or shutdown. */
    async waitForMcpReport(run, started) {
        const deadline = started + this.prepared.runner.timeoutSeconds * 1000;
        this.log(`${run.task.id}: launcher exited; waiting for the agent to call complete_task (until ${iso(deadline)})`);
        const settled = await this.ctx.notifier.pollUntil(() => {
            const t = this.ctx.store.getTask(run.task.id);
            return !t || t.status !== 'working' || t.assignee !== this.id ? true : null;
        }, { timeoutMs: Math.max(0, deadline - Date.now()), recheckMs: 5000, signal: run.abort.signal });
        if (settled)
            return 'settled';
        return run.abort.signal.aborted ? 'aborted' : 'timeout';
    }
    /** Decide the task's fate after the process ended. Only acts if the task is still ours and working. */
    finish(run, outcome, detached, ictx, started) {
        const { task } = run;
        const { runner, preset, resultFrom } = this.prepared;
        const current = this.ctx.store.getTask(task.id);
        const exit = outcome.exitCode === null ? (outcome.signal ?? 'none') : String(outcome.exitCode);
        if (!current) {
            this.log(`${task.id}: task no longer exists (exit ${exit})`);
            return;
        }
        if (current.status !== 'working' || !sameClaim(current, task)) {
            this.log(`${task.id}: ${describeElsewhere(current, task)}; nothing more to report (exit ${exit}).`);
            return;
        }
        // A failed exit during shutdown is the console Ctrl+C (exit 0xC000013A on Windows), not the agent's fault.
        const interrupted = this.stopping && outcome.exitCode !== 0;
        if (outcome.killedReason === 'shutdown' || detached === 'aborted' || interrupted) {
            this.releaseTask(task, 'Runner shutting down; the task was handed back unchanged.');
            return;
        }
        const durationMs = Date.now() - started;
        const tails = failureTails(outcome);
        let error;
        if (outcome.spawnError) {
            error = `Could not start "${this.prepared.commandName}": ${outcome.spawnError}`;
        }
        else if (outcome.timedOut) {
            error = `Timed out after ${runner.timeoutSeconds}s (${preset.id}); the process tree was killed.${tails}`;
        }
        else if (outcome.killedReason) {
            error = `The ${preset.id} process was stopped (${outcome.killedReason}).${tails}`;
        }
        else if (detached === 'timeout') {
            error = `${preset.id}: the agent did not call complete_task within ${runner.timeoutSeconds}s.`;
        }
        else if (resultFrom === 'mcp' && !detached) {
            error = `${preset.id} exited with code ${exit} without calling complete_task for ${task.id}.${tails}`;
        }
        else if (resultFrom === 'mcp') {
            error = `${preset.id}: the task is still working after the launcher returned (exit ${exit}).`;
        }
        if (error === undefined) {
            const parsed = preset.parse(outcome, ictx);
            const exitOk = outcome.exitCode === 0;
            if (parsed.ok && (exitOk || (preset.trustStructuredResult && parsed.structured))) {
                const text = clipResult(parsed.text, outcome.stdoutTruncated);
                this.completeTask(task, text, { runner: { preset: preset.id, exit_code: outcome.exitCode, duration_ms: durationMs } });
                return;
            }
            const reason = parsed.ok ? '' : `: ${clip(parsed.text, 4000)}`;
            error = `${preset.id} ${exitOk ? 'reported an error' : `exited with code ${exit}`}${reason}${failureTails(outcome, !parsed.ok)}`;
        }
        this.failTask(task, error, runner.retryOnFailure, durationMs);
    }
    completeTask(task, text, data) {
        try {
            this.ctx.store.complete(this.id, task.id, text, data);
            this.log(`${task.id}: completed (${text.length} chars)`);
        }
        catch (err) {
            this.log(`${task.id}: could not record the result: ${err.message}`);
        }
    }
    failTask(task, error, retry = false, durationMs) {
        try {
            const current = this.ctx.store.getTask(task.id);
            if (!current || !sameClaim(current, task) || (current.status !== 'working' && current.status !== 'input_required'))
                return;
            const after = this.ctx.store.fail(this.id, task.id, clip(error, LIMITS.noteMax - 100), retry);
            const took = durationMs === undefined ? '' : ` after ${Math.round(durationMs / 1000)}s`;
            this.log(`${task.id}: ${after.status === 'queued' ? 'failed, re-queued for retry' : 'failed'}${took} - ${oneLine(error, 300)}`);
        }
        catch (err) {
            this.log(`${task.id}: could not record the failure: ${err.message}`);
        }
    }
    releaseTask(task, reason) {
        try {
            const current = this.ctx.store.getTask(task.id);
            if (!current || !sameClaim(current, task) || current.status !== 'working')
                return;
            this.ctx.store.release(this.id, task.id, reason);
            this.log(`${task.id}: released back to the queue`);
        }
        catch (err) {
            this.log(`${task.id}: could not release: ${err.message}`);
        }
    }
}
/** Identity of one claim of a task (task id, attempt, claim time): the key of a run and the name of its run directory. */
function runKey(task) {
    return `${task.id}:${task.attempts}:${task.claimed_at ?? 0}`;
}
/**
 * Whether `current` is still the claim a run started with. Every claim stamps a new claimed_at, so a task that went
 * back to the queue and was claimed again (by this runner or another session) no longer matches the older run.
 */
function sameClaim(current, claimed) {
    return current.assignee === claimed.assignee && current.claimed_at === claimed.claimed_at;
}
/** Why a finished run has nothing to report: the agent reported via MCP, or someone else changed the task. */
function describeElsewhere(task, claimed) {
    const agentId = claimed.assignee;
    if (task.assignee && task.assignee !== agentId)
        return `reassigned to ${task.assignee} (status "${task.status}")`;
    if (task.status === 'working' && !sameClaim(task, claimed)) {
        return `task was claimed again${task.assignee_session ? ` by session ${task.assignee_session}` : ''} (a newer attempt owns it)`;
    }
    switch (task.status) {
        case 'completed':
        case 'failed':
        case 'rejected':
        case 'input_required':
            return task.assignee === agentId ? `the agent reported "${task.status}" via MCP` : `task is "${task.status}"`;
        case 'canceled':
            return 'task was canceled; the process was stopped';
        case 'queued':
            return task.assignee === agentId
                ? 'the question was answered; the task runs again with the answer'
                : 'task went back to the queue (lease expired, released, or the session holding it was closed)';
        default:
            return `task is "${task.status}"`;
    }
}
function signature(counts) {
    return `${counts.tasks}/${counts.messages}`;
}
function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function oneLine(text, max) {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
function clip(text, max) {
    return text.length <= max ? text : `${text.slice(0, max - 40)}\n… [${text.length - max + 40} more characters]`;
}
function tail(text, max) {
    const t = text.trim();
    return t.length <= max ? t : `…${t.slice(t.length - max)}`;
}
/** "--- stderr (tail) ---" (and stdout when asked) blocks for failure messages. */
function failureTails(outcome, includeStdout = true) {
    const parts = [];
    if (outcome.stderr.trim())
        parts.push(`\n--- stderr (last ${TAIL_CHARS} chars) ---\n${tail(outcome.stderr, TAIL_CHARS)}`);
    if (includeStdout && outcome.stdout.trim())
        parts.push(`\n--- stdout (last ${TAIL_CHARS} chars) ---\n${tail(outcome.stdout, TAIL_CHARS)}`);
    return parts.join('');
}
/** Keep the result within the store's limit; never empty. */
function clipResult(text, truncatedOutput) {
    const body = text.trim() || '(no output)';
    const note = truncatedOutput ? '\n… [output exceeded the runner capture limit and was truncated]' : '';
    const max = LIMITS.resultMax - 200;
    if (body.length + note.length <= max)
        return body + note;
    return `${body.slice(0, max)}\n… [${body.length - max} more characters truncated by the runner]`;
}
//# sourceMappingURL=worker.js.map