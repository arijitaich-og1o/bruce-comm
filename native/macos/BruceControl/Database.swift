// Minimal SQLite access to the Bruce Comm DB (pc_control_* tables). Opens/closes per call.
import Foundation
import SQLite3

private let sqliteTransient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

private let stateDDL = """
CREATE TABLE IF NOT EXISTS pc_control_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT NOT NULL
)
"""

struct DbAccess {
    let killed: Bool
    let enabled: Bool
}

/// What the startup check needs: the DB stop flag and the agents switched on. `complete` is false when the DB file or
/// a pc_control table is missing or the DB cannot be read: the grants are then unconfirmed (`note` says why).
struct DbReconcileInfo: Equatable {
    let killed: Bool
    let enabled: Set<String>
    let complete: Bool
    let note: String
}

/// A SQLite failure with its result code.
struct DatabaseError: Error, CustomStringConvertible {
    let code: Int32
    let message: String
    var description: String { message }
    /// Busy/locked (after the busy timeout): worth retrying.
    var transient: Bool { (code & 0xFF) == SQLITE_BUSY || (code & 0xFF) == SQLITE_LOCKED }
}

/// Upsert of the stop flag. A repeated value changes nothing, so the first who/when of a stop is kept.
let writeKilledSQL = "INSERT INTO pc_control_state(key,value,updated_at,updated_by) VALUES('killed',?,?,?) "
    + "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by "
    + "WHERE pc_control_state.value <> excluded.value"

final class BruceDatabase {
    let path: String

    init(path: String) { self.path = path }

    /// Kill flag + agent enable flag. Throws on any error (missing DB/table included) so callers fail closed.
    func access(agent: String) throws -> DbAccess {
        try withDb { db in
            let killed = try queryKilled(db)
            let enabled = try withStatement(db, "SELECT enabled FROM pc_control_agents WHERE agent_id=?") { st in
                sqlite3_bind_text(st, 1, agent, -1, sqliteTransient)
                let rc = sqlite3_step(st)
                if rc == SQLITE_ROW { return sqlite3_column_int64(st, 0) == 1 }
                if rc == SQLITE_DONE { return false }
                throw dbError(db, "read pc_control_agents")
            }
            return DbAccess(killed: killed, enabled: enabled)
        }
    }

    func readKilled() throws -> Bool {
        try withDb { db in try queryKilled(db) }
    }

    /// Startup check input. A missing DB file or table, or a DB that cannot be opened/read, gives complete=false
    /// (nobody confirmed, no DB stop known). Busy/locked throws so the caller retries instead of guessing.
    func reconcileInfo() throws -> DbReconcileInfo {
        guard FileManager.default.fileExists(atPath: path) else {
            return DbReconcileInfo(killed: false, enabled: [], complete: false, note: "no database file at \(path)")
        }
        do {
            return try withDb { db in
                let hasState = try tableExists(db, "pc_control_state")
                let hasAgents = try tableExists(db, "pc_control_agents")
                let killed = hasState ? try queryKilled(db) : false
                var enabled = Set<String>()
                if hasAgents {
                    try withStatement(db, "SELECT agent_id FROM pc_control_agents WHERE enabled=1") { st in
                        while true {
                            let rc = sqlite3_step(st)
                            if rc == SQLITE_DONE { break }
                            guard rc == SQLITE_ROW else { throw dbError(db, "read pc_control_agents") }
                            if let c = sqlite3_column_text(st, 0) { enabled.insert(String(cString: c)) }
                        }
                    }
                }
                let missing = [hasState ? nil : "pc_control_state", hasAgents ? nil : "pc_control_agents"].compactMap { $0 }
                return DbReconcileInfo(killed: killed, enabled: enabled, complete: missing.isEmpty,
                                       note: missing.isEmpty ? "" : "table \(missing.joined(separator: ", ")) missing in \(path)")
            }
        } catch let e as DatabaseError where e.transient {
            throw e
        } catch {
            return DbReconcileInfo(killed: false, enabled: [], complete: false, note: "database unreadable: \(error)")
        }
    }

    /// Upserts pc_control_state 'killed' (creates that table if missing); a repeated value keeps the first who/when.
    func writeKilled(_ killed: Bool, by: String) throws {
        try withDb { db in
            guard sqlite3_exec(db, stateDDL, nil, nil, nil) == SQLITE_OK else { throw dbError(db, "create pc_control_state") }
            try withStatement(db, writeKilledSQL) { st in
                sqlite3_bind_text(st, 1, killed ? "1" : "0", -1, sqliteTransient)
                sqlite3_bind_int64(st, 2, nowMs())
                sqlite3_bind_text(st, 3, by, -1, sqliteTransient)
                guard sqlite3_step(st) == SQLITE_DONE else { throw dbError(db, "write pc_control_state") }
            }
        }
    }

    // MARK: - internals

    private func tableExists(_ db: OpaquePointer, _ name: String) throws -> Bool {
        try withStatement(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?") { st in
            sqlite3_bind_text(st, 1, name, -1, sqliteTransient)
            let rc = sqlite3_step(st)
            if rc == SQLITE_ROW { return true }
            if rc == SQLITE_DONE { return false }
            throw dbError(db, "read sqlite_master")
        }
    }

    private func queryKilled(_ db: OpaquePointer) throws -> Bool {
        try withStatement(db, "SELECT value FROM pc_control_state WHERE key='killed'") { st in
            let rc = sqlite3_step(st)
            if rc == SQLITE_ROW {
                guard let c = sqlite3_column_text(st, 0) else { return false }
                return String(cString: c) == "1"
            }
            if rc == SQLITE_DONE { return false }
            throw dbError(db, "read pc_control_state")
        }
    }

    private func withDb<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        var handle: OpaquePointer?
        let rc = sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX, nil)
        guard rc == SQLITE_OK, let db = handle else {
            let msg = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "code \(rc)"
            if let h = handle { sqlite3_close(h) }
            throw DatabaseError(code: rc, message: "cannot open \(path): \(msg)")
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 3000)
        return try body(db)
    }

    private func withStatement<T>(_ db: OpaquePointer, _ sql: String, _ body: (OpaquePointer) throws -> T) throws -> T {
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, sql, -1, &st, nil) == SQLITE_OK, let stmt = st else {
            if let s = st { sqlite3_finalize(s) }
            throw dbError(db, "prepare")
        }
        defer { sqlite3_finalize(stmt) }
        return try body(stmt)
    }

    private func dbError(_ db: OpaquePointer, _ what: String) -> DatabaseError {
        DatabaseError(code: sqlite3_extended_errcode(db), message: "database \(what): \(String(cString: sqlite3_errmsg(db)))")
    }
}
