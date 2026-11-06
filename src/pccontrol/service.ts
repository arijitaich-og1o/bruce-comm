import type { BruceContext } from '../context.js';
import type { ToolReply } from '../mcp/runtime.js';
import type { SessionState } from '../mcp/server.js';
import { BruceError, sleep } from '../util.js';
import type { DisplayInfo } from './geometry.js';
import { GlowBridge, glowConfig, type GlowKillSyncOptions } from './glow.js';
import { AUTH_TIMEOUT_MS, canonicalPath, createHelperClient, helperAppPath, helperInstalled, helperMismatch, type HelperClient } from './helper-client.js';
import { PcControlStore, type PcKillState, type PcLogRow, type PcOutcome } from './store.js';

/** The helper's global kill hotkey. */
export const HOTKEY = 'ctrl+option+cmd+k';
export const THUMB_WIDTH = 480;
export const THUMB_QUALITY = 0.6;
/** Let the screen settle after an action before capturing it. */
export const SETTLE_MS = 300;
/** pc_type text longer than this is truncated in the log. */
const LOG_TEXT_MAX = 500;
/** Short timeout for status probes (never launch the helper). */
const PROBE_TIMEOUT_MS = 3_000;
/** Kill / revoke notifications may launch the helper; the caller waits at most this long for the answer. */
export const NOTIFY_TIMEOUT_MS = 10_000;
/** How long a successful check that the helper serves this home and database is trusted. */
const VERIFY_TTL_MS = 10_000;
/** Shown when a stop or switch-off could not be delivered to the helper. */
export const NOT_TOLD_NOTE = 'BruceControl was not told; it will apply the stop when it next starts.';

/** Who an authorized call acts as. */
export interface PcAuth {
  agentId: string;
}

/** What a pc_* tool body returns to {@link PcControlService.runTool}. */
export interface PcToolOutcome {
  reply: ToolReply;
  /** One-line summary for the action log. */
  summary: string;
  /** Base64 thumbnail already captured with the call (pc_screenshot, pc_zoom, screenshot_after). */
  thumbnail?: string;
  /** Display to capture a thumbnail of after the action, when `thumbnail` is not given. */
  thumbnailDisplay?: DisplayInfo;
}

/** Helper state for the dashboard / pc_status. */
export interface PcHelperStatus {
  reachable: boolean;
  installed: boolean;
  app_path: string;
  version?: string;
  pid?: number;
  /** Kill flag in BruceControl's Keychain state. */
  killed?: boolean;
  accessibility?: boolean;
  screen_recording?: boolean;
  hotkey_registered?: boolean;
  /** False when BruceControl could not read its Keychain state (it then refuses everything); null while it loads. */
  signature_ok?: boolean | null;
  /** The helper is still loading its state. */
  state_loading?: boolean;
  /** Bruce Comm data folder and database the running helper serves. */
  home?: string;
  db?: string;
  /** True when the running helper serves another data folder or database (it is then not used). */
  mismatch?: boolean;
  /** Agents granted in BruceControl's Keychain state (each approved with Touch ID); unset when unknown (not running, mismatch). */
  granted_agents?: string[];
  error?: string;
}

export interface PcAgentStatus {
  agent_id: string;
  name: string | null;
  platform: string | null;
  /** False for an allowlist row whose agent was unregistered meanwhile. */
  registered: boolean;
  enabled: boolean;
  /** Granted in BruceControl's Keychain state (approved with Touch ID); null when the helper could not be asked. */
  granted: boolean | null;
  updated_at: number | null;
  updated_by: string | null;
}

/** Shape of {@link PcControlService.status}. */
export interface PcStatus {
  platform_supported: boolean;
  killed: boolean;
  killed_updated_at: number | null;
  killed_updated_by: string | null;
  /** Set when this process engaged the kill switch but could not write it to the database. */
  kill_db_error?: string;
  /** Data folder and database of this Bruce Comm. */
  home: string;
  db: string;
  hotkey: string;
  helper: PcHelperStatus;
  agents: PcAgentStatus[];
  log_total: number;
}

/** Result of a kill / switch-off that the helper may or may not have received. */
export interface PcNotifyResult {
  /** The helper confirmed the change. */
  helper_notified: boolean;
  helper_error?: string;
  /** The database could not be written (the change then lives only in this process and, when told, in the helper). */
  db_error?: string;
}

/** A stop engaged by this process (kept in memory, so it holds even when the database write failed). */
interface MemoryKill {
  at: number;
  by: string;
  dbError?: string;
}

/** PC control for one BruceContext: policy (identity, allowlist, kill switch), helper access and the action log. */
export class PcControlService {
  readonly store: PcControlStore;
  /** The platform PC control runs on (a test seam; PC control works on macOS only). */
  platform: NodeJS.Platform = process.platform;
  private helperClient: HelperClient;
  private readonly displayMemory = new WeakMap<SessionState, number>();
  private memoryKill: MemoryKill | null = null;
  private verifiedAt = 0;
  private readonly background = new Set<Promise<void>>();
  /** GlowCursor display bridge (a test seam: replace it to point at a fake cursor). */
  glow: GlowBridge;

  constructor(
    readonly ctx: BruceContext,
    helper?: HelperClient,
  ) {
    this.store = new PcControlStore(ctx.store.db, ctx.config.home);
    this.helperClient = helper ?? createHelperClient(ctx.config.home, ctx.config.dbPath);
    this.glow = new GlowBridge({ log: (message) => this.ctx.log(message) });
  }

  get helper(): HelperClient {
    return this.helperClient;
  }

  setHelperClient(client: HelperClient): void {
    this.helperClient = client;
    this.verifiedAt = 0;
  }

  // ---------------------------------------------------------------- policy

  /** The identity the client configuration pre-bound, or undefined. pc_* tools never take agent_id. */
  configuredAgent(session: SessionState): string | undefined {
    return session.preBound ? session.configuredAgentId || undefined : undefined;
  }

  /**
   * The kill switch as this process sees it: the database, plus a stop engaged here whose database write failed. A
   * release recorded in the database after that stop (Touch ID in another process or the helper menu) lifts it.
   */
  killState(): PcKillState & { db_error?: string } {
    const db = this.store.isKilled();
    const m = this.memoryKill;
    if (db.killed || !m) return db;
    if (db.updated_at !== undefined && db.updated_at > m.at) {
      this.memoryKill = null;
      return db;
    }
    return { killed: true, updated_at: m.at, updated_by: m.by, ...(m.dbError ? { db_error: m.dbError } : {}) };
  }

  /**
   * Check platform, identity, runner session, registration, kill switch and allowlist; throws unsupported_platform /
   * pc_control_refused / pc_killed / pc_not_allowed.
   */
  authorize(session: SessionState): PcAuth {
    if (this.platform !== 'darwin') {
      throw new BruceError(
        'unsupported_platform',
        `PC control works on macOS only (this Bruce Comm runs on ${this.platform}).`,
        'Nobody can switch it on here; use another way to do the job.',
      );
    }
    const agentId = this.configuredAgent(session);
    if (!agentId) {
      throw new BruceError(
        'pc_control_refused',
        'PC control needs an agent identity configured by the client (pre-bound); this session has none.',
        'Configure BRUCE_AGENT_ID (stdio, or --agent-id) or ?agent=<id> / X-Bruce-Agent (HTTP /mcp) for this client and reconnect. ' +
          'the owner must also switch that agent on in the Bruce Comm dashboard (PC control panel).',
      );
    }
    if (session.runnerTask) {
      throw new BruceError(
        'pc_control_refused',
        `PC control is not available in unattended runner sessions (this session runs task ${session.runnerTask}).`,
        'Report back that the job needs PC control; an attended window of the agent (not a runner) can use the pc_* tools.',
      );
    }
    if (!this.ctx.store.getAgent(agentId)) {
      throw new BruceError(
        'pc_control_refused',
        `Agent "${agentId}" (configured for this client) is not registered.`,
        `Call register_agent with agent_id="${agentId}" first; then the owner must switch it on in the Bruce Comm dashboard (PC control panel).`,
      );
    }
    if (this.killState().killed) {
      throw new BruceError(
        'pc_killed',
        'PC control is stopped (kill switch engaged).',
        'PC control is stopped by the kill switch; only the owner can re-enable it in the dashboard.',
      );
    }
    if (!this.store.isEnabled(agentId)) {
      throw new BruceError(
        'pc_not_allowed',
        `PC control is off for agent "${agentId}".`,
        `the owner must switch agent ${agentId} on in the Bruce Comm dashboard (PC control panel).`,
      );
    }
    return { agentId };
  }

  /**
   * Make sure the helper answering on our socket serves this home and database (launches it when needed). A
   * successful check is trusted for a few seconds.
   */
  async verifyHelper(): Promise<void> {
    if (Date.now() - this.verifiedAt < VERIFY_TTL_MS) return;
    const status = await this.helperClient.request<Record<string, unknown>>('status', {}, { timeoutMs: NOTIFY_TIMEOUT_MS });
    const mismatch = helperMismatch(status, this.ctx.config.home, this.ctx.config.dbPath);
    if (mismatch) throw mismatch;
    this.verifiedAt = Date.now();
  }

  /**
   * Run one pc_* tool: authorize, check the helper, run `body`, log the call (ok / refused / error) and capture a
   * thumbnail in the background. Logging and thumbnails are best effort and never fail or delay the call.
   */
  async runTool(
    tool: string,
    session: SessionState,
    sessionId: string | undefined,
    args: unknown,
    body: (auth: PcAuth) => Promise<PcToolOutcome>,
  ): Promise<ToolReply> {
    const started = Date.now();
    const base = { tool, session_id: sessionId ?? session.bruceSessionId ?? null, args: logArgs(args, session.runnerTask), at: started };
    let auth: PcAuth;
    try {
      auth = this.authorize(session);
    } catch (err) {
      this.addLog({ ...base, agent_id: this.configuredAgent(session) ?? null, outcome: 'refused', result: errorText(err), duration_ms: Date.now() - started });
      this.glow.refused(tool, this.configuredAgent(session) ?? 'unknown', args, err instanceof BruceError ? err.code : undefined);
      throw err;
    }
    // GlowCursor: begin now (pc_screenshot / pc_zoom wait <= 30 ms for the duck), end below. Never throws.
    const glow = this.glow.begin(tool, auth.agentId, args);
    await glow.ready;
    let outcome: PcToolOutcome;
    try {
      await this.verifyHelper();
      outcome = await body(auth);
    } catch (err) {
      const code = err instanceof BruceError ? err.code : '';
      if (code.startsWith('pc_helper_')) this.verifiedAt = 0;
      const kind: PcOutcome = code === 'pc_killed' || code === 'pc_not_allowed' ? 'refused' : 'error';
      glow.end(kind, code || 'internal_error');
      this.addLog({ ...base, agent_id: auth.agentId, outcome: kind, result: errorText(err), duration_ms: Date.now() - started });
      throw err;
    }
    glow.end('ok');
    const logId = this.addLog({ ...base, agent_id: auth.agentId, outcome: 'ok', result: outcome.summary, duration_ms: Date.now() - started });
    if (logId !== null) this.inBackground(this.attachThumbnail(logId, auth.agentId, outcome));
    return outcome.reply;
  }

  /** Resolves when every background thumbnail capture has finished (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled([...this.background]);
  }

  private inBackground(job: Promise<void>): void {
    this.background.add(job);
    void job.finally(() => this.background.delete(job));
  }

  private addLog(entry: Parameters<PcControlStore['addLog']>[0]): number | null {
    try {
      return this.store.addLog(entry);
    } catch (err) {
      this.ctx.log(`pc-control: could not log ${entry.tool}: ${(err as Error).message}`);
      return null;
    }
  }

  /** Never rejects. Captures with noLaunch: a thumbnail must never start the helper. */
  private async attachThumbnail(logId: number, agentId: string, outcome: PcToolOutcome): Promise<void> {
    try {
      let data = outcome.thumbnail;
      const display = outcome.thumbnailDisplay;
      if (!data && display) {
        await sleep(SETTLE_MS);
        const width = Math.max(1, Math.min(THUMB_WIDTH, display.pixel_width));
        const height = Math.max(1, Math.round((width * display.frame.height) / display.frame.width));
        const res = await this.helperClient.request<{ data?: unknown }>(
          'screenshot',
          { display_id: display.id, width, height, format: 'jpeg', jpeg_quality: THUMB_QUALITY, max_bytes: 400_000, show_cursor: true },
          { agent: agentId, noLaunch: true, timeoutMs: 5_000 },
        );
        if (typeof res?.data === 'string') data = res.data;
      }
      if (data) this.store.saveThumbnail(logId, Buffer.from(data, 'base64'));
    } catch (err) {
      this.ctx.log(`pc-control: no thumbnail for log ${logId}: ${(err as Error).message}`);
    }
  }

  // ---------------------------------------------------------------- displays

  /** The helper's display list (main first, index = position). */
  async displays(): Promise<DisplayInfo[]> {
    const res = await this.helperClient.request<{ displays?: unknown }>('displays', {}, { timeoutMs: 10_000 });
    return parseDisplays(res?.displays);
  }

  /** Display `index` of `displays` (validated) or the session's remembered display (default main). */
  pickDisplay(displays: DisplayInfo[], session: SessionState, index?: number): DisplayInfo {
    if (index !== undefined) {
      const d = displays[index];
      if (!d || !Number.isInteger(index)) {
        throw new BruceError(
          'invalid_argument',
          `Display ${index} does not exist (${displays.length} display(s) connected).`,
          `Use display 0${displays.length > 1 ? `..${displays.length - 1}` : ''} (0 = main; see pc_status or the pc_screenshot reply).`,
        );
      }
      return d;
    }
    const remembered = this.displayMemory.get(session);
    return displays.find((d) => d.id === remembered) ?? displays.find((d) => d.main) ?? displays[0]!;
  }

  /** Display `index` (validated against the helper's list) or the session's remembered display (default main). */
  async resolveDisplay(session: SessionState, index?: number): Promise<DisplayInfo> {
    return this.pickDisplay(await this.displays(), session, index);
  }

  /** Like resolveDisplay(session) but never throws (for thumbnails of keyboard actions). */
  async affectedDisplay(session: SessionState): Promise<DisplayInfo | undefined> {
    try {
      return await this.resolveDisplay(session);
    } catch {
      return undefined;
    }
  }

  /** Remember the display of the session's last screenshot. */
  rememberDisplay(session: SessionState, display: DisplayInfo): void {
    this.displayMemory.set(session, display.id);
  }

  rememberedDisplayId(session: SessionState): number | undefined {
    return this.displayMemory.get(session);
  }

  // ---------------------------------------------------------------- dashboard / CLI

  /** Probe the helper without launching it; flags a helper that serves another data folder or database. */
  async helperStatus(): Promise<PcHelperStatus> {
    const out: PcHelperStatus = { reachable: false, installed: helperInstalled(), app_path: helperAppPath() };
    if (this.platform !== 'darwin') {
      out.error = `PC control works on macOS only (this is ${this.platform}).`;
      return out;
    }
    let s: Record<string, unknown>;
    try {
      s = (await this.helperClient.request<Record<string, unknown>>('status', {}, { noLaunch: true, timeoutMs: PROBE_TIMEOUT_MS })) ?? {};
    } catch (err) {
      out.error = errorText(err);
      return out;
    }
    out.reachable = true;
    if (typeof s.version === 'string') out.version = s.version;
    if (typeof s.pid === 'number') out.pid = s.pid;
    if (typeof s.killed === 'boolean') out.killed = s.killed;
    if (typeof s.accessibility === 'boolean') out.accessibility = s.accessibility;
    if (typeof s.screen_recording === 'boolean') out.screen_recording = s.screen_recording;
    if (typeof s.hotkey_registered === 'boolean') out.hotkey_registered = s.hotkey_registered;
    if (typeof s.state_loading === 'boolean') out.state_loading = s.state_loading;
    if (typeof s.signature_ok === 'boolean' || s.signature_ok === null) out.signature_ok = s.signature_ok;
    if (typeof s.home === 'string') out.home = s.home;
    if (typeof s.db === 'string') out.db = s.db;
    const mismatch = helperMismatch(s, this.ctx.config.home, this.ctx.config.dbPath);
    if (mismatch) {
      // Its kill flag and grants belong to another data folder: do not show them as ours.
      out.mismatch = true;
      out.error = `${mismatch.message} ${mismatch.hint ?? ''}`.trim();
      delete out.killed;
      return out;
    }
    try {
      const g = await this.helperClient.request<Record<string, unknown>>('grants', {}, { noLaunch: true, timeoutMs: PROBE_TIMEOUT_MS });
      if (typeof g?.signature_ok === 'boolean' || g?.signature_ok === null) out.signature_ok = g.signature_ok as boolean | null;
      if (typeof g?.state_loading === 'boolean') out.state_loading = g.state_loading;
      if (Array.isArray(g?.agents)) out.granted_agents = g.agents.filter((a): a is string => typeof a === 'string');
    } catch (err) {
      out.error = errorText(err);
    }
    return out;
  }

  /** Everything the dashboard's PC control panel shows (except the log rows). */
  async status(): Promise<PcStatus> {
    const kill = this.killState();
    const helper = await this.helperStatus();
    const granted = helper.granted_agents ? new Set(helper.granted_agents) : null;
    const rows = new Map(this.store.listAgents().map((r) => [r.agent_id, r]));
    const agents: PcAgentStatus[] = this.ctx.store.listAgents().map((a) => {
      const row = rows.get(a.id);
      rows.delete(a.id);
      return {
        agent_id: a.id,
        name: a.name,
        platform: a.platform,
        registered: true,
        enabled: row?.enabled ?? false,
        granted: granted ? granted.has(a.id) : null,
        updated_at: row?.updated_at ?? null,
        updated_by: row?.updated_by ?? null,
      };
    });
    // Allowlisted agents that were unregistered meanwhile stay visible so the owner can switch them off.
    for (const row of rows.values()) {
      if (!row.enabled) continue;
      agents.push({
        agent_id: row.agent_id,
        name: null,
        platform: null,
        registered: false,
        enabled: true,
        granted: granted ? granted.has(row.agent_id) : null,
        updated_at: row.updated_at,
        updated_by: row.updated_by,
      });
    }
    return {
      platform_supported: this.platform === 'darwin',
      killed: kill.killed,
      killed_updated_at: kill.updated_at ?? null,
      killed_updated_by: kill.updated_by ?? null,
      ...(kill.db_error ? { kill_db_error: kill.db_error } : {}),
      home: canonicalPath(this.ctx.config.home),
      db: canonicalPath(this.ctx.config.dbPath),
      hotkey: HOTKEY,
      helper,
      agents,
      log_total: this.store.countLog(),
    };
  }

  /**
   * Send a stop-type notification (`kill`, `revoke`) to the helper, launching it when needed. Waits at most
   * {@link NOTIFY_TIMEOUT_MS}; a slower request keeps going in the background. Never throws.
   */
  private async notifyHelper(op: 'kill' | 'revoke', args: object): Promise<PcNotifyResult> {
    let timer: NodeJS.Timeout | undefined;
    const request = this.helperClient.request(op, args, { timeoutMs: NOTIFY_TIMEOUT_MS }).then(
      (): PcNotifyResult => ({ helper_notified: true }),
      (err: unknown): PcNotifyResult => ({ helper_notified: false, helper_error: errorText(err) }),
    );
    const late = new Promise<PcNotifyResult>((resolve) => {
      timer = setTimeout(
        () => resolve({ helper_notified: false, helper_error: `no answer within ${NOTIFY_TIMEOUT_MS / 1000} s (still trying in the background)` }),
        NOTIFY_TIMEOUT_MS,
      );
      timer.unref?.();
    });
    try {
      return await Promise.race([request, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Switch an agent on (owner auth via the helper's Touch ID `grant`, then DB) or off (DB, then helper `revoke`, which
   * may launch the helper; the helper is told even when the DB write fails). Throws unknown_agent for an agent that is
   * neither registered nor allowlisted, and pc_stop_failed when switching off reached neither the DB nor the helper.
   */
  async setAgentEnabled(agentId: string, enabled: boolean, by = 'human'): Promise<{ agent_id: string; enabled: boolean } & Partial<PcNotifyResult>> {
    const id = String(agentId ?? '').trim().toLowerCase();
    const registered = id ? this.ctx.store.getAgent(id) !== undefined : false;
    if (!registered && !(id && !enabled && this.store.listAgents().some((r) => r.agent_id === id))) {
      throw new BruceError('unknown_agent', `No agent registered with id "${id}".`, 'Only registered agents can be switched on.');
    }
    if (enabled) {
      // Only a helper serving this data folder and database may record the grant; it builds the Touch ID text itself.
      await this.verifyHelper();
      await this.helperClient.request('grant', { agent: id }, { timeoutMs: AUTH_TIMEOUT_MS });
      this.store.setEnabled(id, true, by);
      this.ctx.log(`pc-control: agent ${id} switched ON by ${by}`);
      return { agent_id: id, enabled: true };
    }
    let dbError: string | undefined;
    try {
      this.store.setEnabled(id, false, by);
    } catch (err) {
      dbError = errorText(err);
    }
    const told = await this.notifyHelper('revoke', { agent: id });
    this.ctx.log(
      `pc-control: agent ${id} switched OFF by ${by}${dbError ? ` (database NOT written: ${dbError})` : ''}` +
        `${told.helper_notified ? '' : ` (helper not told: ${told.helper_error})`}`,
    );
    if (dbError && !told.helper_notified) {
      throw new BruceError(
        'pc_stop_failed',
        `Could not switch ${id} off: the database write failed (${dbError}) and BruceControl was not told (${told.helper_error}).`,
        'Press ctrl+option+cmd+K (or use the BruceControl menu: Stop all PC control) to stop every agent, then retry.',
      );
    }
    return { agent_id: id, enabled: false, ...told, ...(dbError ? { db_error: dbError } : {}) };
  }

  /**
   * Engage the kill switch (in memory at once, then DB, then helper `kill`, which may launch the helper; the helper is
   * told even when the DB write fails) or release it (helper `unkill` with Touch ID, then DB). A repeated stop keeps
   * the first who/when. Engaging throws pc_stop_failed only when neither the DB nor the helper took the stop (this
   * process still refuses every call).
   */
  async setKilled(killed: boolean, by: string): Promise<{ killed: boolean } & Partial<PcNotifyResult>> {
    if (killed) {
      this.memoryKill ??= { at: Date.now(), by };
      const shown = this.glow.pushKill(true, by); // GlowCursor shows the stop at once; awaited (<= 150 ms) below
      let dbError: string | undefined;
      try {
        this.store.setKilled(true, by);
      } catch (err) {
        dbError = errorText(err);
        this.memoryKill.dbError = dbError;
      }
      const told = await this.notifyHelper('kill', { by });
      await shown;
      this.ctx.log(
        `pc-control: kill switch ENGAGED by ${by}${dbError ? ` (database NOT written: ${dbError})` : ''}` +
          `${told.helper_notified ? '' : ` (helper not told: ${told.helper_error})`}`,
      );
      if (dbError && !told.helper_notified) {
        throw new BruceError(
          'pc_stop_failed',
          `The stop was NOT recorded: the database write failed (${dbError}) and BruceControl was not told (${told.helper_error}). ` +
            'Only this Bruce Comm process refuses PC calls now.',
          'Press ctrl+option+cmd+K (or use the BruceControl menu: Stop all PC control), then retry.',
        );
      }
      return { killed: true, ...told, ...(dbError ? { db_error: dbError } : {}) };
    }
    // Only a helper serving this data folder and database may release; it builds the Touch ID text itself.
    await this.verifyHelper();
    await this.helperClient.request('unkill', {}, { timeoutMs: AUTH_TIMEOUT_MS });
    this.store.setKilled(false, by);
    this.memoryKill = null;
    await this.glow.pushKill(false, by);
    this.ctx.log(`pc-control: kill switch released by ${by}`);
    return { killed: false, helper_notified: true };
  }

  /**
   * Serve daemon: mirror the stop flag (database plus this process's own stop) to GlowCursor every 250 ms, so stops
   * from the hotkey, the helper menu and the CLI show too; re-pushed every 10 s while engaged. Returns stop().
   */
  startGlowKillSync(options?: GlowKillSyncOptions): () => void {
    return this.glow.startKillSync(() => {
      const k = this.killState();
      return k.updated_by ? { killed: k.killed, by: k.updated_by } : { killed: k.killed };
    }, options);
  }

  /** Ask the helper to show the macOS permission prompts (launches it; never edits settings). */
  async requestPermissions(): Promise<Record<string, unknown>> {
    return (await this.helperClient.request<Record<string, unknown>>('request_permissions', {}, { timeoutMs: 30_000 })) ?? {};
  }

  listLog(options: { limit?: number; before_id?: number; agent_id?: string } = {}): PcLogRow[] {
    return this.store.listLog(options);
  }

  getLog(id: number): PcLogRow | undefined {
    return this.store.getLog(id);
  }

  thumbnailFile(id: number): string | null {
    return this.store.thumbnailFile(id);
  }
}

/** Validate the helper's display list; main first, `index` = position. */
export function parseDisplays(raw: unknown): DisplayInfo[] {
  const list = Array.isArray(raw) ? raw : [];
  const out: DisplayInfo[] = [];
  for (const d of list) {
    const r = d as Record<string, unknown> | null;
    const f = (r?.frame ?? {}) as Record<string, unknown>;
    const nums = [r?.id, f.x, f.y, f.width, f.height, r?.pixel_width, r?.pixel_height];
    if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) continue;
    const frame = { x: f.x as number, y: f.y as number, width: f.width as number, height: f.height as number };
    const pw = r!.pixel_width as number;
    const ph = r!.pixel_height as number;
    if (frame.width <= 0 || frame.height <= 0 || pw <= 0 || ph <= 0) continue;
    out.push({ id: r!.id as number, index: 0, main: r!.main === true, frame, pixel_width: pw, pixel_height: ph, scale: pw / frame.width });
  }
  if (!out.length) throw new BruceError('pc_helper_error', 'The BruceControl helper reported no usable display.');
  out.sort((a, b) => Number(b.main) - Number(a.main));
  out.forEach((d, i) => (d.index = i));
  return out;
}

/** Args as logged: pc_type text truncated to 500 chars; `runner_task` added for a runner session. */
function logArgs(args: unknown, runnerTask?: string): unknown {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return runnerTask ? { args: args ?? null, runner_task: runnerTask } : (args ?? {});
  const out: Record<string, unknown> = { ...(args as Record<string, unknown>) };
  if (runnerTask) out.runner_task = runnerTask;
  if (typeof out.text === 'string' && out.text.length > LOG_TEXT_MAX) {
    out.text_length = out.text.length;
    out.text = `${out.text.slice(0, LOG_TEXT_MAX)}…`;
  }
  return out;
}

function errorText(err: unknown): string {
  if (err instanceof BruceError) return `[${err.code}] ${err.message}`;
  return err instanceof Error ? err.message : String(err);
}

const services = new WeakMap<BruceContext, PcControlService>();

/** The PC control service of `ctx` (created on first use). */
export function getPcControl(ctx: BruceContext): PcControlService {
  let svc = services.get(ctx);
  if (!svc) {
    svc = new PcControlService(ctx);
    services.set(ctx, svc);
  }
  return svc;
}

/** Start the GlowCursor kill sync for the serve daemon; a no-op (no service created) while the bridge is off. */
export function startPcGlowKillSync(ctx: BruceContext): () => void {
  if (!glowConfig().enabled) return () => {};
  return getPcControl(ctx).startGlowKillSync();
}

/** Test hook: replace the helper client of `ctx`'s service. */
export function setPcHelperClientForTests(ctx: BruceContext, client: HelperClient): void {
  getPcControl(ctx).setHelperClient(client);
}
