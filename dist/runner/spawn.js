import { execFile, execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BruceError } from '../util.js';
/**
 * Windows-safe process launching for headless agent CLIs.
 *
 * Rules (verified on Windows 11 / Node 24, see the runner research notes):
 * - never `shell: true` - task text could be interpreted by cmd.exe (`&`, `%VAR%`, `^`, CRLF ...);
 * - `.cmd` / `.bat` shims cannot be spawned without a shell (ENOENT / EINVAL since CVE-2024-27980),
 *   so known shims (npm cmd-shim, VS Code `code.cmd`) are resolved to the real executable + script;
 *   unknown batch files are refused;
 * - kill the whole process tree on timeout (`taskkill /T /F`);
 * - a run ends when the CLI EXITS: a background process it left behind may hold the inherited stdout / stderr
 *   open for hours, so 'close' is only awaited for a short drain period (see runProcess);
 * - system tools (where.exe, taskkill.exe) are started by absolute System32 path: Windows looks in the current
 *   directory before PATH, so a bare name would run a where.exe planted in the folder the runner was started from.
 */
const IS_WINDOWS = process.platform === 'win32';
/** Default cap for captured stdout / stderr (each). */
export const MAX_CAPTURE_BYTES = 1024 * 1024;
/** After the CLI exited: how long to wait for its stdout / stderr to close before giving up on leftover holders. */
export const EXIT_DRAIN_MS = 2000;
/** After a kill: how long to wait for the process to exit before the run is ended anyway. */
export const KILL_SETTLE_MS = 5000;
/** Absolute path of a Windows system tool (never resolved through the current directory or PATH). */
export function system32(exe) {
    return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', exe);
}
/**
 * Resolve `command` (a name on PATH or a path) to a directly spawnable executable.
 * Throws a BruceError with a hint when it cannot be found or would need cmd.exe.
 */
export function resolveCommand(command) {
    const name = command.trim();
    if (!name)
        throw new BruceError('invalid_command', 'The runner command is empty.');
    const hasDir = path.isAbsolute(name) || /[\\/]/.test(name);
    if (hasDir) {
        const file = path.resolve(name);
        if (!fs.existsSync(file)) {
            throw new BruceError('command_not_found', `Command not found: ${file}`, 'Check the "command" path in runners.json.');
        }
        return resolveFile(file, `path ${file}`);
    }
    if (!IS_WINDOWS) {
        const found = findOnPosixPath(name);
        if (!found) {
            throw new BruceError('command_not_found', `"${name}" was not found on PATH.`, installHint(name));
        }
        return resolveFile(found, `PATH: ${found}`);
    }
    const hits = whereExe(name);
    if (!hits.length)
        throw new BruceError('command_not_found', `"${name}" was not found on PATH.`, installHint(name));
    const exe = hits.find((h) => /\.exe$/i.test(h));
    if (exe)
        return plain(exe, `PATH: ${exe}`);
    const shim = hits.find((h) => /\.(cmd|bat)$/i.test(h));
    if (shim)
        return resolveShim(shim);
    const script = hits.find((h) => /\.(js|mjs|cjs)$/i.test(h));
    if (script)
        return { ...plain(process.execPath, `PATH: ${script} (run with node)`), prefixArgs: [script] };
    throw new BruceError('unsupported_command', `"${name}" resolves to ${hits[0]}, which cannot be started without a shell.`, 'Point "command" at an .exe, a .js file or a known npm/VS Code shim.');
}
/** Resolve without throwing; returns the error message instead. */
export function tryResolveCommand(command) {
    try {
        return { resolved: resolveCommand(command) };
    }
    catch (err) {
        const e = err;
        return { error: e.hint ? `${e.message} ${e.hint}` : e.message };
    }
}
function plain(file, via) {
    return { file, prefixArgs: [], env: {}, unsetEnv: [], via };
}
/** An explicit file path: scripts run with this node, batch shims are parsed, everything else is spawned as-is. */
function resolveFile(file, via) {
    if (/\.(js|mjs|cjs)$/i.test(file))
        return { ...plain(process.execPath, `${via} (run with node)`), prefixArgs: [file] };
    if (IS_WINDOWS && /\.(cmd|bat)$/i.test(file))
        return resolveShim(file);
    return plain(file, via);
}
/**
 * PATH-only lookup with where.exe: `$PATH:` keeps the current directory out of the search for `name`, and where.exe
 * itself is started from System32 so a copy planted in the current directory never runs.
 */
function whereExe(name) {
    try {
        return execFileSync(system32('where.exe'), [`$PATH:${name}`], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
            .split(/\r?\n/)
            .map((s) => s.trim())
            .filter(Boolean);
    }
    catch {
        return [];
    }
}
function findOnPosixPath(name) {
    for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
        if (!dir)
            continue;
        const candidate = path.join(dir, name);
        try {
            fs.accessSync(candidate, fs.constants.X_OK);
            if (fs.statSync(candidate).isFile())
                return candidate;
        }
        catch {
            // keep looking
        }
    }
    return null;
}
/**
 * Turn a known .cmd shim into the program it would run. Supported:
 * npm cmd-shim -> JS entry (run with this node) or native exe; VS Code `code.cmd` -> Code.exe + cli.js
 * with ELECTRON_RUN_AS_NODE=1; a minimal `node "%~dp0\x.js" %*` shim.
 */
export function resolveShim(shim) {
    const dir = path.dirname(shim);
    let text;
    try {
        text = fs.readFileSync(shim, 'utf8');
    }
    catch (err) {
        throw new BruceError('command_not_found', `Cannot read ${shim}: ${err.message}`);
    }
    const via = `shim ${shim}`;
    let m = /"%dp0%\\([^"]+\.(?:js|cjs|mjs))"\s+%\*/i.exec(text);
    if (m) {
        const js = path.join(dir, m[1]);
        if (fs.existsSync(js))
            return { ...plain(process.execPath, `${via} -> node ${js}`), prefixArgs: [js] };
    }
    m = /"%dp0%\\([^"]+\.exe)"\s+%\*/i.exec(text);
    if (m) {
        const exe = path.join(dir, m[1]);
        if (fs.existsSync(exe))
            return plain(exe, `${via} -> ${exe}`);
    }
    m = /"%~dp0([^"]+\.exe)"\s+"%~dp0([^"]+cli\.js)"\s+%\*/i.exec(text);
    if (m) {
        const exe = path.resolve(dir, m[1]);
        const cli = path.resolve(dir, m[2]);
        if (fs.existsSync(exe) && fs.existsSync(cli)) {
            return {
                file: exe,
                prefixArgs: [cli],
                env: { ELECTRON_RUN_AS_NODE: '1' },
                unsetEnv: ['VSCODE_DEV'],
                via: `${via} -> ${exe} ${cli}`,
            };
        }
    }
    m = /node(?:\.exe)?"?\s+"%~dp0\\?([^"]+\.(?:js|cjs|mjs))"\s+%\*/i.exec(text);
    if (m) {
        const js = path.join(dir, m[1]);
        if (fs.existsSync(js))
            return { ...plain(process.execPath, `${via} -> node ${js}`), prefixArgs: [js] };
    }
    throw new BruceError('unsupported_command', `${shim} is a batch file this runner does not understand; refusing to run it through cmd.exe.`, 'Set "command" to the real .exe or .js file the batch file starts.');
}
function installHint(name) {
    const hints = {
        claude: 'Install Claude Code (https://code.claude.com) or set "command" to the absolute path of claude.exe.',
        copilot: 'Install GitHub Copilot CLI: npm install -g @github/copilot',
        gemini: 'Install Gemini CLI: npm install -g @google/gemini-cli',
        codex: 'Install Codex CLI: npm install -g @openai/codex',
        'cursor-agent': 'Install the Cursor CLI (https://cursor.com/docs/cli/installation); newer versions call it "agent".',
        code: 'Install VS Code and enable "Shell Command: Install code command in PATH".',
    };
    return hints[name] ?? 'Install it, add it to PATH, or set "command" to an absolute path.';
}
/**
 * Start a process without a shell, feed stdin, capture capped output and enforce a hard timeout.
 *
 * The run is over when the process EXITS. Its stdout / stderr usually close at the same moment, but a background
 * process it started (a dev server, a build daemon, `start /b ...`) inherits those pipes and can keep them open long
 * after: 'close' is awaited for at most EXIT_DRAIN_MS after 'exit', then the pipes are destroyed and the outcome is
 * resolved with what was captured and the real exit code. A timeout or kill whose process never exits (tree kill
 * failed) still resolves after KILL_SETTLE_MS. `timedOut` is only set when the timeout fired while the process ran.
 */
export function runProcess(options) {
    const started = Date.now();
    const max = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
    const env = {
        ...process.env,
        ...options.command.env,
        NO_COLOR: '1',
        FORCE_COLOR: '0',
        ...(options.env ?? {}),
    };
    for (const key of options.command.unsetEnv)
        delete env[key];
    const stdout = new HeadBuffer(max);
    const stderr = new TailBuffer(max);
    let timedOut = false;
    let killedReason;
    let finished = false;
    let child;
    try {
        child = spawn(options.command.file, [...options.command.prefixArgs, ...options.args], {
            cwd: options.cwd,
            env,
            shell: false,
            windowsHide: true,
            // POSIX: own process group so the whole tree can be killed with kill(-pid).
            detached: !IS_WINDOWS,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
    }
    catch (err) {
        const outcome = {
            exitCode: null,
            signal: null,
            timedOut: false,
            spawnError: err.message,
            stdout: '',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            durationMs: 0,
        };
        return { pid: undefined, kill: () => { }, done: Promise.resolve(outcome) };
    }
    /** Set by 'exit': the process is gone, only its pipes may still be open. */
    let exited = null;
    let settleTimer = null;
    let resolveDone;
    const done = new Promise((resolve) => (resolveDone = resolve));
    const finish = (exitCode, signal, spawnError) => {
        if (finished)
            return;
        finished = true;
        clearTimeout(timer);
        if (settleTimer)
            clearTimeout(settleTimer);
        resolveDone({
            exitCode,
            signal,
            timedOut,
            killedReason: timedOut ? 'timeout' : killedReason,
            spawnError,
            stdout: stdout.text(),
            stderr: stderr.text(),
            stdoutTruncated: stdout.truncated,
            stderrTruncated: stderr.truncated,
            durationMs: Date.now() - started,
            pid: child.pid,
        });
    };
    /** End the run in `ms` even if 'close' never comes: drop the pipes (a leftover holder may keep them open). */
    const settleIn = (ms) => {
        if (finished)
            return;
        if (settleTimer)
            clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
            child.stdout?.destroy();
            child.stderr?.destroy();
            finish(exited?.code ?? null, exited?.signal ?? null);
        }, ms);
    };
    const kill = (reason) => {
        // After 'exit' there is nothing left to stop: the outcome keeps the real exit and the drain timer ends the run.
        if (finished || exited)
            return;
        killedReason ??= reason;
        killTree(child);
        settleIn(KILL_SETTLE_MS);
    };
    const timer = setTimeout(() => {
        if (exited)
            return;
        timedOut = true;
        kill('timeout');
    }, Math.max(1, options.timeoutMs));
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    // Destroying a pipe that a leftover process still writes to must not surface as an error.
    child.stdout.on('error', () => { });
    child.stderr.on('error', () => { });
    child.stdin.on('error', () => {
        // EPIPE / ECONNRESET when the CLI never reads stdin - not an error for us.
    });
    child.stdin.end(options.stdinText ?? '', 'utf8');
    child.on('error', (err) => {
        // 'close' does not follow a failed spawn; after a successful spawn it still will.
        if (child.pid === undefined)
            finish(null, null, err.message);
    });
    child.on('exit', (code, signal) => {
        exited = { code, signal };
        clearTimeout(timer);
        settleIn(EXIT_DRAIN_MS);
    });
    child.on('close', (code, signal) => finish(code, signal));
    return { pid: child.pid, kill, done };
}
/** Whether a local process id is still running (EPERM: it exists but belongs to another user). */
export function processAlive(pid) {
    if (pid == null || !Number.isInteger(pid) || pid <= 0)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (err) {
        return err.code === 'EPERM';
    }
}
/** Kill a child and everything it started. Windows: taskkill /T /F. POSIX: the child's process group. */
export function killTree(child) {
    const pid = child.pid;
    if (pid === undefined)
        return;
    if (IS_WINDOWS) {
        execFile(system32('taskkill.exe'), ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, (err) => {
            // taskkill fails when the process already exited - fall back to a direct kill just in case.
            if (err) {
                try {
                    child.kill('SIGKILL');
                }
                catch {
                    // already gone
                }
            }
        });
        return;
    }
    try {
        process.kill(-pid, 'SIGKILL');
    }
    catch {
        try {
            child.kill('SIGKILL');
        }
        catch {
            // already gone
        }
    }
}
/** Keeps the first `max` bytes. */
class HeadBuffer {
    max;
    chunks = [];
    size = 0;
    truncated = false;
    constructor(max) {
        this.max = max;
    }
    push(chunk) {
        if (this.size >= this.max) {
            this.truncated = true;
            return;
        }
        const room = this.max - this.size;
        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
        if (part.length < chunk.length)
            this.truncated = true;
        this.chunks.push(part);
        this.size += part.length;
    }
    text() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}
/** Keeps the last `max` bytes (stderr: the tail holds the real error). */
class TailBuffer {
    max;
    chunks = [];
    size = 0;
    truncated = false;
    constructor(max) {
        this.max = max;
    }
    push(chunk) {
        this.chunks.push(chunk);
        this.size += chunk.length;
        while (this.size > this.max && this.chunks.length) {
            const first = this.chunks[0];
            const excess = this.size - this.max;
            this.truncated = true;
            if (first.length <= excess) {
                this.chunks.shift();
                this.size -= first.length;
            }
            else {
                this.chunks[0] = first.subarray(excess);
                this.size -= excess;
            }
        }
    }
    text() {
        return Buffer.concat(this.chunks).toString('utf8');
    }
}
//# sourceMappingURL=spawn.js.map