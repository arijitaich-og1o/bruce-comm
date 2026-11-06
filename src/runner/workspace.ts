import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isRunnerChildEntry } from '../clients.js';
import { BruceError } from '../util.js';
import type { RunFile } from './presets.js';
import { processAlive } from './spawn.js';

interface Held {
  count: number;
  /** Original file content, or null when the runner created the file. */
  original: string | null;
  /** Crash-safe copy of `original` on disk (see journalFile). */
  record: string;
}

/** What a restore record holds: written before a workspace file is changed, removed once it is restored. */
interface RestoreRecord {
  file: string;
  original: string | null;
  pid: number;
}

const held = new Map<string, Held>();
const RECORD_PREFIX = 'workspace-restore-';

/** Per working directory (see workspaceKey): the runs waiting for its lock, in order. The key exists while it is locked. */
const locks = new Map<string, Array<() => void>>();

/** Identity of a directory for locking: absolute, and case-insensitive where the file system usually is. */
export function workspaceKey(dir: string): string {
  const resolved = path.resolve(dir);
  return process.platform === 'linux' ? resolved : resolved.toLowerCase();
}

/** Whether a run in this process holds the workspace lock of `dir` right now. */
export function workspaceLocked(dir: string): boolean {
  return locks.has(workspaceKey(dir));
}

/**
 * Exclusive use of the workspace files in `dir` for one run, process-wide (all runner entries), first come first
 * served. A workspace file such as Cursor's `.cursor/mcp.json` carries ONE run's bruce-comm entry - with its
 * per-task runner marker - so runs sharing a working directory must take turns: the next run writes its own entry
 * only after the previous one restored the file. A free lock is taken synchronously (before this returns).
 * Resolves with the unlock function, or null when `signal` aborted first (the lock was not taken).
 */
export function lockWorkspace(dir: string, signal: AbortSignal): Promise<(() => void) | null> {
  const key = workspaceKey(dir);
  if (signal.aborted) return Promise.resolve(null);
  const queue = locks.get(key);
  if (!queue) {
    locks.set(key, []);
    return Promise.resolve(unlocker(key));
  }
  return new Promise((resolve) => {
    const grant = () => {
      signal.removeEventListener('abort', onAbort);
      resolve(unlocker(key));
    };
    const onAbort = () => {
      const index = queue.indexOf(grant);
      if (index >= 0) queue.splice(index, 1);
      resolve(null);
    };
    queue.push(grant);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Unlock function for a held lock: hands it to the next waiting run, or frees it. Idempotent. */
function unlocker(key: string): () => void {
  let unlocked = false;
  return () => {
    if (unlocked) return;
    unlocked = true;
    const next = locks.get(key)?.shift();
    if (next) next();
    else locks.delete(key);
  };
}

/**
 * Temporarily merge runner-owned entries into config files inside a CLI's working directory (e.g.
 * Cursor's `.cursor/mcp.json`). Existing keys are preserved; the original file is restored (or the file
 * removed) when the last run using it ends. The entries are per run (they carry its task marker): callers hold
 * lockWorkspace() for the cwd, so runs never share one; the reference count is only a safety net.
 * Returns the release function.
 *
 * Crash safety: before a file is changed, its original is saved as a restore record in `journalDir` (the runner's
 * `<home>/runs`). A forced exit restores the files with restoreAllWorkspaceFiles(); a runner killed without running
 * any code (taskkill /F, power loss) leaves the record behind, and the next runner start puts the file back with
 * recoverWorkspaceFiles(). An entry that still carries the
 * runner-child marker (left by a run whose record is gone) is never taken for the user's own: it is dropped from the
 * original that will be restored.
 */
export function acquireWorkspaceFiles(files: RunFile[], journalDir: string): () => void {
  const acquired: string[] = [];
  try {
    for (const file of files) {
      if (!file.workspace) continue;
      const key = path.resolve(file.path);
      const entry = held.get(key);
      if (entry) {
        entry.count++;
        acquired.push(key);
      } else {
        const original = withoutRunnerEntries(key, readOrNull(key), file.workspace.mergeKey, Object.keys(file.json));
        const merged = mergedContent(key, original, file.workspace.mergeKey, file.json);
        const record = journalFile(journalDir, key);
        writeRecord(record, { file: key, original, pid: process.pid });
        held.set(key, { count: 1, original, record });
        acquired.push(key);
        fs.mkdirSync(path.dirname(key), { recursive: true });
        fs.writeFileSync(key, merged, 'utf8');
      }
    }
  } catch (err) {
    releaseAll(acquired);
    throw err;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseAll(acquired);
  };
}

/**
 * Restore every workspace file this process still holds, whatever its reference count. Synchronous: for a runner
 * that is about to exit without its normal shutdown (second Ctrl+C, process 'exit').
 */
export function restoreAllWorkspaceFiles(): void {
  for (const [key, entry] of [...held]) {
    held.delete(key);
    restore(key, entry.original, entry.record);
  }
}

/**
 * Put back workspace files changed by an earlier runner process that exited without restoring them (its restore
 * record is still in `journalDir`). Records of a runner process that is still alive are left alone. Returns the
 * files that were restored. Never throws.
 */
export function recoverWorkspaceFiles(journalDir: string): string[] {
  const restored: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(journalDir).filter((n) => n.startsWith(RECORD_PREFIX) && n.endsWith('.json'));
  } catch {
    return restored;
  }
  for (const name of names) {
    const recordPath = path.join(journalDir, name);
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, 'utf8')) as RestoreRecord;
      if (typeof record.file !== 'string' || (record.original !== null && typeof record.original !== 'string')) {
        fs.rmSync(recordPath, { force: true });
        continue;
      }
      if (record.pid !== process.pid && processAlive(record.pid)) continue;
      if (held.has(path.resolve(record.file))) continue;
      restore(record.file, record.original, recordPath);
      restored.push(record.file);
    } catch {
      // unreadable record: leave it for the human to inspect
    }
  }
  return restored;
}

function releaseAll(keys: string[]): void {
  for (const key of keys) {
    const entry = held.get(key);
    if (!entry) continue;
    entry.count--;
    if (entry.count > 0) continue;
    held.delete(key);
    restore(key, entry.original, entry.record);
  }
}

/** Write the original back (or remove a file the runner created), then drop its restore record. Never throws. */
function restore(file: string, original: string | null, record: string): void {
  try {
    if (original === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, original, 'utf8');
    fs.rmSync(record, { force: true });
  } catch {
    // best effort - never let cleanup break the runner; the record stays for the next start
  }
}

function journalFile(journalDir: string, file: string): string {
  const id = createHash('sha256').update(process.platform === 'linux' ? file : file.toLowerCase()).digest('hex').slice(0, 16);
  return path.join(journalDir, `${RECORD_PREFIX}${id}.json`);
}

function writeRecord(recordPath: string, record: RestoreRecord): void {
  fs.mkdirSync(path.dirname(recordPath), { recursive: true });
  const tmp = `${recordPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(record), 'utf8');
  fs.renameSync(tmp, recordPath);
}

function readOrNull(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

function parseObject(file: string, text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text.replace(/^﻿/, ''));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw new Error('not an object');
  } catch (err) {
    throw new BruceError('invalid_config', `Cannot merge into ${file}: ${(err as Error).message}`, 'Fix or remove that file.');
  }
}

/**
 * `original` without entries a runner run left behind (they carry the runner-child marker), so they are never
 * restored as if they were the user's. A file that held nothing else counts as created by the runner (null).
 */
function withoutRunnerEntries(file: string, original: string | null, mergeKey: string, keys: string[]): string | null {
  if (original === null || !original.trim()) return original;
  const data = parseObject(file, original);
  const map = data[mergeKey];
  if (!map || typeof map !== 'object' || Array.isArray(map)) return original;
  const stale = keys.filter((k) => isRunnerChildEntry((map as Record<string, unknown>)[k]));
  if (!stale.length) return original;
  const rest = Object.fromEntries(Object.entries(map).filter(([k]) => !stale.includes(k)));
  if (!Object.keys(rest).length && Object.keys(data).length === 1) return null;
  return `${JSON.stringify({ ...data, [mergeKey]: rest }, null, 2)}\n`;
}

/** The file content with `entries` merged under `mergeKey` (other keys kept). Throws for a file that is not a JSON object. */
function mergedContent(file: string, original: string | null, mergeKey: string, entries: Record<string, unknown>): string {
  const data = original !== null && original.trim() ? parseObject(file, original) : {};
  const current = data[mergeKey];
  const map = current && typeof current === 'object' && !Array.isArray(current) ? (current as Record<string, unknown>) : {};
  return `${JSON.stringify({ ...data, [mergeKey]: { ...map, ...entries } }, null, 2)}\n`;
}
