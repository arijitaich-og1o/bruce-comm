import fs from 'node:fs';
import path from 'node:path';
import { transaction, type Db } from '../db.js';
import { parseJson } from '../util.js';

// PC control tables live outside db.ts migrations (CREATE ... IF NOT EXISTS); the helper reads them too.
const SCHEMA = `
CREATE TABLE IF NOT EXISTS pc_control_agents (
  agent_id   TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pc_control_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pc_control_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  at          INTEGER NOT NULL,
  agent_id    TEXT,
  session_id  TEXT,
  tool        TEXT NOT NULL,
  args        TEXT NOT NULL,
  outcome     TEXT NOT NULL,
  result      TEXT,
  duration_ms INTEGER,
  thumbnail   TEXT
);
CREATE INDEX IF NOT EXISTS pc_control_log_at ON pc_control_log(at);
CREATE INDEX IF NOT EXISTS pc_control_log_agent ON pc_control_log(agent_id, at);
`;

export const LOG_RETENTION_MS = 30 * 24 * 3600 * 1000;
export const LOG_MAX_ROWS = 20_000;
const PRUNE_INTERVAL_MS = 3600 * 1000;
const RESULT_MAX = 1000;
const ARGS_MAX = 8000;

export type PcOutcome = 'ok' | 'refused' | 'error';

export interface PcAgentRow {
  agent_id: string;
  enabled: boolean;
  updated_at: number;
  updated_by: string;
}

export interface PcKillState {
  killed: boolean;
  updated_at?: number;
  updated_by?: string;
}

export interface PcLogInput {
  at?: number;
  agent_id: string | null;
  session_id?: string | null;
  tool: string;
  /** Logged as JSON (callers truncate long text first). */
  args: unknown;
  outcome: PcOutcome;
  result?: string | null;
  duration_ms?: number | null;
}

export interface PcLogRow {
  id: number;
  at: number;
  agent_id: string | null;
  session_id: string | null;
  tool: string;
  /** Parsed JSON args. */
  args: unknown;
  outcome: PcOutcome;
  result: string | null;
  duration_ms: number | null;
  /** Path relative to the thumbs dir, or null. */
  thumbnail: string | null;
}

type Row = Record<string, unknown>;

/** DB access for PC control: allowlist, kill switch and the action log (+ thumbnail files). */
export class PcControlStore {
  /** <home>/pc-control/thumbs */
  readonly thumbsDir: string;
  private lastPrune = 0;

  constructor(
    private readonly db: Db,
    home: string,
  ) {
    this.thumbsDir = path.resolve(home, 'pc-control', 'thumbs');
    db.exec(SCHEMA);
  }

  isEnabled(agentId: string): boolean {
    const row = this.db.prepare('SELECT enabled FROM pc_control_agents WHERE agent_id=?').get(agentId) as Row | undefined;
    return Number(row?.enabled) === 1;
  }

  setEnabled(agentId: string, enabled: boolean, by: string): void {
    this.db
      .prepare(
        `INSERT INTO pc_control_agents(agent_id, enabled, updated_at, updated_by) VALUES(?,?,?,?)
         ON CONFLICT(agent_id) DO UPDATE SET enabled=excluded.enabled, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      )
      .run(agentId, enabled ? 1 : 0, Date.now(), by);
  }

  listAgents(): PcAgentRow[] {
    const rows = this.db.prepare('SELECT agent_id, enabled, updated_at, updated_by FROM pc_control_agents ORDER BY agent_id').all() as Row[];
    return rows.map((r) => ({
      agent_id: String(r.agent_id),
      enabled: Number(r.enabled) === 1,
      updated_at: Number(r.updated_at),
      updated_by: String(r.updated_by),
    }));
  }

  isKilled(): PcKillState {
    const row = this.db.prepare("SELECT value, updated_at, updated_by FROM pc_control_state WHERE key='killed'").get() as Row | undefined;
    if (!row) return { killed: false };
    return { killed: String(row.value) === '1', updated_at: Number(row.updated_at), updated_by: String(row.updated_by) };
  }

  /** Set the kill switch; writing the value it already has changes nothing (a repeated stop keeps the first who/when). */
  setKilled(killed: boolean, by: string): void {
    this.db
      .prepare(
        `INSERT INTO pc_control_state(key, value, updated_at, updated_by) VALUES('killed',?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by
         WHERE pc_control_state.value <> excluded.value`,
      )
      .run(killed ? '1' : '0', Date.now(), by);
  }

  /** Insert a log row; returns its id. Prunes old rows at most once per hour. */
  addLog(entry: PcLogInput): number {
    let args: string;
    try {
      args = JSON.stringify(entry.args ?? {}) ?? '{}';
    } catch {
      args = '{}';
    }
    if (args.length > ARGS_MAX) args = JSON.stringify({ truncated: args.slice(0, ARGS_MAX) });
    const result = entry.result == null ? null : entry.result.length > RESULT_MAX ? `${entry.result.slice(0, RESULT_MAX - 1)}…` : entry.result;
    const info = this.db
      .prepare('INSERT INTO pc_control_log(at, agent_id, session_id, tool, args, outcome, result, duration_ms) VALUES(?,?,?,?,?,?,?,?)')
      .run(
        entry.at ?? Date.now(),
        entry.agent_id ?? null,
        entry.session_id ?? null,
        entry.tool,
        args,
        entry.outcome,
        result,
        entry.duration_ms == null ? null : Math.round(entry.duration_ms),
      );
    const id = Number(info.lastInsertRowid);
    if (Date.now() - this.lastPrune >= PRUNE_INTERVAL_MS) {
      try {
        this.prune();
      } catch {
        // retention is best effort
      }
    }
    return id;
  }

  setLogThumbnail(id: number, relPath: string | null): void {
    this.db.prepare('UPDATE pc_control_log SET thumbnail=? WHERE id=?').run(relPath, id);
  }

  /** Write thumbnail bytes for log row `id` (<thumbs>/<YYYY-MM-DD>/<id>.jpg) and record it; returns the relative path. */
  saveThumbnail(id: number, bytes: Buffer, at = Date.now()): string {
    const d = new Date(at);
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const rel = `${day}/${id}.jpg`;
    fs.mkdirSync(path.join(this.thumbsDir, day), { recursive: true });
    fs.writeFileSync(path.join(this.thumbsDir, rel), bytes);
    this.setLogThumbnail(id, rel);
    return rel;
  }

  /** Newest first. `limit` default 50, max 500. */
  listLog(options: { limit?: number; before_id?: number; agent_id?: string } = {}): PcLogRow[] {
    const limit = Math.min(500, Math.max(1, Math.floor(Number(options.limit) || 50)));
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (options.before_id != null && Number.isFinite(Number(options.before_id))) {
      where.push('id < ?');
      params.push(Math.floor(Number(options.before_id)));
    }
    if (options.agent_id) {
      where.push('agent_id = ?');
      params.push(options.agent_id.trim().toLowerCase());
    }
    const sql = `SELECT * FROM pc_control_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
    return (this.db.prepare(sql).all(...params, limit) as Row[]).map(rowToLog);
  }

  getLog(id: number): PcLogRow | undefined {
    const row = this.db.prepare('SELECT * FROM pc_control_log WHERE id=?').get(id) as Row | undefined;
    return row ? rowToLog(row) : undefined;
  }

  countLog(): number {
    return Number((this.db.prepare('SELECT COUNT(*) AS n FROM pc_control_log').get() as Row).n);
  }

  /** Absolute path of row `id`'s thumbnail when it exists and lies inside the thumbs dir; else null. */
  thumbnailFile(id: number): string | null {
    const rel = this.getLog(id)?.thumbnail;
    return rel ? this.resolveThumb(rel) : null;
  }

  private resolveThumb(rel: string): string | null {
    const abs = path.resolve(this.thumbsDir, rel);
    if (!abs.startsWith(this.thumbsDir + path.sep)) return null;
    try {
      return fs.statSync(abs).isFile() ? abs : null;
    } catch {
      return null;
    }
  }

  /** Delete rows older than 30 days and beyond the newest 20,000 (and their thumbnails). Returns rows deleted. */
  prune(now = Date.now()): number {
    this.lastPrune = now;
    const cutoff = now - LOG_RETENTION_MS;
    const doomed = transaction(this.db, () => {
      const nth = this.db.prepare('SELECT id FROM pc_control_log ORDER BY id DESC LIMIT 1 OFFSET ?').get(LOG_MAX_ROWS - 1) as Row | undefined;
      const minKeep = nth ? Number(nth.id) : 0;
      const rows = this.db.prepare('SELECT id, thumbnail FROM pc_control_log WHERE at < ? OR id < ?').all(cutoff, minKeep) as Row[];
      if (rows.length) this.db.prepare('DELETE FROM pc_control_log WHERE at < ? OR id < ?').run(cutoff, minKeep);
      return rows;
    });
    const dirs = new Set<string>();
    for (const row of doomed) {
      if (typeof row.thumbnail !== 'string' || !row.thumbnail) continue;
      const file = this.resolveThumb(row.thumbnail);
      if (!file) continue;
      try {
        fs.unlinkSync(file);
        dirs.add(path.dirname(file));
      } catch {
        // already gone
      }
    }
    for (const dir of dirs) {
      try {
        fs.rmdirSync(dir); // only succeeds when empty
      } catch {
        // still has files
      }
    }
    return doomed.length;
  }
}

function rowToLog(r: Row): PcLogRow {
  return {
    id: Number(r.id),
    at: Number(r.at),
    agent_id: r.agent_id == null ? null : String(r.agent_id),
    session_id: r.session_id == null ? null : String(r.session_id),
    tool: String(r.tool),
    args: parseJson<unknown>(r.args as string, r.args),
    outcome: String(r.outcome) as PcOutcome,
    result: r.result == null ? null : String(r.result),
    duration_ms: r.duration_ms == null ? null : Number(r.duration_ms),
    thumbnail: r.thumbnail == null ? null : String(r.thumbnail),
  };
}
