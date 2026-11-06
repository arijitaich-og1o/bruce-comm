// Shared basics: config, errors, argument parsing, logging, small utilities.
import CoreGraphics
import Foundation
import os

let helperVersion = "1.1.0"
let hotkeyName = "ctrl+option+cmd+k"
let bundleIdentifier = "com.bruce.comm.pccontrol"
let dashboardURL = "http://127.0.0.1:7457/"
let maxRequestLineBytes = 1 << 20 // 1 MiB

// MARK: - Errors

struct HelperError: Error {
    let code: String
    let message: String
    init(_ code: String, _ message: String) {
        self.code = code
        self.message = message
    }

    static func invalid(_ m: String) -> HelperError { HelperError("invalid_argument", m) }
    static func failed(_ m: String) -> HelperError { HelperError("failed", m) }
    static func notFound(_ m: String) -> HelperError { HelperError("not_found", m) }
    static func notAllowed(_ m: String) -> HelperError { HelperError("not_allowed", m) }
    static func killed(_ m: String) -> HelperError { HelperError("killed", m) }

    static let accessibilityMissing = HelperError(
        "permission_missing",
        "Accessibility permission missing: allow Bruce Control in System Settings > Privacy & Security > Accessibility")
    static let screenRecordingMissing = HelperError(
        "permission_missing",
        "Screen Recording permission missing: allow Bruce Control in System Settings > Privacy & Security > Screen & System Audio Recording")
}

/// Any Error as a HelperError (unknown errors become `failed`).
func asHelperError(_ error: Error) -> HelperError {
    if let e = error as? HelperError { return e }
    return .failed(String(describing: error))
}

// MARK: - Config

struct HelperConfig {
    /// Absolute home; realpath'd by canonicalized() once the directory exists.
    let home: String
    /// Absolute DB path (--db, else <home>/bruce-comm.db).
    let dbPath: String
    /// True when the DB path came from --db.
    let dbExplicit: Bool

    var controlDir: String { (home as NSString).appendingPathComponent("pc-control") }
    /// Read-only mirror of the Keychain state, for humans; never read back.
    var statePath: String { (controlDir as NSString).appendingPathComponent("state.json") }
    var socketPath: String { (controlDir as NSString).appendingPathComponent("helper.sock") }

    /// Args: --home <dir> (default $BRUCE_COMM_HOME or ~/.bruce-comm), optional --db <file>. Unknown args are ignored.
    static func fromArguments(_ argv: [String]) -> HelperConfig {
        var home: String?
        var db: String?
        var i = 1
        while i < argv.count {
            let a = argv[i]
            if (a == "--home" || a == "--db"), i + 1 < argv.count {
                if a == "--home" { home = argv[i + 1] } else { db = argv[i + 1] }
                i += 2
                continue
            }
            if a.hasPrefix("--home=") { home = String(a.dropFirst(7)) }
            if a.hasPrefix("--db=") { db = String(a.dropFirst(5)) }
            i += 1
        }
        if home == nil || home!.isEmpty {
            let env = ProcessInfo.processInfo.environment["BRUCE_COMM_HOME"] ?? ""
            home = env.isEmpty ? (userHomeDirectory() as NSString).appendingPathComponent(".bruce-comm") : env
        }
        let h = absolutePath(home!)
        if let d = db, !d.isEmpty {
            return HelperConfig(home: h, dbPath: absolutePath(d), dbExplicit: true)
        }
        return HelperConfig(home: h, dbPath: (h as NSString).appendingPathComponent("bruce-comm.db"), dbExplicit: false)
    }

    /// Same config with canonical paths (call after the home directory exists). The DB path is bound into the
    /// stored state, so it is canonicalized the way Node does it (realpath of the deepest existing ancestor).
    func canonicalized() -> HelperConfig {
        let h = realPath(home) ?? home
        if dbExplicit { return HelperConfig(home: h, dbPath: canonicalPath(dbPath), dbExplicit: true) }
        return HelperConfig(home: h, dbPath: canonicalPath((h as NSString).appendingPathComponent("bruce-comm.db")), dbExplicit: false)
    }

    /// DB path for status (same canonical form as Node's canonicalPath).
    var reportedDbPath: String { canonicalPath(dbPath) }
}

func absolutePath(_ p: String) -> String {
    let expanded = (p as NSString).expandingTildeInPath
    if expanded.hasPrefix("/") { return (expanded as NSString).standardizingPath }
    let cwd = FileManager.default.currentDirectoryPath
    return ((cwd as NSString).appendingPathComponent(expanded) as NSString).standardizingPath
}

/// realpath(3), nil when the path does not exist.
func realPath(_ p: String) -> String? {
    guard let r = realpath(p, nil) else { return nil }
    defer { free(r) }
    return String(cString: r)
}

/// Absolute path with the deepest existing ancestor realpath'd (Node: canonicalPath in helper-client.ts).
func canonicalPath(_ p: String) -> String {
    let abs = absolutePath(p)
    var rest: [String] = []
    var dir = abs
    while true {
        if let r = realPath(dir) {
            return rest.reduce(r) { ($0 as NSString).appendingPathComponent($1) }
        }
        let parent = (dir as NSString).deletingLastPathComponent
        if parent == dir || parent.isEmpty { return abs }
        rest.insert((dir as NSString).lastPathComponent, at: 0)
        dir = parent
    }
}

/// The user's home from the password database (ignores $HOME, which a launcher can set).
func userHomeDirectory() -> String {
    if let pw = getpwuid(getuid()), let dir = pw.pointee.pw_dir {
        let s = String(cString: dir)
        if !s.isEmpty { return s }
    }
    return NSHomeDirectory()
}

// MARK: - Logging (stderr + unified log, one line; never typed text)

private let logDateFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let logLock = NSLock()
private let opsLogger = Logger(subsystem: bundleIdentifier, category: "ops")
/// Unified-log output (`log show --predicate 'subsystem == "com.bruce.comm.pccontrol"'`); tests switch it off.
var unifiedLogEnabled = true

func logLine(_ message: String) {
    if unifiedLogEnabled { opsLogger.notice("\(message, privacy: .public)") }
    logLock.lock()
    defer { logLock.unlock() }
    let line = "\(logDateFormatter.string(from: Date())) BruceControl[\(getpid())] \(message)\n"
    let bytes = Array(line.utf8)
    _ = bytes.withUnsafeBytes { write(STDERR_FILENO, $0.baseAddress, $0.count) } // never raises, unlike FileHandle
}

// MARK: - Small utilities

func nowMs() -> Int64 { Int64((Date().timeIntervalSince1970 * 1000).rounded()) }

func sleepMs(_ ms: Double) {
    guard ms > 0 else { return }
    usleep(useconds_t(min(ms, 60_000) * 1000))
}

func clip(_ s: String, _ max: Int) -> String {
    s.count <= max ? s : String(s.prefix(max))
}

/// Bruce agent ids: ^[a-z0-9][a-z0-9._-]{1,63}$ (same as Node's idPattern).
func isValidAgentId(_ s: String) -> Bool {
    let u = Array(s.utf8)
    guard u.count >= 2, u.count <= 64 else { return false }
    for (i, c) in u.enumerated() {
        let alnum = (c >= 0x61 && c <= 0x7A) || (c >= 0x30 && c <= 0x39)
        if i == 0 { if !alnum { return false } } else if !(alnum || c == 0x2E || c == 0x5F || c == 0x2D) { return false }
    }
    return true
}

func isBoolNumber(_ n: NSNumber) -> Bool { CFGetTypeID(n) == CFBooleanGetTypeID() }

/// Thread-safe one-shot result holder for bridging async callbacks to blocking code.
final class ResultBox<T> {
    private let lock = NSLock()
    private var value: T?
    func set(_ v: T) {
        lock.lock()
        if value == nil { value = v }
        lock.unlock()
    }
    func get() -> T? {
        lock.lock()
        defer { lock.unlock() }
        return value
    }
}

/// Runs `start` (which must call `finish` exactly once, on any thread) and waits up to `timeout` seconds.
func waitFor<T>(timeout: TimeInterval, _ start: (@escaping (T) -> Void) -> Void) -> T? {
    let sem = DispatchSemaphore(value: 0)
    let box = ResultBox<T>()
    start { v in
        box.set(v)
        sem.signal()
    }
    if sem.wait(timeout: .now() + timeout) == .timedOut { return box.get() }
    return box.get()
}

// MARK: - Request arguments

struct Args {
    let raw: [String: Any]
    init(_ raw: [String: Any]) { self.raw = raw }

    private func value(_ k: String) -> Any? {
        guard let v = raw[k], !(v is NSNull) else { return nil }
        return v
    }

    func has(_ k: String) -> Bool { value(k) != nil }

    func string(_ k: String) throws -> String? {
        guard let v = value(k) else { return nil }
        guard let s = v as? String else { throw HelperError.invalid("\(k) must be a string") }
        return s
    }

    func number(_ k: String) throws -> Double? {
        guard let v = value(k) else { return nil }
        guard let n = v as? NSNumber, !isBoolNumber(n) else { throw HelperError.invalid("\(k) must be a number") }
        let d = n.doubleValue
        guard d.isFinite else { throw HelperError.invalid("\(k) must be a finite number") }
        return d
    }

    func int(_ k: String) throws -> Int? {
        guard let d = try number(k) else { return nil }
        guard d == d.rounded(), abs(d) < 9.0e15 else { throw HelperError.invalid("\(k) must be an integer") }
        return Int(d)
    }

    func int(_ k: String, default def: Int, range: ClosedRange<Int>) throws -> Int {
        let v = try int(k) ?? def
        guard range.contains(v) else {
            throw HelperError.invalid("\(k) must be between \(range.lowerBound) and \(range.upperBound)")
        }
        return v
    }

    func bool(_ k: String) throws -> Bool? {
        guard let v = value(k) else { return nil }
        guard let n = v as? NSNumber, isBoolNumber(n) else { throw HelperError.invalid("\(k) must be a boolean") }
        return n.boolValue
    }

    func object(_ k: String) throws -> Args? {
        guard let v = value(k) else { return nil }
        guard let d = v as? [String: Any] else { throw HelperError.invalid("\(k) must be an object") }
        return Args(d)
    }

    func array(_ k: String) throws -> [Any]? {
        guard let v = value(k) else { return nil }
        guard let a = v as? [Any] else { throw HelperError.invalid("\(k) must be an array") }
        return a
    }

    func stringArray(_ k: String) throws -> [String]? {
        guard let a = try array(k) else { return nil }
        return try a.map { item -> String in
            guard let s = item as? String else { throw HelperError.invalid("\(k) must be an array of strings") }
            return s
        }
    }

    /// Required finite x/y pair.
    func point(_ xKey: String = "x", _ yKey: String = "y") throws -> CGPoint {
        guard let x = try number(xKey), let y = try number(yKey) else {
            throw HelperError.invalid("\(xKey) and \(yKey) are required numbers (global screen points)")
        }
        return CGPoint(x: x, y: y)
    }

    /// Optional {x,y,width,height}.
    func rect(_ k: String) throws -> CGRect? {
        guard let o = try object(k) else { return nil }
        guard let x = try o.number("x"), let y = try o.number("y"),
              let w = try o.number("width"), let h = try o.number("height") else {
            throw HelperError.invalid("\(k) needs numeric x, y, width, height")
        }
        guard w > 0, h > 0 else { throw HelperError.invalid("\(k) width and height must be > 0") }
        return CGRect(x: x, y: y, width: w, height: h)
    }
}
