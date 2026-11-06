// Helper state (owner-approved grants + stop flag, bound to one home + DB) kept in the login Keychain, the in-memory
// kill flag, file helpers.
import Foundation
import Security

// MARK: - Backend (login Keychain in the app; an in-memory store in tests)

/// Where the authoritative state lives.
protocol StateBackend: AnyObject {
    /// The stored bytes, nil when there is no item yet. Throws StateBackendError.
    func read() throws -> Data?
    func write(_ data: Data) throws
}

struct StateBackendError: Error, CustomStringConvertible {
    let status: OSStatus

    var description: String {
        let msg = (SecCopyErrorMessageString(status, nil) as String?) ?? "unknown error"
        return "Keychain error \(status): \(msg)"
    }

    /// The owner said no (Deny / cancel / failed auth): probes never retry it, only grant and unkill do.
    var isDenied: Bool { status == errSecUserCanceled || status == errSecAuthFailed }
}

/// Generic password in the login keychain: service com.bruce.comm.pccontrol, account "state", data = state JSON.
final class KeychainStateBackend: StateBackend {
    static let service = bundleIdentifier
    static let account = "state"

    private func baseQuery() -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: Self.service,
            kSecAttrAccount as String: Self.account,
        ]
    }

    func read() throws -> Data? {
        var q = baseQuery()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let st = SecItemCopyMatching(q as CFDictionary, &out)
        if st == errSecItemNotFound { return nil }
        guard st == errSecSuccess else { throw StateBackendError(status: st) }
        guard let data = out as? Data else { throw StateBackendError(status: errSecDecode) }
        return data
    }

    func write(_ data: Data) throws {
        let st = SecItemUpdate(baseQuery() as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if st == errSecSuccess { return }
        guard st == errSecItemNotFound else { throw StateBackendError(status: st) }
        var attrs = baseQuery()
        attrs[kSecValueData as String] = data
        attrs[kSecAttrLabel as String] = "Bruce Control state"
        attrs[kSecAttrDescription as String] = "Bruce Control PC-control grants and stop flag"
        let added = SecItemAdd(attrs as CFDictionary, nil)
        guard added == errSecSuccess else { throw StateBackendError(status: added) }
        logLine("created the state item in the login Keychain")
    }
}

// MARK: - State and its stored form

/// Effective access state for the served home and database.
struct AccessState: Equatable {
    var agents: [String] // sorted, unique
    var killed: Bool

    static let empty = AccessState(agents: [], killed: false)
    static let failClosed = AccessState(agents: [], killed: true)

    func normalized() -> AccessState { AccessState(agents: Array(Set(agents)).sorted(), killed: killed) }
}

/// Keychain item data: {version:2, home, db, agents:[sorted], killed, seq, updated_at}.
struct StoredState: Equatable {
    var home: String
    /// Canonical DB path. nil only in items written before the DB was bound into the state: never matches.
    var db: String?
    var agents: [String]
    var killed: Bool
    var seq: Int64
    var updatedAt: Int64
}

enum StateCodec {
    static let version = 2

    static func object(_ s: StoredState) -> [String: Any] {
        var o: [String: Any] = [
            "version": version, "home": s.home, "agents": Array(Set(s.agents)).sorted(),
            "killed": s.killed, "seq": s.seq, "updated_at": s.updatedAt,
        ]
        if let db = s.db { o["db"] = db }
        return o
    }

    /// Canonical JSON (sorted keys, compact).
    static func encode(_ s: StoredState) -> Data {
        (try? JSONSerialization.data(withJSONObject: object(s), options: [.sortedKeys, .withoutEscapingSlashes])) ?? Data()
    }

    /// Strict: anything unexpected is nil (the caller fails closed). A missing `db` decodes as nil (an older item).
    static func decode(_ data: Data) -> StoredState? {
        guard data.count <= 1 << 20,
              let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let v = integer(obj["version"]), v == Int64(version),
              let home = obj["home"] as? String, home.hasPrefix("/"),
              let list = obj["agents"] as? [Any],
              let k = obj["killed"] as? NSNumber, isBoolNumber(k),
              let seq = integer(obj["seq"]),
              let at = integer(obj["updated_at"]) else { return nil }
        var db: String?
        if let raw = obj["db"] {
            guard let s = raw as? String, s.hasPrefix("/") else { return nil }
            db = s
        }
        var agents: [String] = []
        for item in list {
            guard let s = item as? String, isValidAgentId(s) else { return nil }
            agents.append(s)
        }
        return StoredState(home: home, db: db, agents: Array(Set(agents)).sorted(), killed: k.boolValue, seq: seq, updatedAt: at)
    }

    private static func integer(_ v: Any?) -> Int64? {
        guard let n = v as? NSNumber, !isBoolNumber(n) else { return nil }
        let d = n.doubleValue
        guard d.isFinite, d == d.rounded(), d >= 0, d < 9.0e15 else { return nil }
        return Int64(d)
    }
}

// MARK: - Store

/// Grants + stop flag for the served home and DB. The Keychain item is authoritative; once loaded, the in-memory copy
/// is used. Keychain I/O runs only on `io` and never under `cond`, so status, grants, kill and revoke never wait for a
/// Keychain prompt. The first successful load runs the startup check (`reconcile`) exactly once; after that the phase
/// stays `.ready` and every later load request is a no-op.
final class StateStore {
    enum Phase: Equatable {
        case loading
        case ready
        case failed(retryable: Bool)
    }

    struct Snapshot {
        let state: AccessState // agents [] and killed false while loading
        let signatureOk: Bool? // nil while loading
        let loading: Bool
    }

    /// Minimum time between background re-reads after a retryable failure.
    var retryInterval: TimeInterval = 30

    let home: String
    let db: String
    private let backend: StateBackend
    private let mirrorPath: String?
    private let io = DispatchQueue(label: "BruceControl.state", qos: .userInitiated)
    private let cond = NSCondition()
    // Guarded by cond.
    private var phase = Phase.loading
    private var state = AccessState.failClosed
    /// Stored grants the startup check could not confirm (DB file or tables missing/unreadable): never usable in this
    /// process, but kept in the Keychain so they are not wiped.
    private var held = Set<String>()
    private var seq: Int64 = 0
    private var foreign: String? // the item belongs to another home/DB and nothing was saved for this one yet
    private var malformed = false // the item exists but is not valid state: grant/unkill may overwrite it
    private var retryAfter: Date?
    private var waitingFor = "Keychain approval"
    private var pendingRevokes = Set<String>()
    /// Non-nil from the moment applyOnIO reads its base until it publishes; revokes landing meanwhile win.
    private var revokedDuringWrite: Set<String>?
    // io only.
    private var cachedRead: ReadResult?
    private var retryScheduled = false

    /// Startup check against the DB; runs inside the first successful load, before the state is ever used.
    /// Returns false when the DB could not confirm the grants (file or tables missing/unreadable): the result is then
    /// applied in memory only and the stored grants are kept (fail closed, never wiped).
    var reconcile: ((inout AccessState) throws -> Bool)?

    private enum ReadResult {
        case missing
        case data(Data)
    }

    private enum LoadOutcome {
        case ready
        case failed(HelperError)
        case dbFailed(HelperError)
    }

    init(home: String, db: String, backend: StateBackend, mirrorPath: String?) {
        self.home = home
        self.db = db
        self.backend = backend
        self.mirrorPath = mirrorPath
    }

    /// Loads the state on the background queue (may wait for a Keychain prompt) and runs the startup check.
    /// A no-op once the state is ready.
    func start() {
        io.async { [self] in startupLoad(attempt: 0) }
    }

    /// Never blocks on the Keychain.
    func snapshot() -> Snapshot {
        retryIfDue()
        cond.lock()
        defer { cond.unlock() }
        switch phase {
        case .loading: return Snapshot(state: .empty, signatureOk: nil, loading: true)
        case .ready: return Snapshot(state: state, signatureOk: true, loading: false)
        case .failed: return Snapshot(state: state, signatureOk: false, loading: false)
        }
    }

    /// Phase and in-memory values, for diagnostics and tests. Never blocks on the Keychain.
    func debugValues() -> (phase: Phase, state: AccessState, held: [String], seq: Int64, foreign: String?) {
        cond.lock()
        defer { cond.unlock() }
        return (phase, state, held.sorted(), seq, foreign)
    }

    /// Waits until the Keychain work queued so far has run (diagnostics/tests; not while a Keychain call may block).
    func waitIdle() {
        io.sync {}
    }

    /// State for an access check; waits at most `timeout` for a load in progress. nil = still loading (fail closed).
    func usable(timeout: TimeInterval) -> (state: AccessState, signatureOk: Bool)? {
        retryIfDue()
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock()
        defer { cond.unlock() }
        while phase == .loading {
            if !cond.wait(until: deadline) { break }
        }
        switch phase {
        case .loading: return nil
        case .ready: return (state, true)
        case .failed: return (state, false)
        }
    }

    /// True once no load is in progress (waits at most `timeout`).
    func waitSettled(timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        cond.lock()
        defer { cond.unlock() }
        while phase == .loading {
            if !cond.wait(until: deadline) { break }
        }
        return phase != .loading
    }

    func waitingError(_ suffix: String = "") -> HelperError {
        cond.lock()
        let what = waitingFor
        cond.unlock()
        return .failed("PC control state is not available yet: BruceControl is waiting for \(what) (fail closed)\(suffix)")
    }

    /// Applies `change` and saves it to the backend, then to memory. `reload`: a state that is not ready may re-read
    /// the backend first (may show a Keychain prompt; grant/unkill only). A change that has not started by the
    /// deadline is dropped.
    @discardableResult
    func update(reload: Bool, timeout: TimeInterval, _ change: @escaping (inout AccessState) throws -> Void) throws -> AccessState {
        let deadline = Date().addingTimeInterval(timeout)
        guard waitSettled(timeout: max(0, deadline.timeIntervalSinceNow)) else { throw waitingError("; nothing was changed") }
        let ticket = Ticket()
        let box = ResultBox<Result<AccessState, HelperError>>()
        let done = DispatchSemaphore(value: 0)
        io.async { [self] in
            guard ticket.begin() else { return }
            box.set(applyOnIO(reload: reload, change))
            done.signal()
        }
        if done.wait(timeout: .now() + max(0, deadline.timeIntervalSinceNow)) == .timedOut {
            if ticket.cancel() { throw waitingError("; nothing was changed") }
            if done.wait(timeout: .now() + 30) == .timedOut {
                throw HelperError.failed("the Keychain did not answer in time; the change may still be saved when it does")
            }
        }
        guard let result = box.get() else { throw HelperError.failed("state update gave no result") }
        return try result.get()
    }

    /// Removes a grant from memory at once (never waits for the Keychain); the Keychain is saved in the background.
    /// While the state is not loaded yet the revoke is also kept and applied when it loads (returns true).
    func revoke(_ agent: String) -> Bool {
        cond.lock()
        let before = state.agents.count
        state.agents.removeAll { $0 == agent }
        let removed = state.agents.count != before || held.remove(agent) != nil
        if phase != .ready {
            pendingRevokes.insert(agent)
            cond.unlock()
            logLine("revoke of \(agent) recorded; applied when the state can be read")
            return true
        }
        let writeInFlight = revokedDuringWrite != nil
        revokedDuringWrite?.insert(agent)
        cond.unlock()
        if removed || writeInFlight {
            io.async { [self] in persistMemory("revoke of \(agent)") }
        }
        return false
    }

    /// Saves killed=true in the background. Before the first successful load nothing is written: that load merges
    /// the in-memory kill flag (startup check).
    func persistKill() {
        io.async { [self] in
            cond.lock()
            let ready = phase == .ready
            cond.unlock()
            guard ready else { return }
            if case .failure(let e) = applyOnIO(reload: false, { $0.killed = true }) {
                logLine("kill: not saved in the Keychain (\(e.message)); still enforced in memory and by the database")
            }
        }
    }

    // MARK: internals (io queue)

    private func startupLoad(attempt: Int) {
        guard case .dbFailed(let e) = loadOnIO() else { return }
        if attempt == 0 || attempt % 10 == 0 { logLine("\(e.message); retrying") }
        scheduleRetry(after: attempt)
    }

    /// One retry chain for a DB that could not be read yet (the phase stays .loading meanwhile).
    private func scheduleRetry(after attempt: Int) {
        cond.lock()
        waitingFor = "the Bruce Comm database"
        cond.unlock()
        guard !retryScheduled else { return }
        retryScheduled = true
        let delay = min(30.0, pow(2.0, Double(min(attempt, 5))))
        io.asyncAfter(deadline: .now() + delay) { [self] in
            retryScheduled = false
            startupLoad(attempt: attempt + 1)
        }
    }

    /// A retryable failure (not a Deny) is read again in the background, at most every `retryInterval`.
    private func retryIfDue() {
        cond.lock()
        guard case .failed(retryable: true) = phase, let ra = retryAfter, Date() >= ra else {
            cond.unlock()
            return
        }
        phase = .loading
        waitingFor = "Keychain approval"
        retryAfter = nil
        cond.unlock()
        logLine("reading the state from the Keychain again")
        io.async { [self] in startupLoad(attempt: 0) }
    }

    private func loadOnIO() -> LoadOutcome {
        // Once ready, never load (or reconcile) again: a load queued meanwhile must not undo a grant/unkill that
        // was just saved (the DB is updated only after the helper answers).
        cond.lock()
        let alreadyReady = phase == .ready
        cond.unlock()
        if alreadyReady { return .ready }

        let read: ReadResult
        if let c = cachedRead {
            read = c
        } else {
            do {
                let d = try backend.read()
                read = d.map { .data($0) } ?? .missing
                cachedRead = read
            } catch {
                let denied = (error as? StateBackendError)?.isDenied ?? false
                publishFailure(retryable: !denied, malformed: false, "cannot read it from the Keychain: \(error)")
                return .failed(.failed("BruceControl cannot read its state from the Keychain (\(error)); allow the Keychain prompt from BruceControl"))
            }
        }
        var effective = AccessState.empty
        var storedSeq: Int64 = 0
        var foreignNow: String?
        if case .data(let d) = read {
            guard let st = StateCodec.decode(d) else {
                cachedRead = nil
                publishFailure(retryable: false, malformed: true, "the Keychain item is not valid state")
                return .failed(.failed("BruceControl's Keychain state is unreadable (fail closed)"))
            }
            storedSeq = st.seq
            if st.home == home && st.db == db {
                effective = AccessState(agents: st.agents, killed: st.killed).normalized()
            } else {
                foreignNow = "home \(st.home), database \(st.db ?? "(not recorded)")"
            }
        }
        let fromKeychain = effective
        cond.lock()
        waitingFor = "the Bruce Comm database"
        cond.unlock()
        let complete: Bool
        do {
            complete = try reconcile?(&effective) ?? true
        } catch {
            return .dbFailed(.failed("cannot read the Bruce Comm database for the startup check (\(asHelperError(error).message))"))
        }
        cachedRead = nil
        // Grants the DB could not confirm are not usable, but stay stored.
        var heldNow = complete ? Set<String>() : Set(fromKeychain.agents).subtracting(effective.agents)
        cond.lock()
        if !pendingRevokes.isEmpty {
            effective.agents.removeAll { pendingRevokes.contains($0) }
            heldNow.subtract(pendingRevokes)
            pendingRevokes.removeAll()
        }
        effective = effective.normalized()
        state = effective
        held = heldNow
        seq = storedSeq
        foreign = foreignNow
        phase = .ready
        malformed = false
        retryAfter = nil
        cond.broadcast()
        cond.unlock()
        if let foreignNow {
            logLine("the Keychain state belongs to another Bruce Comm setup (\(foreignNow)); no agent is allowed for home \(home), database \(db) until one is granted")
        }
        if effective != fromKeychain {
            logLine("startup check: agents \(fromKeychain.agents) -> \(effective.agents), killed \(fromKeychain.killed) -> \(effective.killed)"
                + (complete ? "" : " (in memory only; \(heldNow.sorted()) stay stored)"))
        }
        // Write-back only for this home + DB: the full result when the DB confirmed the grants; otherwise only a stop
        // merged from memory/DB (every stored grant kept), so a stop is never lost when the DB could not be read.
        let saveStopOnly = !complete && effective.killed && !fromKeychain.killed
        if foreignNow == nil && ((complete && effective != fromKeychain) || saveStopOnly) {
            let keep = complete ? effective.agents : effective.agents + heldNow.subtracting(effective.agents).sorted()
            let stored = StoredState(home: home, db: db, agents: keep, killed: effective.killed,
                                     seq: storedSeq + 1, updatedAt: nowMs())
            do {
                try backend.write(StateCodec.encode(stored))
                cond.lock()
                if seq == storedSeq { seq = storedSeq + 1 }
                cond.unlock()
            } catch {
                logLine("startup check: not saved in the Keychain (\(error)); enforced in memory")
            }
        }
        writeMirror()
        return .ready
    }

    private func applyOnIO(reload: Bool, _ change: (inout AccessState) throws -> Void) -> Result<AccessState, HelperError> {
        // Mark the reload as a load in progress first, so no background retry queues a second one meanwhile.
        cond.lock()
        let needLoad = reload && phase != .ready
        if needLoad {
            phase = .loading
            waitingFor = "Keychain approval"
        }
        cond.unlock()
        var loadError: HelperError?
        if needLoad {
            switch loadOnIO() {
            case .ready: break
            case .failed(let e): loadError = e
            case .dbFailed(let e):
                loadError = e
                scheduleRetry(after: 0)
            }
        }
        cond.lock()
        let ph = phase
        let base = state
        let heldNow = held
        let curSeq = seq
        let foreignNow = foreign
        let overwrite = malformed && reload
        let proceed: Bool
        switch ph {
        case .ready: proceed = true
        case .failed where overwrite: proceed = true // replace an unreadable item, starting from fail-closed values
        default: proceed = false
        }
        // From the moment `base` is read, a revoke must survive this change being published.
        if proceed { revokedDuringWrite = [] }
        cond.unlock()
        guard proceed else {
            if case .loading = ph { return .failure(loadError ?? waitingError("; nothing was changed")) }
            return .failure(loadError ?? .failed("BruceControl cannot use its state (fail closed); nothing was changed"))
        }
        defer {
            cond.lock()
            revokedDuringWrite = nil
            cond.unlock()
        }
        var next = base
        do {
            try change(&next)
        } catch {
            return .failure(asHelperError(error))
        }
        next = next.normalized()
        if next == base && !overwrite { return .success(next) }
        if foreignNow != nil && next.agents.isEmpty && !overwrite {
            // The item holds another setup's grants and this one has none to protect: change memory only.
            return .success(publish(next, seq: curSeq, keepForeign: true))
        }
        let stored = StoredState(home: home, db: db, agents: next.agents + heldNow.subtracting(next.agents).sorted(),
                                 killed: next.killed, seq: curSeq + 1, updatedAt: nowMs())
        do {
            try backend.write(StateCodec.encode(stored))
        } catch {
            return .failure(.failed("could not save BruceControl's state in the Keychain (\(error)); nothing was changed"))
        }
        return .success(publish(next, seq: curSeq + 1, keepForeign: false))
    }

    /// Writes the current in-memory state (usable + held grants) after a revoke. On failure memory stays as it is
    /// (the revoke is still enforced) and the startup check drops the grant at the next launch (DB enabled=0).
    private func persistMemory(_ what: String) {
        cond.lock()
        let ready = phase == .ready
        let cur = state
        let heldNow = held
        let curSeq = seq
        let foreignNow = foreign
        cond.unlock()
        guard ready, foreignNow == nil else { return }
        let stored = StoredState(home: home, db: db, agents: cur.agents + heldNow.sorted(), killed: cur.killed,
                                 seq: curSeq + 1, updatedAt: nowMs())
        do {
            try backend.write(StateCodec.encode(stored))
        } catch {
            logLine("\(what): not saved in the Keychain (\(error)); enforced in memory and by the database")
            return
        }
        cond.lock()
        if seq == curSeq { seq = curSeq + 1 }
        cond.unlock()
        writeMirror()
    }

    /// Makes `next` the in-memory state (revokes that landed during the save win). Returns what was published.
    private func publish(_ next: AccessState, seq newSeq: Int64, keepForeign: Bool) -> AccessState {
        cond.lock()
        var n = next
        if let r = revokedDuringWrite, !r.isEmpty { n.agents.removeAll { r.contains($0) } }
        revokedDuringWrite = nil
        held.subtract(n.agents)
        state = n
        seq = newSeq
        phase = .ready
        malformed = false
        retryAfter = nil
        if !keepForeign { foreign = nil }
        pendingRevokes.removeAll()
        cond.broadcast()
        cond.unlock()
        writeMirror()
        return n
    }

    private func publishFailure(retryable: Bool, malformed bad: Bool, _ why: String) {
        cond.lock()
        state = .failClosed
        held.removeAll()
        phase = .failed(retryable: retryable)
        malformed = bad
        retryAfter = retryable ? Date().addingTimeInterval(retryInterval) : nil
        cond.broadcast()
        cond.unlock()
        logLine("state not usable (\(why)); failing closed" + (retryable ? "" : " until a grant or re-enable tries again"))
    }

    /// Best-effort human-readable copy of the stored state; BruceControl never reads it.
    private func writeMirror() {
        guard let mirrorPath else { return }
        cond.lock()
        var obj = StateCodec.object(StoredState(home: home, db: db, agents: state.agents + held.sorted(), killed: state.killed,
                                                seq: seq, updatedAt: nowMs()))
        cond.unlock()
        obj["comment"] = "Read-only mirror of BruceControl's state in the login Keychain (service \(bundleIdentifier), account state). BruceControl never reads this file; editing it changes nothing."
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: [.sortedKeys, .prettyPrinted, .withoutEscapingSlashes]) else { return }
        do {
            try writeFileAtomically(mirrorPath, data + Data([0x0A]), mode: 0o600)
        } catch {
            logLine("could not write the state mirror \(mirrorPath): \(error)")
        }
    }
}

/// A queued change that may be dropped until it starts running.
private final class Ticket {
    private enum Stage { case queued, running, cancelled }
    private let lock = NSLock()
    private var stage = Stage.queued

    func begin() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard stage == .queued else { return false }
        stage = .running
        return true
    }

    func cancel() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard stage == .queued else { return false }
        stage = .cancelled
        return true
    }
}

// MARK: - In-memory kill flag (takes effect at once; never blocks)

final class KillFlag {
    private let lock = NSLock()
    private var killed = false
    private var gen: UInt64 = 0

    var value: Bool {
        lock.lock()
        defer { lock.unlock() }
        return killed
    }

    var generation: UInt64 {
        lock.lock()
        defer { lock.unlock() }
        return gen
    }

    func engage() {
        lock.lock()
        killed = true
        gen &+= 1
        lock.unlock()
    }

    /// Clears only if no kill happened since `generation` was read.
    func clear(ifGeneration g: UInt64) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard gen == g else { return false }
        killed = false
        return true
    }
}

// MARK: - File helpers

struct PosixError: Error, CustomStringConvertible {
    let call: String
    let code: Int32
    var description: String { "\(call): \(String(cString: strerror(code)))" }
}

func writeFileAtomically(_ path: String, _ data: Data, mode: mode_t) throws {
    let tmp = "\(path).tmp-\(getpid())"
    unlink(tmp)
    let fd = open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, mode)
    guard fd >= 0 else { throw PosixError(call: "open", code: errno) }
    var err: Int32 = 0
    data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
        guard let base = raw.baseAddress else { return }
        var off = 0
        while off < raw.count {
            let n = write(fd, base + off, raw.count - off)
            if n < 0 {
                if errno == EINTR { continue }
                err = errno
                return
            }
            off += n
        }
    }
    if err == 0, fsync(fd) != 0 { err = errno }
    close(fd)
    if err != 0 {
        unlink(tmp)
        throw PosixError(call: "write", code: err)
    }
    if rename(tmp, path) != 0 {
        let e = errno
        unlink(tmp)
        throw PosixError(call: "rename", code: e)
    }
}
