// Input event construction (recorded, never posted), SQLite kill upsert, socket protocol, startup checks.
import CoreGraphics
import Darwin
import Foundation

// MARK: - Input (events are recorded by a poster closure; nothing reaches the HID tap)

private struct Rec: Equatable {
    let type: UInt32
    let code: Int64
    let flags: UInt64
    let clickState: Int64
}

private final class Recorder {
    private(set) var events: [Rec] = []
    func post(_ e: CGEvent) {
        events.append(Rec(type: e.type.rawValue, code: e.getIntegerValueField(.keyboardEventKeycode),
                          flags: e.flags.rawValue & relevantFlags, clickState: e.getIntegerValueField(.mouseEventClickState)))
    }
}

private let relevantFlags = CGEventFlags([.maskCommand, .maskShift, .maskAlternate, .maskControl, .maskSecondaryFn]).rawValue
private let flagsChanged = CGEventType.flagsChanged.rawValue

func testInput() {
    group("modifier key sequence")
    do {
        let m = try Input.parseModifiers(["cmd", "SHIFT", "cmd", "fn"])
        checkEq(m.keys, [55, 56], "cmd + shift pressed as real keys, duplicates ignored")
        check(m.flags.contains(.maskSecondaryFn) && m.flags.contains(.maskCommand) && m.flags.contains(.maskShift), "fn is a flag only")
        let s = Input.modifierStrokes(m)
        checkEq(s.press, [KeyStroke(code: 55, down: true, flags: .maskCommand),
                          KeyStroke(code: 56, down: true, flags: [.maskCommand, .maskShift])], "presses with growing flags")
        checkEq(s.release, [KeyStroke(code: 56, down: false, flags: .maskCommand),
                            KeyStroke(code: 55, down: false, flags: [])], "releases in reverse with shrinking flags")
    } catch {
        check(false, "parseModifiers threw", "\(error)")
    }
    do {
        _ = try Input.parseModifiers(["hyper"])
        check(false, "unknown modifier refused")
    } catch {
        checkEq(asHelperError(error).code, "invalid_argument", "unknown modifier refused")
    }

    group("modifiers released when the gate throws")
    var posted: [String] = []
    struct Stop: Error {}
    do {
        try Input.holding(["d1", "d2"], ["u2", "u1"], post: { posted.append($0) }) {
            posted.append("body")
            throw Stop()
        }
    } catch {}
    checkEq(posted, ["d1", "d2", "body", "u2", "u1"], "holding() posts releases after a throw")

    do {
        let rec = Recorder()
        let mods = try Input.parseModifiers(["cmd", "shift"])
        var gateCalls = 0
        var thrown: String?
        do {
            try Input.key(code: 0, modifiers: mods, repeatCount: 3, gate: {
                gateCalls += 1
                if gateCalls == 1 { throw HelperError.killed("stopped") }
            }, post: rec.post)
        } catch {
            thrown = asHelperError(error).code
        }
        checkEq(thrown, "killed", "key() reports the gate's stop")
        let cmd = CGEventFlags.maskCommand.rawValue
        let cmdShift = cmd | CGEventFlags.maskShift.rawValue
        let want = [
            Rec(type: flagsChanged, code: 55, flags: cmd, clickState: 0),
            Rec(type: flagsChanged, code: 56, flags: cmdShift, clickState: 0),
            Rec(type: CGEventType.keyDown.rawValue, code: 0, flags: cmdShift, clickState: 0),
            Rec(type: CGEventType.keyUp.rawValue, code: 0, flags: cmdShift, clickState: 0),
            Rec(type: flagsChanged, code: 56, flags: cmd, clickState: 0),
            Rec(type: flagsChanged, code: 55, flags: 0, clickState: 0),
        ]
        checkEq(rec.events, want, "key(): modifiers down, one key press, gate stops, modifiers up in reverse")
    } catch {
        check(false, "key() setup threw", "\(error)")
    }

    do {
        let rec = Recorder()
        try Input.click(at: CGPoint(x: 10, y: 20), button: MouseButtonSpec.parse("left"), count: 2,
                        modifiers: Input.parseModifiers(["option"]), post: rec.post)
        let opt = CGEventFlags.maskAlternate.rawValue
        let want = [
            Rec(type: CGEventType.mouseMoved.rawValue, code: 0, flags: 0, clickState: 0),
            Rec(type: flagsChanged, code: 58, flags: opt, clickState: 0),
            Rec(type: CGEventType.leftMouseDown.rawValue, code: 0, flags: opt, clickState: 1),
            Rec(type: CGEventType.leftMouseUp.rawValue, code: 0, flags: opt, clickState: 1),
            Rec(type: CGEventType.leftMouseDown.rawValue, code: 0, flags: opt, clickState: 2),
            Rec(type: CGEventType.leftMouseUp.rawValue, code: 0, flags: opt, clickState: 2),
            Rec(type: flagsChanged, code: 58, flags: 0, clickState: 0),
        ]
        checkEq(rec.events.map { Rec(type: $0.type, code: $0.type == flagsChanged ? $0.code : 0, flags: $0.flags, clickState: $0.clickState) },
                want, "click(): move, option down, double click with click states 1..2, option up")
    } catch {
        check(false, "click() threw", "\(error)")
    }

    group("drag and typing plans (no events)")
    let steps = Input.dragSteps([CGPoint(x: 0, y: 0), CGPoint(x: 100, y: 0), CGPoint(x: 100, y: 50)], durationMs: 400)
    check(steps.count == 25 && steps.last == CGPoint(x: 100, y: 50) && steps.contains(CGPoint(x: 100, y: 0)),
          "drag steps hit every vertex and end on the last point", "\(steps.count)")
    let chunks = Input.typeChunks("hello world, this is long\nok\t!")
    check(chunks.contains(.key(Input.returnKey, units: 1)) && chunks.contains(.key(Input.tabKey, units: 1))
          && chunks.allSatisfy { if case .text(let u) = $0 { return u.count <= 16 } else { return true } },
          "typing: <=16 UTF-16 units per chunk, newline -> Return, tab -> Tab")
}

// MARK: - Database

func testDatabase() {
    group("writeKilled keeps the first stop (WHERE clause)")
    check(writeKilledSQL.contains("WHERE pc_control_state.value <> excluded.value"), "upsert has the WHERE clause")
    let dir = TempRoot.dir("d")
    let path = dir + "/bruce-comm.db"
    let t = TestDB(path: path)
    let db = BruceDatabase(path: path)
    func write(_ k: Bool, _ by: String) {
        do { try db.writeKilled(k, by: by) } catch { check(false, "writeKilled threw", "\(error)") }
        usleep(5_000)
    }
    write(true, "first")
    let r1 = t.killedRow()
    write(true, "second")
    let r2 = t.killedRow()
    check(r1?.value == "1" && r2?.value == "1" && r2?.by == "first" && r2?.at == r1?.at, "a repeated stop keeps the first who/when",
          "\(String(describing: r1)) \(String(describing: r2))")
    write(false, "menu")
    check(t.killedRow()?.value == "0" && t.killedRow()?.by == "menu", "1 -> 0 applies")
    write(true, "hotkey")
    check(t.killedRow()?.value == "1" && t.killedRow()?.by == "hotkey", "0 -> 1 applies")

    let empty = dir + "/empty.db"
    _ = TestDB(path: empty, tables: false)
    let edb = BruceDatabase(path: empty)
    do {
        _ = try edb.access(agent: "a1")
        check(false, "access() on a DB without tables must fail closed")
    } catch {
        check(true, "access() on a DB without tables throws (fail closed)")
    }
    do {
        try edb.writeKilled(true, by: "x")
        check(TestDB(path: empty, tables: false).killedRow()?.value == "1", "writeKilled creates pc_control_state when missing")
    } catch {
        check(false, "writeKilled on an empty DB", "\(error)")
    }
    do {
        let info = try edb.reconcileInfo()
        check(!info.complete && info.killed && info.enabled.isEmpty && info.note.contains("pc_control_agents"),
              "reconcileInfo: a missing table is incomplete", "\(info)")
        let full = try db.reconcileInfo()
        check(full.complete && full.killed, "reconcileInfo: complete with both tables", "\(full)")
        let none = try BruceDatabase(path: dir + "/nope.db").reconcileInfo()
        check(!none.complete && none.note.contains("no database file"), "reconcileInfo: no file is incomplete")
        check(!FileManager.default.fileExists(atPath: dir + "/nope.db"), "the check never creates the DB file")
    } catch {
        check(false, "reconcileInfo threw", "\(error)")
    }
}

// MARK: - Socket protocol

func testSocket() {
    group("socket protocol")
    let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"]))
    let server = SocketServer(path: f.config.socketPath)
    do {
        try server.bindAndListen()
    } catch {
        check(false, "bindAndListen", "\(error)")
        return
    }
    server.startAccepting(f.controller)
    var sb = stat()
    check(lstat(f.config.socketPath, &sb) == 0 && (sb.st_mode & S_IFMT) == S_IFSOCK && (sb.st_mode & 0o777) == 0o600, "socket is 0600")
    check(stat(f.config.controlDir, &sb) == 0 && (sb.st_mode & 0o777) == 0o700, "control dir is 0700")

    guard let c = SocketClient(path: f.config.socketPath) else {
        check(false, "connect to the helper socket")
        return
    }
    c.send("{\"id\":\"1\",\"op\":\"status\"}\n{\"id\":\"2\",\"op\":\"grants\"}\n{\"id\":\"3\",\"op\":\"nope\"}\n")
    let r = (0..<3).map { _ in parseLine(c.readLine() ?? "") }
    check(r.map { $0["id"] as? String } == ["1", "2", "3"], "pipelined requests answered in order", "\(r)")
    check(isOk(r[0]) && isOk(r[1]) && errCode(r[2]) == "unsupported", "status ok, grants ok, unknown op unsupported")
    c.send("not json\n")
    let bad = parseLine(c.readLine() ?? "")
    check(errCode(bad) == "invalid_argument" && bad["id"] as? String == "", "malformed line -> invalid_argument, connection stays", "\(bad)")
    c.send("{\"id\":\"4\",\"op\":\"status\"}\r\n\n   \n")
    checkEq(parseLine(c.readLine() ?? "")["id"] as? String, "4", "CRLF accepted, blank lines ignored")
    c.send("{\"id\":\"5\",\"op\":\"click\",\"agent\":\"zz\",\"args\":{\"x\":1,\"y\":1}}\n")
    checkEq(errCode(parseLine(c.readLine() ?? "")), "not_allowed", "action for an agent without a grant refused")
    c.send("{\"id\":\"6\",\"op\":\"cursor\",\"agent\":\"a1\"}\n")
    check(isOk(parseLine(c.readLine() ?? "")), "allowed read-only action over the socket")
    c.send("{\"id\":\"7\",\"op\":\"status\"}")
    c.shutdownWrite()
    checkEq(parseLine(c.readLine() ?? "")["id"] as? String, "7", "final unterminated line answered at EOF")

    // uid / pid of the peer
    var cred = xucred()
    var len = socklen_t(MemoryLayout<xucred>.size)
    if let c2 = SocketClient(path: f.config.socketPath) {
        let rc = withUnsafeMutablePointer(to: &cred) { getsockopt(c2.fd, SOL_LOCAL, LOCAL_PEERCRED, $0, &len) }
        check(rc == 0 && cred.cr_uid == getuid(), "LOCAL_PEERCRED gives this user's uid")
        checkEq(peerUID(c2.fd), getuid(), "peerUID() reads it")
        checkEq(peerPID(c2.fd), getpid(), "peerPID() gives the peer pid")
    }
    check(peerAllowed(getuid()) && !peerAllowed(nil) && !peerAllowed(getuid() &+ 1) && !peerAllowed(0, own: 501),
          "peerAllowed: only this uid; unknown or other uid refused")

    group("oversize request line")
    for withNewline in [false, true] {
        guard let big = SocketClient(path: f.config.socketPath) else { continue }
        var payload = [UInt8](repeating: 0x61, count: maxRequestLineBytes + 10)
        if withNewline { payload.append(0x0A) }
        let writer = Background { big.send(payload) }
        let resp = parseLine(big.readLine() ?? "")
        check(errCode(resp) == "invalid_argument" && errMessage(resp).contains("1 MiB"),
              "line over 1 MiB refused" + (withNewline ? " (terminated)" : " (unterminated)"), "\(resp)")
        check(big.atEOF(), "connection closed after an oversize line")
        _ = writer.wait(5)
    }
    guard let after = SocketClient(path: f.config.socketPath) else {
        check(false, "server still accepts after an oversize line")
        return
    }
    after.send("{\"id\":\"8\",\"op\":\"status\"}\n")
    checkEq(parseLine(after.readLine() ?? "")["id"] as? String, "8", "server still answers new connections")

    group("never takes over a live socket")
    let second = SocketServer(path: f.config.socketPath)
    do {
        try second.bindAndListen()
        check(false, "binding over a live helper must fail")
    } catch {
        check(error is SocketInUse, "SocketInUse when the path accepts connections", "\(error)")
    }
    if let again = SocketClient(path: f.config.socketPath) {
        again.send("{\"id\":\"9\",\"op\":\"status\"}\n")
        checkEq(parseLine(again.readLine() ?? "")["id"] as? String, "9", "the live helper keeps its socket")
    } else {
        check(false, "the live helper keeps its socket")
    }
    // A stale socket file (nobody listening) is replaced; a non-socket file is never touched.
    let dir = TempRoot.dir("s")
    let stalePath = dir + "/stale.sock"
    check(makeStaleSocket(stalePath), "stale socket file created (bound, then closed without unlink)")
    do {
        let probe = SocketServer(path: stalePath)
        try probe.bindAndListen()
        check(true, "a stale socket file is replaced")
        probe.stop()
    } catch {
        check(false, "a stale socket file is replaced", "\(error)")
    }
    let plain = dir + "/plain"
    FileManager.default.createFile(atPath: plain, contents: Data("keep".utf8))
    do {
        try SocketServer(path: plain).bindAndListen()
        check(false, "a non-socket file is refused")
    } catch {
        check((try? String(contentsOfFile: plain, encoding: .utf8)) == "keep", "a non-socket file is refused and kept")
    }
}

/// Binds a unix socket at `path` and closes it without unlinking: a socket file nobody listens on.
private func makeStaleSocket(_ path: String) -> Bool {
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
    withUnsafeMutableBytes(of: &addr.sun_path) { raw in
        raw.copyBytes(from: bytes)
        raw[bytes.count] = 0
    }
    addr.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
    }
    var sb = stat()
    return rc == 0 && lstat(path, &sb) == 0 && (sb.st_mode & S_IFMT) == S_IFSOCK
}

// MARK: - Startup

func testStartup() {
    group("per-user instance lock")
    let dir = TempRoot.dir("l")
    let lockPath = dir + "/sub/instance.lock"
    guard case .acquired(let fd) = acquireInstanceLock(lockPath) else {
        check(false, "first acquire")
        return
    }
    check(true, "first acquire")
    var sb = stat()
    check(stat(dir + "/sub", &sb) == 0 && (sb.st_mode & 0o777) == 0o700, "lock dir is 0700")
    if case .held = acquireInstanceLock(lockPath) { check(true, "second acquire sees it held") } else { check(false, "second acquire sees it held") }
    close(fd)
    if case .acquired(let fd2) = acquireInstanceLock(lockPath) {
        check(true, "re-acquired after release")
        close(fd2)
    } else {
        check(false, "re-acquired after release")
    }
    let link = dir + "/link.lock"
    symlink(dir + "/elsewhere", link)
    if case .failed = acquireInstanceLock(link) { check(true, "a symlinked lock file is refused") } else { check(false, "a symlinked lock file is refused") }

    group("another running helper (bundle id check)")
    let me = HelperProcess(pid: 500, startSec: 100, startUsec: 0)
    checkEq(olderHelper(own: me, others: []), nil, "alone: keep running")
    checkEq(olderHelper(own: me, others: [HelperProcess(pid: 400, startSec: 90, startUsec: 0)]), 400, "an older helper wins: exit")
    checkEq(olderHelper(own: me, others: [HelperProcess(pid: 600, startSec: 101, startUsec: 0)]), nil, "a younger one quits on its own")
    checkEq(olderHelper(own: me, others: [HelperProcess(pid: 450, startSec: 100, startUsec: 0)]), 450, "same start: lower pid wins")
    checkEq(olderHelper(own: me, others: [HelperProcess(pid: 500, startSec: 1, startUsec: 0)]), nil, "own pid ignored")
    let mine = processStartTime(getpid())
    check(mine != nil && (mine?.sec ?? 0) > 1_600_000_000, "processStartTime(self)")
    check(processStartTime(999_999) == nil, "processStartTime of a missing pid is nil")
    let other = olderRunningHelper() // read-only LaunchServices query
    check(other != getpid(), "olderRunningHelper never names this process")

    group("control directory")
    let home = TempRoot.dir("p")
    let real = TempRoot.dir("q")
    symlink(real, home + "/pc-control")
    do {
        try prepareControlDirectory(HelperConfig.fromArguments(["x", "--home", home]))
        check(false, "a symlinked pc-control dir is refused")
    } catch {
        check(true, "a symlinked pc-control dir is refused")
    }
}
