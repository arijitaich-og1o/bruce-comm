// Test support for the BruceControl harness: runner, in-memory Keychain backend, fake owner auth, temp dirs, SQLite,
// unix-socket client. Never touches the real Keychain, never launches the app, never posts input events.
import Darwin
import Foundation
import SQLite3

// MARK: - Runner

final class TestRunner {
    static let shared = TestRunner()
    private(set) var passed = 0
    private(set) var failed = 0
    private(set) var failures: [String] = []
    private var current = ""
    private let lock = NSLock()

    func group(_ name: String) {
        current = name
        print("\n# \(name)")
    }

    func record(_ ok: Bool, _ name: String, _ detail: String, _ file: String, _ line: Int) {
        lock.lock()
        defer { lock.unlock() }
        if ok {
            passed += 1
            print("  ok    \(name)")
        } else {
            failed += 1
            let where_ = "\((file as NSString).lastPathComponent):\(line)"
            let msg = "[\(current)] \(name) (\(where_))" + (detail.isEmpty ? "" : ": \(detail)")
            failures.append(msg)
            print("  FAIL  \(name) (\(where_))" + (detail.isEmpty ? "" : "\n        \(detail)"))
        }
    }
}

func group(_ name: String) { TestRunner.shared.group(name) }

func check(_ cond: Bool, _ name: String, _ detail: @autoclosure () -> String = "", file: String = #fileID, line: Int = #line) {
    TestRunner.shared.record(cond, name, cond ? "" : detail(), file, line)
}

func checkEq<T: Equatable>(_ got: T, _ want: T, _ name: String, file: String = #fileID, line: Int = #line) {
    TestRunner.shared.record(got == want, name, got == want ? "" : "got \(got), want \(want)", file, line)
}

/// Seconds `body` took, and its result.
func timed<T>(_ body: () throws -> T) rethrows -> (T, TimeInterval) {
    let t0 = Date()
    let v = try body()
    return (v, Date().timeIntervalSince(t0))
}

/// Polls `cond` every 10 ms until it holds or `timeout` passes.
@discardableResult
func waitUntil(_ timeout: TimeInterval, _ cond: () -> Bool) -> Bool {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if cond() { return true }
        usleep(10_000)
    }
    return cond()
}

/// Runs `body` on a background thread; `wait` returns its value (nil on timeout).
final class Background<T> {
    private let sem = DispatchSemaphore(value: 0)
    private let box = ResultBox<T>()

    init(_ body: @escaping () -> T) {
        DispatchQueue.global(qos: .userInitiated).async { [box, sem] in
            box.set(body())
            sem.signal()
        }
    }

    func wait(_ timeout: TimeInterval) -> T? {
        if sem.wait(timeout: .now() + timeout) == .timedOut { return nil }
        sem.signal() // allow waiting again
        return box.get()
    }
}

final class Counter {
    private let lock = NSLock()
    private var n = 0
    func inc() { lock.lock(); n += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return n }
}

// MARK: - Temp dirs (short: unix socket paths are limited to 104 bytes)

enum TempRoot {
    private static var made: [String] = []
    static let root: String = {
        let env = ProcessInfo.processInfo.environment["BRUCE_CONTROL_TEST_TMP"]
        for base in [env, NSTemporaryDirectory(), "/tmp"].compactMap({ $0 }) where !base.isEmpty {
            guard let real = realPath(base) else { continue }
            // root (bc.XXXXXX) + home (hXXXXXX) + /pc-control/helper.sock must fit with room to spare.
            guard (real + "/bc.XXXXXX/hXXXXXX/pc-control/helper.sock").utf8.count <= 100 else { continue }
            if let dir = mkdtempAt(real + "/bc.XXXXXX") { return dir }
        }
        fatalError("no short writable temp directory for the test sockets")
    }()

    static func dir(_ prefix: String = "h") -> String {
        guard let d = mkdtempAt(root + "/\(prefix)XXXXXX") else { fatalError("mkdtemp failed in \(root)") }
        return d
    }

    static func cleanup() {
        _ = try? FileManager.default.removeItem(atPath: root)
    }

    private static func mkdtempAt(_ template: String) -> String? {
        var bytes = Array(template.utf8CString)
        guard let p = mkdtemp(&bytes) else { return nil }
        return realPath(String(cString: p)) ?? String(cString: p)
    }
}

// MARK: - In-memory state backend (stands in for the login Keychain)

let errInteractionNotAllowed: OSStatus = -25308 // errSecInteractionNotAllowed: retryable
let errUserCanceled: OSStatus = -128 // errSecUserCanceled: a Deny

final class MemoryBackend: StateBackend {
    private let cond = NSCondition()
    private var data: Data?
    private var _reads = 0
    private var _writes = 0
    private var readErrors: [OSStatus] = []
    private var writeErrors: [OSStatus] = []
    private var readsBlocked = false
    private var writesBlocked = false
    private var readsWaiting = 0
    private var writesWaiting = 0

    init(_ initial: Data? = nil) { data = initial }

    func read() throws -> Data? {
        cond.lock()
        defer { cond.unlock() }
        _reads += 1
        readsWaiting += 1
        cond.broadcast()
        while readsBlocked { cond.wait() }
        readsWaiting -= 1
        if !readErrors.isEmpty { throw StateBackendError(status: readErrors.removeFirst()) }
        return data
    }

    func write(_ d: Data) throws {
        cond.lock()
        defer { cond.unlock() }
        _writes += 1
        writesWaiting += 1
        cond.broadcast()
        while writesBlocked { cond.wait() }
        writesWaiting -= 1
        if !writeErrors.isEmpty { throw StateBackendError(status: writeErrors.removeFirst()) }
        data = d
    }

    var reads: Int { cond.lock(); defer { cond.unlock() }; return _reads }
    var writes: Int { cond.lock(); defer { cond.unlock() }; return _writes }
    var raw: Data? { cond.lock(); defer { cond.unlock() }; return data }
    var stored: StoredState? { raw.flatMap { StateCodec.decode($0) } }

    func setRaw(_ d: Data?) { cond.lock(); data = d; cond.unlock() }
    func failReads(_ codes: [OSStatus]) { cond.lock(); readErrors = codes; cond.unlock() }
    func failWrites(_ codes: [OSStatus]) { cond.lock(); writeErrors = codes; cond.unlock() }

    func blockReads(_ on: Bool) {
        cond.lock()
        readsBlocked = on
        cond.broadcast()
        cond.unlock()
    }

    func blockWrites(_ on: Bool) {
        cond.lock()
        writesBlocked = on
        cond.broadcast()
        cond.unlock()
    }

    /// True once a read is waiting on the block.
    func waitForBlockedRead(_ timeout: TimeInterval) -> Bool { waitFor(timeout) { readsWaiting > 0 } }
    func waitForBlockedWrite(_ timeout: TimeInterval) -> Bool { waitFor(timeout) { writesWaiting > 0 } }

    private func waitFor(_ timeout: TimeInterval, _ pred: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock()
        defer { cond.unlock() }
        while !pred() {
            if !cond.wait(until: deadline) { return pred() }
        }
        return true
    }
}

// MARK: - Fake owner authentication (stands in for Touch ID)

final class FakeAuth: OwnerAuthenticating {
    private let cond = NSCondition()
    private var _reasons: [String] = []
    private var failure: HelperError?
    private var blocked = false
    private var waiting = 0

    func authenticate(reason: String) throws {
        cond.lock()
        _reasons.append(reason)
        waiting += 1
        cond.broadcast()
        while blocked { cond.wait() }
        waiting -= 1
        let f = failure
        cond.unlock()
        if let f { throw f }
    }

    var reasons: [String] { cond.lock(); defer { cond.unlock() }; return _reasons }
    func fail(with e: HelperError?) { cond.lock(); failure = e; cond.unlock() }

    func block(_ on: Bool) {
        cond.lock()
        blocked = on
        cond.broadcast()
        cond.unlock()
    }

    func waitForPrompt(_ timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock()
        defer { cond.unlock() }
        while waiting == 0 {
            if !cond.wait(until: deadline) { return waiting > 0 }
        }
        return true
    }
}

// MARK: - SQLite test database (what Node creates)

final class TestDB {
    let path: String
    static let schema = """
    CREATE TABLE IF NOT EXISTS pc_control_agents (
      agent_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS pc_control_state (
      key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL);
    """

    /// tables=false creates an empty SQLite file (no pc_control tables).
    init(path: String, tables: Bool = true) {
        self.path = path
        exec(tables ? Self.schema : "PRAGMA user_version = 7;")
    }

    @discardableResult
    func exec(_ sql: String) -> Bool {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK, let db = handle else {
            if let h = handle { sqlite3_close(h) }
            print("  (sqlite open failed: \(path))")
            return false
        }
        defer { sqlite3_close(db) }
        sqlite3_busy_timeout(db, 5000)
        var err: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(db, sql, nil, nil, &err)
        if rc != SQLITE_OK {
            print("  (sqlite: \(err.map { String(cString: $0) } ?? "code \(rc)"))")
            sqlite3_free(err)
        }
        return rc == SQLITE_OK
    }

    func setEnabled(_ agent: String, _ on: Bool) {
        exec("INSERT INTO pc_control_agents(agent_id,enabled,updated_at,updated_by) VALUES('\(agent)',\(on ? 1 : 0),1,'human') "
            + "ON CONFLICT(agent_id) DO UPDATE SET enabled=excluded.enabled")
    }

    func setKilled(_ killed: Bool, by: String = "human") {
        exec("INSERT INTO pc_control_state(key,value,updated_at,updated_by) VALUES('killed','\(killed ? 1 : 0)',1,'\(by)') "
            + "ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_by=excluded.updated_by")
    }

    /// The 'killed' row: value, updated_by, updated_at.
    func killedRow() -> (value: String, by: String, at: Int64)? {
        var handle: OpaquePointer?
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let db = handle else {
            if let h = handle { sqlite3_close(h) }
            return nil
        }
        defer { sqlite3_close(db) }
        var st: OpaquePointer?
        guard sqlite3_prepare_v2(db, "SELECT value, updated_by, updated_at FROM pc_control_state WHERE key='killed'", -1, &st, nil) == SQLITE_OK,
              let stmt = st else { return nil }
        defer { sqlite3_finalize(stmt) }
        guard sqlite3_step(stmt) == SQLITE_ROW else { return nil }
        return (String(cString: sqlite3_column_text(stmt, 0)), String(cString: sqlite3_column_text(stmt, 1)), sqlite3_column_int64(stmt, 2))
    }
}

/// Holds an exclusive SQLite lock (readers get SQLITE_BUSY) until released.
final class DBLock {
    private var handle: OpaquePointer?

    init?(path: String) {
        guard sqlite3_open_v2(path, &handle, SQLITE_OPEN_READWRITE, nil) == SQLITE_OK, let db = handle,
              sqlite3_exec(db, "BEGIN EXCLUSIVE", nil, nil, nil) == SQLITE_OK else {
            if let h = handle { sqlite3_close(h) }
            return nil
        }
    }

    func release() {
        guard let db = handle else { return }
        sqlite3_exec(db, "COMMIT", nil, nil, nil)
        sqlite3_close(db)
        handle = nil
    }
}

// MARK: - Controller fixture

final class Fixture {
    let home: String // canonical
    let config: HelperConfig
    let db: TestDB?
    let backend: MemoryBackend
    let auth = FakeAuth()
    let controller: Controller
    let reconciles = Counter()

    var state: StateStore { controller.state }

    /// - dbFile: "tables" (Node's schema), "empty" (SQLite file without tables), "garbage" (not a database), "none".
    init(dbFile: String = "tables", enabled: [String] = [], dbKilled: Bool? = nil,
         stored: ((_ home: String, _ db: String) -> StoredState?)? = nil, raw: Data? = nil,
         readErrors: [OSStatus] = [], retryInterval: TimeInterval? = nil, start: Bool = true) {
        let dir = TempRoot.dir()
        var cfg = HelperConfig.fromArguments(["BruceControl", "--home", dir, "--db", dir + "/bruce-comm.db"])
        do { try prepareControlDirectory(cfg) } catch { fatalError("prepareControlDirectory: \(error)") }
        cfg = cfg.canonicalized()
        config = cfg
        home = cfg.home
        switch dbFile {
        case "tables", "empty":
            let t = TestDB(path: cfg.dbPath, tables: dbFile == "tables")
            for a in enabled { t.setEnabled(a, true) }
            if let k = dbKilled { t.setKilled(k) }
            db = t
        case "garbage":
            FileManager.default.createFile(atPath: cfg.dbPath, contents: Data(String(repeating: "not a database\n", count: 200).utf8))
            db = nil
        default:
            db = nil
        }
        backend = MemoryBackend(raw ?? stored?(cfg.home, cfg.dbPath).map { StateCodec.encode($0) })
        backend.failReads(readErrors)
        controller = Controller(config: cfg, stateBackend: backend, authenticator: auth)
        if let ri = retryInterval { controller.state.retryInterval = ri }
        let original = controller.state.reconcile
        let counter = reconciles
        controller.state.reconcile = { s in
            counter.inc()
            return try original?(&s) ?? true
        }
        if start {
            controller.start()
            // Settled = phase published; waitIdle also lets the startup write-back finish.
            if controller.state.waitSettled(timeout: 10) { controller.state.waitIdle() }
        }
    }

    /// Stored-state builder for this fixture's home + DB.
    static func mine(_ agents: [String], killed: Bool = false, seq: Int64 = 3) -> (String, String) -> StoredState? {
        { h, d in StoredState(home: h, db: d, agents: agents, killed: killed, seq: seq, updatedAt: 1) }
    }

    /// One request through the real dispatcher (same path as the socket).
    func call(_ op: String, agent: String? = nil, _ args: [String: Any] = [:]) -> [String: Any] {
        callController(controller, op, agent: agent, args)
    }

    /// "ok" or the error code of the per-action access check.
    func access(_ agent: String) -> String {
        do {
            try controller.checkAccess(agent)
            return "ok"
        } catch {
            return asHelperError(error).code
        }
    }

    func accessMessage(_ agent: String) -> String {
        do {
            try controller.checkAccess(agent)
            return ""
        } catch {
            return asHelperError(error).message
        }
    }

    var phase: StateStore.Phase { controller.state.debugValues().phase }
    var memoryAgents: [String] { controller.state.debugValues().state.agents }
    var held: [String] { controller.state.debugValues().held }
}

func callController(_ c: Controller, _ op: String, agent: String? = nil, _ args: [String: Any] = [:], id: String = "t") -> [String: Any] {
    var obj: [String: Any] = ["id": id, "op": op, "args": args]
    if let agent { obj["agent"] = agent }
    guard let d = try? JSONSerialization.data(withJSONObject: obj) else { return [:] }
    return parseLine(c.handle(line: Array(d), peerPid: getpid()))
}

func parseLine(_ s: String) -> [String: Any] {
    (try? JSONSerialization.jsonObject(with: Data(s.utf8))) as? [String: Any] ?? [:]
}

func isOk(_ r: [String: Any]) -> Bool { (r["ok"] as? Bool) == true }
func errCode(_ r: [String: Any]) -> String? { (r["error"] as? [String: Any])?["code"] as? String }
func errMessage(_ r: [String: Any]) -> String { ((r["error"] as? [String: Any])?["message"] as? String) ?? "" }
func resultOf(_ r: [String: Any]) -> [String: Any] { r["result"] as? [String: Any] ?? [:] }

// MARK: - Unix socket client

final class SocketClient {
    let fd: Int32
    private var buffer = [UInt8]()

    init?(path: String) {
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let bytes = Array(path.utf8)
        guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: bytes)
            raw[bytes.count] = 0
        }
        addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        let s = socket(AF_UNIX, SOCK_STREAM, 0)
        guard s >= 0 else { return nil }
        var one: Int32 = 1
        setsockopt(s, SOL_SOCKET, SO_NOSIGPIPE, &one, socklen_t(MemoryLayout<Int32>.size))
        var tv = timeval(tv_sec: 5, tv_usec: 0)
        setsockopt(s, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        let rc = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(s, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard rc == 0 else {
            close(s)
            return nil
        }
        fd = s
    }

    deinit { close(fd) }

    /// Writes everything; false if the peer closed.
    @discardableResult
    func send(_ bytes: [UInt8]) -> Bool {
        bytes.withUnsafeBytes { raw -> Bool in
            guard let base = raw.baseAddress else { return true }
            var off = 0
            while off < raw.count {
                let n = write(fd, base + off, raw.count - off)
                if n < 0 {
                    if errno == EINTR { continue }
                    return false
                }
                off += n
            }
            return true
        }
    }

    @discardableResult
    func send(_ s: String) -> Bool { send(Array(s.utf8)) }

    func shutdownWrite() { shutdown(fd, SHUT_WR) }

    /// Next response line, nil on EOF/timeout.
    func readLine() -> String? {
        var chunk = [UInt8](repeating: 0, count: 65536)
        while true {
            if let nl = buffer.firstIndex(of: 0x0A) {
                let line = Array(buffer[..<nl])
                buffer.removeSubrange(...nl)
                return String(decoding: line, as: UTF8.self)
            }
            let n = chunk.withUnsafeMutableBytes { read(fd, $0.baseAddress, $0.count) }
            if n < 0 && errno == EINTR { continue }
            if n <= 0 { return nil }
            buffer.append(contentsOf: chunk[0..<n])
        }
    }

    /// True when the peer closed the connection (EOF) within the receive timeout.
    func atEOF() -> Bool {
        var b: UInt8 = 0
        while true {
            let n = read(fd, &b, 1)
            if n < 0 && errno == EINTR { continue }
            return n == 0
        }
    }
}
