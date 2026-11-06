import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { escapeUntrusted } from '../mcp/format.js';
import { BruceError, sleep } from '../util.js';

/** Talks to the BruceControl helper over its unix socket (NDJSON, one request per connection). */
export interface HelperClient {
  request<T = any>(op: string, args?: object, opts?: HelperRequestOptions): Promise<T>;
}

export interface HelperRequestOptions {
  /** Agent the helper re-checks for action ops. */
  agent?: string;
  /** Per-request timeout (default 30 s; grant/unkill 120 s). */
  timeoutMs?: number;
  /** Do not launch the helper when it is not running (status probes, best-effort notifications). */
  noLaunch?: boolean;
}

export const DEFAULT_TIMEOUT_MS = 30_000;
export const AUTH_TIMEOUT_MS = 120_000;
/** How long to wait for a freshly launched helper to open its socket. */
const LAUNCH_WAIT_MS = 8_000;
/** Longest response line accepted (screenshots travel as base64). */
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;
const AUTH_OPS = new Set(['grant', 'unkill']);
/** macOS sun_path holds 104 bytes including the terminating NUL. */
export const MAX_SOCKET_PATH_BYTES = 103;
/** Longest helper error message passed on to an agent. */
const MESSAGE_MAX = 500;

export const BUILD_HINT = 'the owner: run `npm run build:helper` in the Bruce Comm folder';
export const QUIT_HINT = 'Quit BruceControl from its menu bar item (Quit); the next PC action starts it again for this Bruce Comm data folder.';

/** The socket Bruce Comm connects to: env BRUCE_PC_HELPER_SOCKET (tests) or <absolute home>/pc-control/helper.sock. */
export function helperSocketPath(home: string): string {
  return process.env.BRUCE_PC_HELPER_SOCKET || path.join(path.resolve(home), 'pc-control', 'helper.sock');
}

/** The socket BruceControl binds: always <realpath of home>/pc-control/helper.sock (it creates home first). */
function helperBindSocketPath(home: string): string {
  return path.join(canonicalPath(home), 'pc-control', 'helper.sock');
}

/**
 * A pc_helper_error when a socket path does not fit into macOS's sun_path: the one Bruce Comm connects to and, unless
 * BRUCE_PC_HELPER_SOCKET overrides it, the one BruceControl binds (symlinks resolved, e.g. /tmp -> /private/tmp).
 */
function socketPathTooLong(absHome: string, socketPath: string): BruceError | null {
  const override = Boolean(process.env.BRUCE_PC_HELPER_SOCKET);
  const bind = override ? socketPath : helperBindSocketPath(absHome);
  const longest = Buffer.byteLength(bind) > Buffer.byteLength(socketPath) ? bind : socketPath;
  const bytes = Buffer.byteLength(longest);
  if (bytes <= MAX_SOCKET_PATH_BYTES) return null;
  return new BruceError(
    'pc_helper_error',
    `The BruceControl socket path is too long (${bytes} bytes; macOS allows at most ${MAX_SOCKET_PATH_BYTES}): ${longest}`,
    override
      ? 'BRUCE_PC_HELPER_SOCKET (meant for tests) is too long: shorten or unset it.'
      : 'BruceControl always listens on <data folder>/pc-control/helper.sock (symlinks resolved): use a shorter Bruce Comm data folder (BRUCE_COMM_HOME or --home), e.g. ~/.bruce-comm.',
  );
}

/** The helper app bundle: env BRUCE_PC_HELPER_APP or ~/Applications/BruceControl.app. */
export function helperAppPath(): string {
  return process.env.BRUCE_PC_HELPER_APP || path.join(os.homedir(), 'Applications', 'BruceControl.app');
}

export function helperInstalled(): boolean {
  try {
    return fs.statSync(helperAppPath()).isDirectory();
  } catch {
    return false;
  }
}

/** Helper-supplied text (it may quote window titles or app names) made safe for an agent: one line, no wrapper look-alikes. */
export function cleanHelperText(text: string, max = MESSAGE_MAX): string {
  const line = text.replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').trim();
  return escapeUntrusted(line.length > max ? `${line.slice(0, max - 1)}…` : line);
}

/** Map a helper error reply to a BruceError the calling agent can act on. */
export function mapHelperError(code: unknown, message: unknown): BruceError {
  const text = typeof message === 'string' && message.trim() ? cleanHelperText(message) : 'The PC control helper refused the request.';
  switch (code) {
    case 'killed':
      return new BruceError('pc_killed', text, 'PC control is stopped by the kill switch; only the owner can re-enable it in the dashboard.');
    case 'not_allowed':
      return new BruceError('pc_not_allowed', text, 'the owner must switch this agent on in the Bruce Comm dashboard (PC control panel).');
    case 'permission_missing': {
      const which = /screen/i.test(text) ? 'Screen & System Audio Recording' : /accessib/i.test(text) ? 'Accessibility' : 'the named permission';
      return new BruceError(
        'pc_permission_missing',
        text,
        `the owner must grant BruceControl ${which === 'the named permission' ? which : `"${which}"`} in System Settings > Privacy & Security.`,
      );
    }
    case 'invalid_argument':
      return new BruceError('invalid_argument', text);
    case 'not_found':
      return new BruceError('not_found', text);
    case 'auth_failed':
    case 'auth_canceled':
      return new BruceError('pc_auth_failed', text, 'Owner authentication (Touch ID / password) failed or was canceled; nothing changed.');
    case 'busy':
      return new BruceError('pc_helper_busy', text, 'Finish (or cancel) the Touch ID prompt that is already open on this Mac, then try again.');
    default:
      return new BruceError('pc_helper_error', `${text}${typeof code === 'string' && code ? ` (${cleanHelperText(code, 40)})` : ''}`);
  }
}

/**
 * Absolute path with symlinks resolved, as realpath(3) gives it once the path exists: for a missing path the deepest
 * existing folder is resolved and the rest appended (/tmp/new -> /private/tmp/new on macOS), else path.resolve.
 */
export function canonicalPath(p: string): string {
  const abs = path.resolve(p);
  const rest: string[] = [];
  for (let dir = abs; ; ) {
    try {
      return path.join(fs.realpathSync.native(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return abs;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Check that a helper `status` (or `grants`) reply serves this Bruce Comm home and database. Returns a pc_helper_error
 * to throw on a mismatch, or null when both match.
 */
export function helperMismatch(status: unknown, home: string, dbPath: string): BruceError | null {
  const s = (status ?? {}) as Record<string, unknown>;
  if (typeof s.home !== 'string' || !s.home || typeof s.db !== 'string' || !s.db) {
    return new BruceError(
      'pc_helper_error',
      'The running BruceControl does not say which Bruce Comm data folder it serves (an outdated build).',
      `${BUILD_HINT}, then quit the running BruceControl from its menu bar item (Quit); the next PC action starts the new build.`,
    );
  }
  const theirHome = canonicalPath(s.home);
  const theirDb = canonicalPath(s.db);
  if (theirHome !== canonicalPath(home) || theirDb !== canonicalPath(dbPath)) {
    const where = cleanHelperText(theirHome, 300);
    const other = theirHome === canonicalPath(home) ? ` with another database (${cleanHelperText(theirDb, 300)})` : '';
    return new BruceError(
      'pc_helper_error',
      `BruceControl is running for another Bruce Comm data folder (${where})${other}; quit it from its menu bar.`,
      `This Bruce Comm uses ${canonicalPath(home)} (database ${canonicalPath(dbPath)}). ${QUIT_HINT}`,
    );
  }
  return null;
}

/**
 * Create a client for the helper of Bruce Comm home `home` with database `dbPath` (default <home>/bruce-comm.db). Both
 * are made absolute: a launched helper gets them as `--home` / `--db`.
 */
export function createHelperClient(home: string, dbPath?: string): HelperClient {
  const absHome = path.resolve(home);
  const absDb = path.resolve(dbPath ?? path.join(absHome, 'bruce-comm.db'));
  let launching: Promise<void> | undefined;

  /** Launch the helper once (concurrent callers share the launch). One BruceControl runs per macOS user. */
  const launch = (): Promise<void> => {
    launching ??= new Promise<void>((resolve, reject) => {
      const app = helperAppPath();
      execFile('/usr/bin/open', ['-g', '-j', '-a', app, '--args', '--home', absHome, '--db', absDb], { timeout: 15_000 }, (err) => {
        if (err) reject(new BruceError('pc_helper_error', `Could not launch the BruceControl helper (${app}): ${err.message}`));
        else resolve();
      });
    }).finally(() => {
      launching = undefined;
    });
    return launching;
  };

  return {
    async request<T = any>(op: string, args: object = {}, opts: HelperRequestOptions = {}): Promise<T> {
      if (process.platform !== 'darwin') {
        throw new BruceError('unsupported_platform', `PC control works on macOS only (this is ${process.platform}).`);
      }
      const socketPath = helperSocketPath(absHome);
      const tooLong = socketPathTooLong(absHome, socketPath);
      if (tooLong) throw tooLong;
      const timeoutMs = opts.timeoutMs ?? (AUTH_OPS.has(op) ? AUTH_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
      const id = randomUUID();
      const line = JSON.stringify({ id, op, ...(opts.agent ? { agent: opts.agent } : {}), args });
      try {
        return (await exchange(socketPath, id, line, timeoutMs)) as T;
      } catch (err) {
        if (!(err instanceof NotRunning)) throw err;
        if (opts.noLaunch || process.env.BRUCE_PC_HELPER_NO_LAUNCH === '1') {
          throw new BruceError('pc_helper_not_running', 'The BruceControl helper is not running.', notRunningHint());
        }
      }
      if (!helperInstalled()) {
        throw new BruceError('pc_helper_missing', `The BruceControl helper is not installed (${helperAppPath()}).`, BUILD_HINT);
      }
      await launch();
      const deadline = Date.now() + LAUNCH_WAIT_MS;
      for (;;) {
        try {
          return (await exchange(socketPath, id, line, timeoutMs)) as T;
        } catch (err) {
          if (!(err instanceof NotRunning)) throw err;
          if (Date.now() >= deadline) {
            // `open -a` only re-activates a BruceControl that already runs (one per macOS user), e.g. for another home.
            if (await helperProcessRunning()) {
              throw new BruceError(
                'pc_helper_error',
                `BruceControl is running, but not for this Bruce Comm data folder (${absHome}): it is probably serving another one.`,
                QUIT_HINT,
              );
            }
            throw new BruceError(
              'pc_helper_not_running',
              `BruceControl was launched but did not open its socket within ${LAUNCH_WAIT_MS / 1000} s.`,
              notRunningHint(),
            );
          }
          await sleep(250);
        }
      }
    },
  };
}

/** True when a BruceControl process runs for this macOS user (best effort; false when pgrep is unavailable). */
function helperProcessRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/pgrep', ['-x', '-U', String(process.getuid?.() ?? ''), 'BruceControl'], { timeout: 3_000 }, (err, stdout) => {
      resolve(!err && String(stdout).trim().length > 0);
    });
  });
}

function notRunningHint(): string {
  return helperInstalled()
    ? 'Start BruceControl (it lives in the menu bar) or let a pc_* action launch it.'
    : `The helper is not installed either - ${BUILD_HINT}.`;
}

/** The socket is missing or nobody listens: the helper is not running. */
class NotRunning extends Error {}

/** Send one request line and resolve with the matching response's result. */
function exchange(socketPath: string, id: string, line: string, timeoutMs: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let connected = false;
    let buffer = '';
    const socket = net.createConnection(socketPath);
    socket.setEncoding('utf8');
    const finish = (err: Error | null, value?: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(
      () => finish(new BruceError('pc_helper_timeout', `The BruceControl helper did not answer within ${Math.round(timeoutMs / 1000)} s.`, 'Retry; if it keeps happening, the owner should restart BruceControl from the menu bar.')),
      timeoutMs,
    );
    timer.unref?.();
    socket.on('connect', () => {
      connected = true;
      socket.write(`${line}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (!chunk.includes('\n')) {
        // Partial line (screenshots arrive in many chunks): wait for the rest.
        if (buffer.length > MAX_RESPONSE_BYTES) finish(new BruceError('pc_helper_error', 'The BruceControl helper response is too large.'));
        return;
      }
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const text = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (!text) continue;
        let msg: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: unknown; message?: unknown } };
        try {
          msg = JSON.parse(text);
        } catch {
          return finish(new BruceError('pc_helper_error', 'The BruceControl helper sent an unreadable response.'));
        }
        if (msg?.id !== id) continue; // not ours (should not happen on a one-request connection)
        if (msg.ok === true) return finish(null, msg.result ?? {});
        return finish(mapHelperError(msg.error?.code, msg.error?.message));
      }
      if (buffer.length > MAX_RESPONSE_BYTES) finish(new BruceError('pc_helper_error', 'The BruceControl helper response is too large.'));
    });
    socket.on('error', (err: NodeJS.ErrnoException) => {
      if (!connected && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'ENOTSOCK')) {
        return finish(new NotRunning(err.message));
      }
      finish(new BruceError('pc_helper_error', `Connection to the BruceControl helper failed: ${err.message}`));
    });
    socket.on('close', () => finish(new BruceError('pc_helper_error', 'The BruceControl helper closed the connection without answering.')));
  });
}
