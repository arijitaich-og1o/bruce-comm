import { DatabaseSync } from 'node:sqlite';
/**
 * Schema migrations, applied in order. `PRAGMA user_version` records how many have run.
 * Never edit a shipped migration - append a new one.
 */
const MIGRATIONS = [
    `
  CREATE TABLE agents (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    platform        TEXT NOT NULL DEFAULT 'other',
    instructions    TEXT NOT NULL,
    skills          TEXT NOT NULL DEFAULT '[]',
    tags            TEXT NOT NULL DEFAULT '[]',
    accept_from     TEXT NOT NULL DEFAULT '["*"]',
    max_concurrent  INTEGER NOT NULL DEFAULT 3,
    require_approval INTEGER NOT NULL DEFAULT 0,
    owner           TEXT,
    workspace       TEXT,
    version         TEXT,
    metadata        TEXT NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'online',
    status_message  TEXT,
    registered_at   INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    listening_until INTEGER
  );

  CREATE TABLE tasks (
    id               TEXT PRIMARY KEY,
    kind             TEXT NOT NULL,
    from_agent       TEXT NOT NULL,
    to_agent         TEXT,
    to_skill         TEXT,
    title            TEXT NOT NULL,
    body             TEXT NOT NULL DEFAULT '',
    input            TEXT,
    priority         INTEGER NOT NULL DEFAULT 5,
    depth            INTEGER NOT NULL DEFAULT 0,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approved_by      TEXT,
    status           TEXT NOT NULL,
    status_message   TEXT,
    progress         INTEGER,
    thread_id        TEXT NOT NULL,
    parent_task_id   TEXT,
    broadcast_id     TEXT,
    idempotency_key  TEXT,
    assignee         TEXT,
    lease_seconds    INTEGER NOT NULL,
    lease_expires_at INTEGER,
    attempts         INTEGER NOT NULL DEFAULT 0,
    max_attempts     INTEGER NOT NULL DEFAULT 3,
    result           TEXT,
    result_data      TEXT,
    error            TEXT,
    result_seen      INTEGER NOT NULL DEFAULT 0,
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    not_before       INTEGER,
    expires_at       INTEGER,
    claimed_at       INTEGER,
    completed_at     INTEGER
  );
  CREATE INDEX tasks_queue    ON tasks(status, priority DESC, created_at);
  CREATE INDEX tasks_to_agent ON tasks(to_agent, status);
  CREATE INDEX tasks_assignee ON tasks(assignee, status);
  CREATE INDEX tasks_from     ON tasks(from_agent, status);
  CREATE INDEX tasks_thread   ON tasks(thread_id, created_at);
  CREATE INDEX tasks_lease    ON tasks(status, lease_expires_at);
  CREATE UNIQUE INDEX tasks_idempotency ON tasks(from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE task_events (
    seq      INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id  TEXT NOT NULL,
    at       INTEGER NOT NULL,
    actor    TEXT NOT NULL,
    type     TEXT NOT NULL,
    message  TEXT,
    data     TEXT
  );
  CREATE INDEX task_events_task ON task_events(task_id, seq);
  `,
    // 2: sessions - an agent can be connected through several IDE windows / app instances at once.
    `
  CREATE TABLE sessions (
    id              TEXT PRIMARY KEY,
    agent_id        TEXT,
    transport       TEXT NOT NULL,
    client_name     TEXT,
    client_version  TEXT,
    label           TEXT,
    workspaces      TEXT NOT NULL DEFAULT '[]',
    host_pid        INTEGER,
    started_at      INTEGER NOT NULL,
    heartbeat_at    INTEGER NOT NULL,
    last_active_at  INTEGER,
    listening_until INTEGER,
    closed_at       INTEGER,
    close_reason    TEXT
  );
  CREATE INDEX sessions_agent ON sessions(agent_id, closed_at);
  CREATE INDEX sessions_open  ON sessions(closed_at, heartbeat_at);

  ALTER TABLE tasks ADD COLUMN to_session TEXT;
  ALTER TABLE tasks ADD COLUMN to_workspace TEXT;
  ALTER TABLE tasks ADD COLUMN assignee_session TEXT;
  CREATE INDEX tasks_to_session ON tasks(to_session, status);
  CREATE INDEX tasks_assignee_session ON tasks(assignee_session, status);
  `,
    // 3: remember which session sent a task, so replies and result notices reach the window that asked.
    `
  ALTER TABLE tasks ADD COLUMN from_session TEXT;
  CREATE INDEX tasks_from_session ON tasks(from_agent, from_session);
  `,
    // 4: (a) resume_session marks a to_session pin added when an answered task returns to the window that asked; it is
    // dropped when that reservation ends. (b) Broadcast copies keep the sender's idempotency key as given (they used to
    // store "<key>@<recipient>", which collided with other keys); the key is unique per sender AND recipient.
    `
  ALTER TABLE tasks ADD COLUMN resume_session TEXT;
  DROP INDEX tasks_idempotency;
  UPDATE tasks SET idempotency_key = substr(idempotency_key, 1, length(idempotency_key) - length(to_agent) - 1)
   WHERE broadcast_id IS NOT NULL AND idempotency_key IS NOT NULL AND to_agent IS NOT NULL
     AND length(idempotency_key) > length(to_agent) + 1
     AND substr(idempotency_key, length(idempotency_key) - length(to_agent)) = '@' || to_agent
     AND NOT EXISTS (
       SELECT 1 FROM tasks o
        WHERE o.broadcast_id IS NULL AND o.from_agent = tasks.from_agent AND o.to_agent = tasks.to_agent
          AND o.idempotency_key = substr(tasks.idempotency_key, 1, length(tasks.idempotency_key) - length(tasks.to_agent) - 1)
     );
  CREATE UNIQUE INDEX tasks_idempotency ON tasks(from_agent, idempotency_key, COALESCE(to_agent, '')) WHERE idempotency_key IS NOT NULL;
  `,
];
export function openDatabase(path) {
    const db = new DatabaseSync(path);
    // The busy handler must be installed FIRST, before anything that needs a lock (see enableWal).
    db.exec('PRAGMA busy_timeout = 5000');
    enableWal(db);
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');
    migrate(db);
    return db;
}
/**
 * WAL lets many processes (one per stdio client + the HTTP daemon + the runner) read while one writes. On a brand-new
 * database every process that starts at the same moment (several clients spawning `bruce-comm stdio` on first use)
 * converts it; while another process is in the middle of that conversion SQLite can answer SQLITE_BUSY at once,
 * without consulting the busy handler. Retry briefly instead of failing the start with "database is locked".
 */
function enableWal(db) {
    const deadline = Date.now() + 5000;
    for (let attempt = 1;; attempt++) {
        try {
            db.exec('PRAGMA journal_mode = WAL');
            return;
        }
        catch (err) {
            if (!isBusy(err) || Date.now() >= deadline)
                throw err;
            pause(Math.min(100, 5 * attempt));
        }
    }
}
/** SQLITE_BUSY, including its extended codes (e.g. SQLITE_BUSY_RECOVERY). */
function isBusy(err) {
    const code = err?.errcode;
    return typeof code === 'number' ? (code & 0xff) === 5 : /database is locked/i.test(String(err?.message));
}
/** Block the thread for `ms` (opening the database is synchronous; only used while it is busy at start-up). */
function pause(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
function migrate(db) {
    // BEGIN IMMEDIATE serialises concurrent first-starts so two processes never run the same migration.
    db.exec('BEGIN IMMEDIATE');
    try {
        const current = Number(db.prepare('PRAGMA user_version').get().user_version);
        for (let i = current; i < MIGRATIONS.length; i++) {
            db.exec(MIGRATIONS[i]);
        }
        if (current < MIGRATIONS.length)
            db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
        db.exec('COMMIT');
    }
    catch (err) {
        db.exec('ROLLBACK');
        throw err;
    }
}
const txDepth = new WeakMap();
/**
 * Run `fn` inside a write transaction (BEGIN IMMEDIATE takes the write lock up front, so a
 * read-then-update claim cannot race with another process). Nested calls join the outer transaction.
 */
export function transaction(db, fn) {
    const depth = txDepth.get(db) ?? 0;
    if (depth > 0) {
        txDepth.set(db, depth + 1);
        try {
            return fn();
        }
        finally {
            txDepth.set(db, depth);
        }
    }
    db.exec('BEGIN IMMEDIATE');
    txDepth.set(db, 1);
    try {
        const result = fn();
        db.exec('COMMIT');
        return result;
    }
    catch (err) {
        try {
            db.exec('ROLLBACK');
        }
        catch {
            // ignore - the original error is more useful
        }
        throw err;
    }
    finally {
        txDepth.set(db, 0);
    }
}
/** Changes whenever ANOTHER connection commits to the database - a cheap cross-process change signal. */
export function dataVersion(db) {
    return Number(db.prepare('PRAGMA data_version').get().data_version);
}
//# sourceMappingURL=db.js.map