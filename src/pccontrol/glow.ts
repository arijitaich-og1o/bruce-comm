// GlowCursor bridge: tells the GlowCursor overlay (Oggy Neon, 127.0.0.1:<port>) which pc_* call runs and whether PC
// control is stopped, so the cursor can show it. Display only and best effort: every request is a short PUT with a
// 150 ms deadline, errors are swallowed and nothing here ever throws or delays a tool (except the screenshot duck,
// capped at 30 ms). Privacy: only tool, agent, call id, outcome and a small detail {button, clicks, direction, dx, dy,
// key, mods, chars (a count)} are sent - never typed text, URLs, app names or window titles. `key` is sent only for a
// shortcut (cmd / control / option / fn) or a named non-printing key, never for a key that types a character.
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { normalizeModifiers, parseKeyCombo, parseModifier, type Modifier } from './keys.js';

export const GLOW_DEFAULT_PORT = 47800;
/** Deadline of one request (a retry after 401 / a moved port shares it). */
export const GLOW_TIMEOUT_MS = 150;
/** Longest a pc_screenshot / pc_zoom waits for the cursor to duck. */
export const GLOW_SYNC_CAP_MS = 30;
/** TTL of one call on the cursor (a lost `end` clears itself). */
export const GLOW_CALL_TTL_MS = 15_000;
/** TTL of a kill push; the serve daemon re-pushes while engaged. */
export const GLOW_KILL_TTL_MS = 30_000;
export const GLOW_KILL_SYNC_MS = 250;
export const GLOW_KILL_REPUSH_MS = 10_000;
/** Tools whose begin waits (capped) until the neon is hidden, so captures show the plain arrow. */
export const GLOW_SYNC_TOOLS: ReadonlySet<string> = new Set(['pc_screenshot', 'pc_zoom']);
const GLOW_KILL_PATH = '/v1/overlay/kill';

export type GlowOutcome = 'ok' | 'refused' | 'error';

export interface GlowDetail {
  button?: 'left' | 'right' | 'middle';
  clicks?: number;
  direction?: 'up' | 'down' | 'left' | 'right';
  dx?: number;
  dy?: number;
  key?: string;
  mods?: string[];
  /** pc_type: number of characters (never the text). */
  chars?: number;
}

export interface GlowConfig {
  enabled: boolean;
  /** `$GLOWCURSOR_HOME` or ~/.glowcursor (holds `port` and `bridge.token`). */
  home: string;
}

/** One pc_* call on the cursor. */
export interface GlowCall {
  readonly callId: string;
  /** Resolves at once, or for a sync begin when the cursor answered or after 30 ms. Never rejects. */
  readonly ready: Promise<void>;
  /** Report the end (once; later calls are ignored). Never throws. */
  end(outcome: GlowOutcome, errorCode?: string): void;
}

export interface GlowKillSyncOptions {
  intervalMs?: number;
  repushMs?: number;
}

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);
const BUTTONS = new Set(['left', 'right', 'middle']);
const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);
/** GlowCursor rejects a longer detail.key with 400 (Control.swift: `x.string("key", max: 32, .text)`). */
const KEY_MAX = 32;
/** With one of these held, a key is a shortcut (it types no character), so its name may be shown. */
const SHORTCUT_MODS: ReadonlySet<Modifier> = new Set<Modifier>(['cmd', 'control', 'option', 'fn']);
/**
 * Named keys that type no character (keys.ts aliases -> the name sent). Any other key without a shortcut modifier
 * (letters, digits, punctuation, keypad digits; also with shift) may be one character of a secret: only mods are sent.
 */
const NAMED_KEYS: ReadonlyMap<string, string> = new Map<string, string>([
  ['return', 'return'], ['enter', 'enter'], ['kp_enter', 'enter'],
  ['tab', 'tab'],
  ['escape', 'escape'], ['esc', 'escape'],
  ['delete', 'delete'], ['backspace', 'delete'], ['forwarddelete', 'forwarddelete'], ['del', 'forwarddelete'],
  ['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'],
  ['arrowup', 'up'], ['arrowdown', 'down'], ['arrowleft', 'left'], ['arrowright', 'right'],
  ['home', 'home'], ['end', 'end'],
  ['pageup', 'pageup'], ['page_up', 'pageup'], ['prior', 'pageup'],
  ['pagedown', 'pagedown'], ['page_down', 'pagedown'], ['next', 'pagedown'],
  ['space', 'space'], ['spacebar', 'space'],
  ...Array.from({ length: 20 }, (_, i): [string, string] => [`f${i + 1}`, `f${i + 1}`]),
]);

function realHome(): string {
  return path.join(os.homedir(), '.glowcursor');
}

function samePath(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return path.resolve(a) === path.resolve(b) || real(a) === real(b);
}

/**
 * Bridge settings from the environment: off with BRUCE_GLOW=0; in test fixtures (BRUCE_TEST_FIXTURE=1) only with an
 * explicit GLOWCURSOR_HOME that is not the real ~/.glowcursor, so tests can never reach the real cursor.
 */
export function glowConfig(env: NodeJS.ProcessEnv = process.env): GlowConfig {
  return homeConfig(env, env.GLOWCURSOR_HOME, realHome());
}

function homeConfig(env: NodeJS.ProcessEnv, homeVar: string | undefined, real: string): { enabled: boolean; home: string } {
  const explicit = homeVar?.trim();
  const home = path.resolve(explicit || real);
  let enabled = !OFF_VALUES.has(String(env.BRUCE_GLOW ?? '').trim().toLowerCase());
  if (env.BRUCE_TEST_FIXTURE === '1' && (!explicit || samePath(home, real))) enabled = false;
  return { enabled, home };
}

/** The privacy-safe detail of a pc_* call: only the listed fields, typed text as a count. */
export function glowDetail(tool: string, args: unknown): GlowDetail {
  const a = args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const out: GlowDetail = {};
  if (typeof a.button === 'string' && BUTTONS.has(a.button)) out.button = a.button as GlowDetail['button'];
  if (typeof a.clicks === 'number' && Number.isInteger(a.clicks) && a.clicks >= 1 && a.clicks <= 3) out.clicks = a.clicks;
  if (typeof a.direction === 'string' && DIRECTIONS.has(a.direction)) out.direction = a.direction as GlowDetail['direction'];
  if (typeof a.dx === 'number' && Number.isFinite(a.dx)) out.dx = a.dx;
  if (typeof a.dy === 'number' && Number.isFinite(a.dy)) out.dy = a.dy;
  const combo = typeof a.keys === 'string' ? a.keys : typeof a.key === 'string' ? a.key : undefined;
  if (combo !== undefined) {
    const key = keyDetail(combo);
    if (key?.label !== undefined) out.key = key.label;
    if (key?.mods.length) out.mods = key.mods;
  }
  if (Array.isArray(a.modifiers) && a.modifiers.every((m) => typeof m === 'string')) {
    try {
      const mods = normalizeModifiers(a.modifiers as string[]);
      if (mods.length) out.mods = mods;
    } catch {
      // unknown modifier: the call fails anyway; send none
    }
  }
  if (tool === 'pc_type' && typeof a.text === 'string') out.chars = a.text.length;
  return out;
}

/**
 * The key part of a valid combo: canonical mods, plus the label ("cmd+shift+t", "shift+tab", "return") only for a
 * shortcut or a named non-printing key that fits KEY_MAX; otherwise mods only ("shift+a" -> mods ["shift"], "4" ->
 * nothing). Undefined for anything parseKeyCombo rejects (never echo free text).
 */
function keyDetail(combo: string): { label?: string; mods: Modifier[] } | undefined {
  try {
    const { modifiers } = parseKeyCombo(combo);
    const key = combo
      .trim()
      .split('+')
      .map((p) => p.trim().toLowerCase())
      .find((p) => {
        try {
          parseModifier(p);
          return false;
        } catch {
          return true;
        }
      });
    const mods = [...modifiers];
    if (!key) return { mods };
    const named = NAMED_KEYS.get(key);
    if (named === undefined && !modifiers.some((m) => SHORTCUT_MODS.has(m))) return { mods };
    const label = [...modifiers, named ?? key].join('+');
    return label.length <= KEY_MAX ? { label, mods } : { mods };
  } catch {
    return undefined;
  }
}

/** Short, safe token for error codes and "by" (letters, digits, _ - . only). */
function safeWord(value: string | undefined, fallback: string, max = 40): string {
  const v = String(value ?? '').trim();
  return /^[A-Za-z0-9_.-]+$/.test(v) && v.length <= max ? v : fallback;
}

function readTrim(file: string): string | undefined {
  try {
    const text = fs.readFileSync(file, 'utf8').trim();
    return text || undefined;
  } catch {
    return undefined;
  }
}

interface SendOptions {
  /** The caller awaits the result: keep the process alive until the deadline (CLI stop). */
  awaited?: boolean;
}

/** Outcome of one PUT: the HTTP status (null: no answer); `down` when the app is not there (no token, nothing listening). */
interface SendResult {
  status: number | null;
  down?: boolean;
}

/** Last kill push to a target (by setKilled or the daemon sync); `failed` once it got no 2xx and nothing newer was sent. */
interface KillPush {
  engaged: boolean;
  at: number;
  failed: boolean;
}

/** One app the bridge talks to: its own token, port, failure log line, kill order and last kill push. */
class BridgeTarget {
  token: string | undefined;
  port: number | undefined;
  failureLogged = false;
  killChain: Promise<unknown> = Promise.resolve();
  lastKill: KillPush | undefined;

  constructor(
    readonly label: string,
    readonly enabled: boolean,
    readonly home: string,
    readonly defaultPort: number,
    readonly killPath: string,
    /** Where the bridge token may be, in order. */
    readonly tokenFiles: readonly string[],
  ) {}

  /** The token of the first file that holds one. */
  readToken(): string | undefined {
    for (const file of this.tokenFiles) {
      const token = readTrim(file);
      if (token) return token;
    }
    return undefined;
  }

  /** After a 401: the first token on file that differs from `refused` (re-created, or the app uses the other file). */
  otherToken(refused: string): string | undefined {
    for (const file of this.tokenFiles) {
      const token = readTrim(file);
      if (token && token !== refused) return token;
    }
    return undefined;
  }
}

/** A push that landed (the app answered 2xx). */
function delivered(status: number | null): boolean {
  return status !== null && status >= 200 && status < 300;
}

/** Sends GlowCursor updates (pc_* calls, kill switch) for one Bruce Comm process. */
export class GlowBridge {
  /** GlowCursor (pc_* calls and the kill switch). */
  readonly enabled: boolean;
  readonly home: string;
  private readonly log: (message: string) => void;
  private readonly cursor: BridgeTarget;
  private readonly inFlight = new Set<Promise<unknown>>();

  constructor(options: { env?: NodeJS.ProcessEnv; log?: (message: string) => void } = {}) {
    const env = options.env ?? process.env;
    const cfg = glowConfig(env);
    this.enabled = cfg.enabled;
    this.home = cfg.home;
    this.cursor = new BridgeTarget('glowcursor bridge', cfg.enabled, cfg.home, GLOW_DEFAULT_PORT, GLOW_KILL_PATH, [path.join(cfg.home, 'bridge.token')]);
    this.log = options.log ?? (() => {});
  }

  /** Report a call that passed authorization. pc_screenshot / pc_zoom are sync: `ready` waits (<= 30 ms) for the duck. */
  begin(tool: string, agent: string, args: unknown): GlowCall {
    const callId = randomUUID();
    if (!this.enabled) return { callId, ready: Promise.resolve(), end: () => {} };
    const detail = glowDetail(tool, args);
    const sync = GLOW_SYNC_TOOLS.has(tool);
    const base = { call_id: callId, tool, agent: agent.slice(0, 100), detail };
    const begun = this.send(this.cursor, '/v1/action', { phase: 'begin', ...base, sync, ttl_ms: GLOW_CALL_TTL_MS }, { awaited: sync });
    let ended = false;
    return {
      callId,
      ready: sync ? capped(begun, GLOW_SYNC_CAP_MS) : Promise.resolve(),
      end: (outcome, errorCode) => {
        if (ended) return;
        ended = true;
        const body = { phase: 'end', ...base, ok: outcome === 'ok', outcome, ...endCode(outcome, errorCode), sync: false };
        // After the begin settled, so GlowCursor always sees begin before end.
        this.track(begun.then(() => this.send(this.cursor, '/v1/action', body)));
      },
    };
  }

  /** A call refused before it began: a single end (ok:false, outcome refused). */
  refused(tool: string, agent: string, args: unknown, errorCode?: string): void {
    if (!this.enabled) return;
    const body = {
      phase: 'end',
      call_id: randomUUID(),
      tool,
      agent: agent.slice(0, 100),
      ok: false,
      outcome: 'refused',
      error_code: safeWord(errorCode, 'refused'),
      detail: glowDetail(tool, args),
      sync: false,
    };
    void this.send(this.cursor, '/v1/action', body);
  }

  /**
   * Push the kill switch state to GlowCursor (in push order). Resolves within ~150 ms; never rejects.
   */
  pushKill(engaged: boolean, by = 'bruce-comm', options: SendOptions = { awaited: true }): Promise<void> {
    const targets = this.killTargets();
    if (!targets.length) return Promise.resolve();
    return Promise.all(targets.map((t) => this.pushKillTo(t, engaged, by, options))).then(() => undefined);
  }

  /**
   * Serve daemon: push the current state once to every target, then every 250 ms compare `read()` with the state last
   * pushed to each; push on change, on the next tick after a push that got no 2xx (app down, hanging, refusing or
   * restarted; a release is not resent to an app that is not running, which starts released), and every 10 s while
   * engaged (the kill TTL is 30 s). A target whose push is still in flight is skipped, so a slow or failing one never
   * holds up the other. Returns stop().
   */
  startKillSync(read: () => { killed: boolean; by?: string }, options: GlowKillSyncOptions = {}): () => void {
    const targets = this.killTargets();
    if (!targets.length) return () => {};
    const repushMs = options.repushMs ?? GLOW_KILL_REPUSH_MS;
    const busy = new Set<BridgeTarget>();
    const unsent = new Set(targets);
    const tick = () => {
      if (busy.size === targets.length) return;
      let state: { killed: boolean; by?: string };
      try {
        state = read();
      } catch {
        return; // database closed or busy: try again next tick
      }
      for (const t of targets) {
        if (busy.has(t)) continue;
        const last = t.lastKill;
        const due = unsent.has(t) || !last || last.failed || last.engaged !== state.killed || (state.killed && Date.now() - last.at >= repushMs);
        if (!due) continue;
        unsent.delete(t);
        busy.add(t);
        void this.pushKillTo(t, state.killed, state.by, { awaited: false }).finally(() => busy.delete(t));
      }
    };
    const timer = setInterval(tick, options.intervalMs ?? GLOW_KILL_SYNC_MS);
    timer.unref();
    tick();
    return () => clearInterval(timer);
  }

  /** Resolves when every request sent so far has settled (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inFlight.size) await Promise.allSettled([...this.inFlight]);
  }

  private killTargets(): BridgeTarget[] {
    return [this.cursor].filter((t) => t.enabled);
  }

  private pushKillTo(t: BridgeTarget, engaged: boolean, by: string | undefined, options: SendOptions): Promise<void> {
    const push: KillPush = { engaged, at: Date.now(), failed: false };
    t.lastKill = push;
    const body = { engaged, by: safeWord(by, 'bruce-comm'), ttl_ms: GLOW_KILL_TTL_MS };
    const next = t.killChain.then(() => this.send(t, t.killPath, body, options));
    t.killChain = next;
    return next.then((res) => {
      // Not landed: the daemon sync resends on its next tick, unless a newer push took its place or a release found
      // no app running (it starts released; resending would only knock on its port every tick).
      if (!delivered(res.status) && (engaged || !res.down) && t.lastKill === push) push.failed = true;
    });
  }

  private track<T>(p: Promise<T>): Promise<T> {
    this.inFlight.add(p);
    void p.finally(() => this.inFlight.delete(p));
    return p;
  }

  /** PUT `body`; never rejects. One retry (same deadline) after a 401 or a moved port. */
  private send(t: BridgeTarget, urlPath: string, body: object, options: SendOptions = {}): Promise<SendResult> {
    return this.track(this.sendNow(t, urlPath, JSON.stringify(body), options));
  }

  private async sendNow(t: BridgeTarget, urlPath: string, json: string, options: SendOptions): Promise<SendResult> {
    try {
      const deadline = Date.now() + GLOW_TIMEOUT_MS;
      let retried = false;
      for (;;) {
        const token = (t.token ??= t.readToken());
        if (!token) {
          this.failed(t, `no bridge token in ${t.tokenFiles.join(' or ')}`);
          return { status: null, down: true };
        }
        const port = (t.port ??= readPort(t.home, t.defaultPort));
        const res = await put(port, urlPath, json, token, deadline - Date.now(), options.awaited === true);
        if (!retried && res.status === 401) {
          // Token re-created, or the app accepts the other file: resend once with a different token on file.
          const other = t.otherToken(token);
          t.token = other ?? t.readToken();
          if (other && Date.now() < deadline) {
            retried = true;
            continue;
          }
        }
        if (!retried && res.error === 'ECONNREFUSED') {
          // The app may have moved: re-read the port file and resend when it changed.
          t.port = readPort(t.home, t.defaultPort);
          if (t.port !== port && Date.now() < deadline) {
            retried = true;
            continue;
          }
        }
        if (res.status === null || res.status >= 300) this.failed(t, res.status === null ? `${res.error} on port ${port}` : `HTTP ${res.status} for ${urlPath}`);
        return res.error === 'ECONNREFUSED' ? { status: null, down: true } : { status: res.status };
      }
    } catch {
      return { status: null };
    }
  }

  private failed(t: BridgeTarget, reason: string): void {
    if (t.failureLogged) return;
    t.failureLogged = true;
    try {
      this.log(`${t.label}: ${reason} (display only; later failures are not logged)`);
    } catch {
      // logging is best effort too
    }
  }
}

function endCode(outcome: GlowOutcome, errorCode: string | undefined): { error_code?: string } {
  return outcome === 'ok' ? {} : { error_code: safeWord(errorCode, outcome) };
}

function readPort(home: string, fallback: number): number {
  const n = Number(readTrim(path.join(home, 'port')));
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

/** Wait for `p` at most `ms` (the request itself keeps its own deadline). */
function capped(p: Promise<unknown>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void p.finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** One PUT to 127.0.0.1:<port>; never rejects. The socket is unref'd; the deadline timer only keeps an awaited call alive. */
function put(port: number, urlPath: string, json: string, token: string, timeoutMs: number, keepAlive: boolean): Promise<{ status: number | null; error?: string }> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (status: number | null, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(error ? { status, error } : { status });
    };
    let req: http.ClientRequest;
    try {
      req = http.request({
        host: '127.0.0.1',
        port,
        method: 'PUT',
        path: urlPath,
        agent: false,
        headers: {
          Host: `127.0.0.1:${port}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(json),
          Authorization: `Bearer ${token}`,
        },
      });
    } catch (err) {
      resolve({ status: null, error: (err as NodeJS.ErrnoException).code ?? 'request_failed' });
      return;
    }
    const timer = setTimeout(() => {
      finish(null, 'timeout');
      req.destroy();
    }, Math.max(1, timeoutMs));
    if (!keepAlive) timer.unref();
    req.on('socket', (socket) => socket.unref());
    req.on('response', (res) => {
      res.resume();
      res.on('error', () => {});
      finish(res.statusCode ?? null);
    });
    req.on('error', (err: NodeJS.ErrnoException) => finish(null, err.code ?? 'request_failed'));
    req.end(json);
  });
}
