// Request dispatch, per-action access checks (Keychain state + DB, fail closed), kill/grant handling.
import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

final class Controller: RequestHandler {
    let config: HelperConfig
    let state: StateStore
    let db: BruceDatabase
    let killFlag: KillFlag
    private let auth: OwnerAuthenticating
    /// One owner-authentication prompt (grant/unkill) at a time; another one meanwhile gets `busy`.
    let authSlot = NSLock()

    // Bounded waits (seconds) so no op hangs on a Keychain prompt.
    static let accessWait: TimeInterval = 2
    static let promptStateWait: TimeInterval = 20
    static let authUpdateWait: TimeInterval = 60

    /// Touch ID text; built here from the validated id (never from the client).
    static func grantPrompt(_ agent: String) -> String { "allow Bruce Comm agent \"\(agent)\" to control this Mac" }
    static let unkillPrompt = "re-enable PC control for Bruce Comm agents"

    private let persistQueue = DispatchQueue(label: "BruceControl.persist", qos: .userInitiated)
    private let uiQueue = DispatchQueue(label: "BruceControl.ui", qos: .utility)
    private let miscLock = NSLock()
    private var _hotkeyRegistered = false
    private var _onKilledChange: ((Bool) -> Void)?

    init(config: HelperConfig, stateBackend: StateBackend, authenticator: OwnerAuthenticating) {
        let database = BruceDatabase(path: config.dbPath)
        let flag = KillFlag()
        self.config = config
        self.db = database
        self.killFlag = flag
        self.auth = authenticator
        self.state = StateStore(home: config.home, db: config.dbPath, backend: stateBackend, mirrorPath: config.statePath)
        // Startup check (first successful load only, never per action): a DB stop or an in-memory kill stops;
        // a grant whose agent is not switched on in the DB is dropped. When the DB cannot confirm anything (file or
        // tables missing, unreadable) this applies in memory only and the stored grants are kept.
        state.reconcile = { s in
            let info = try database.reconcileInfo()
            if info.killed || flag.value { s.killed = true }
            s.agents = s.agents.filter { info.enabled.contains($0) }
            if !info.complete { logLine("startup check: \(info.note); no grant is usable until the database confirms it (fail closed)") }
            return info.complete
        }
    }

    /// Starts loading the state in the background. Action ops wait (bounded) for it; status never does.
    func start() {
        state.start()
    }

    var hotkeyRegistered: Bool {
        get { miscLock.lock(); defer { miscLock.unlock() }; return _hotkeyRegistered }
        set { miscLock.lock(); _hotkeyRegistered = newValue; miscLock.unlock() }
    }

    /// Called (on the UI queue) with the effective kill state after refreshUI().
    var onKilledChange: ((Bool) -> Void)? {
        get { miscLock.lock(); defer { miscLock.unlock() }; return _onKilledChange }
        set { miscLock.lock(); _onKilledChange = newValue; miscLock.unlock() }
    }

    // MARK: - RequestHandler

    func handle(line: [UInt8], peerPid: Int32) -> String {
        let started = Date()
        var id = ""
        var op = "?"
        var agent: String?
        var outcome: Result<[String: Any], HelperError>
        do {
            guard let obj = (try? JSONSerialization.jsonObject(with: Data(line))) as? [String: Any] else {
                throw HelperError.invalid("request must be a JSON object")
            }
            guard let rid = obj["id"] as? String else { throw HelperError.invalid("id must be a string") }
            id = rid
            guard let rop = obj["op"] as? String, !rop.isEmpty else { throw HelperError.invalid("op must be a string") }
            op = clip(rop, 40)
            if let a = obj["agent"], !(a is NSNull) {
                guard let s = a as? String else { throw HelperError.invalid("agent must be a string") }
                agent = s
            }
            var args: [String: Any] = [:]
            if let a = obj["args"], !(a is NSNull) {
                guard let d = a as? [String: Any] else { throw HelperError.invalid("args must be an object") }
                args = d
            }
            // Keep App Nap from stretching event timing while an op runs.
            let activity = ProcessInfo.processInfo.beginActivity(
                options: [.userInitiatedAllowingIdleSystemSleep, .latencyCritical], reason: "Bruce Control op")
            defer { ProcessInfo.processInfo.endActivity(activity) }
            outcome = .success(try dispatch(op: rop, agent: agent, args: Args(args)))
        } catch {
            outcome = .failure(asHelperError(error))
        }
        let ms = Int(Date().timeIntervalSince(started) * 1000)
        let who = agent.map { isValidAgentId($0) ? $0 : "(invalid)" } ?? "-"
        let safeOp = op.allSatisfy { $0.isLetter || $0 == "_" } ? op : "(invalid)"
        switch outcome {
        case .success: logLine("op=\(safeOp) agent=\(who) peer_pid=\(peerPid) ok \(ms)ms")
        case .failure(let e): logLine("op=\(safeOp) agent=\(who) peer_pid=\(peerPid) error=\(e.code) \(ms)ms")
        }
        return Controller.encodeResponse(id: id, outcome)
    }

    static func encodeResponse(id: String, _ outcome: Result<[String: Any], HelperError>) -> String {
        var obj: [String: Any] = ["id": id]
        switch outcome {
        case .success(let r):
            obj["ok"] = true
            obj["result"] = r
        case .failure(let e):
            obj["ok"] = false
            obj["error"] = ["code": e.code, "message": e.message]
        }
        if JSONSerialization.isValidJSONObject(obj),
           let d = try? JSONSerialization.data(withJSONObject: obj, options: [.withoutEscapingSlashes]) {
            return String(decoding: d, as: UTF8.self)
        }
        let fallback: [String: Any] = ["id": id, "ok": false, "error": ["code": "failed", "message": "could not encode the result"]]
        if JSONSerialization.isValidJSONObject(fallback), let d = try? JSONSerialization.data(withJSONObject: fallback) {
            return String(decoding: d, as: UTF8.self)
        }
        return "{\"id\":\"\",\"ok\":false,\"error\":{\"code\":\"failed\",\"message\":\"could not encode the result\"}}"
    }

    // MARK: - Dispatch

    private static let actionOps: Set<String> = [
        "screenshot", "cursor", "mouse_move", "click", "drag", "scroll", "type", "key",
        "open_app", "open_url", "list_windows", "focus_window",
    ]

    func dispatch(op: String, agent: String?, args: Args) throws -> [String: Any] {
        switch op {
        case "status": return statusResult()
        case "displays": return ["displays": Displays.list().map { $0.json }]
        case "request_permissions": return requestPermissions()
        case "grant": return try grant(args)
        case "revoke": return try revoke(args)
        case "grants": return grantsResult()
        case "kill":
            // A malformed `by` must never block the kill.
            let rawBy = (try? args.string("by")) ?? nil
            let by = clip((rawBy?.isEmpty == false ? rawBy : nil) ?? "daemon", 32)
            let dbWritten = engageKill(by: by, waitForDatabase: true)
            return ["killed": true, "db_written": dbWritten]
        case "unkill":
            try releaseKill() // args.reason is ignored: the prompt text is fixed
            return ["killed": false]
        default:
            guard Controller.actionOps.contains(op) else { throw HelperError("unsupported", "unknown op '\(clip(op, 40))'") }
            return try runAction(op: op, agent: agent, args: args)
        }
    }

    // MARK: - Status / permissions

    /// From the in-memory snapshot only: never waits for the Keychain.
    func statusResult() -> [String: Any] {
        let snap = state.snapshot()
        return [
            "version": helperVersion,
            "pid": Int(getpid()),
            "app_path": Bundle.main.bundlePath,
            "home": config.home,
            "db": config.reportedDbPath,
            "killed": snap.state.killed || killFlag.value,
            "accessibility": AXIsProcessTrusted(),
            "screen_recording": CGPreflightScreenCaptureAccess(),
            "hotkey": hotkeyName,
            "hotkey_registered": hotkeyRegistered,
            "signature_ok": snap.signatureOk.map { $0 as Any } ?? NSNull(),
            "state_loading": snap.loading,
        ]
    }

    func grantsResult() -> [String: Any] {
        let snap = state.snapshot()
        return [
            "agents": snap.state.agents,
            "killed": snap.state.killed || killFlag.value,
            "signature_ok": snap.signatureOk.map { $0 as Any } ?? NSNull(),
            "state_loading": snap.loading,
            "home": config.home,
            "db": config.reportedDbPath,
        ]
    }

    /// Shows the macOS permission prompts (never edits settings).
    func requestPermissions() -> [String: Any] {
        let opts = ["AXTrustedCheckOptionPrompt": true] as CFDictionary
        _ = AXIsProcessTrustedWithOptions(opts)
        _ = CGRequestScreenCaptureAccess() // returns at once when already granted
        return statusResult()
    }

    static func requireAccessibility() throws {
        guard AXIsProcessTrusted() else { throw HelperError.accessibilityMissing }
    }

    static func requireScreenRecording() throws {
        guard CGPreflightScreenCaptureAccess() else { throw HelperError.screenRecordingMissing }
    }

    // MARK: - Grants

    private func agentArg(_ args: Args) throws -> String {
        guard let a = try args.string("agent"), isValidAgentId(a) else {
            throw HelperError.invalid("agent must be a Bruce agent id (^[a-z0-9][a-z0-9._-]{1,63}$)")
        }
        return a
    }

    /// Runs `body` holding the auth slot; `busy` if another grant/unkill is in progress.
    private func withAuthSlot<T>(_ body: () throws -> T) throws -> T {
        guard authSlot.try() else {
            throw HelperError("busy", "another Touch ID prompt from BruceControl is already open; finish it first")
        }
        defer { authSlot.unlock() }
        return try body()
    }

    /// Before a Touch ID prompt: no state load may still be waiting (e.g. for a Keychain prompt).
    private func requireSettledState() throws {
        guard state.waitSettled(timeout: Controller.promptStateWait) else { throw state.waitingError("; nothing was changed") }
    }

    private func grant(_ args: Args) throws -> [String: Any] {
        let agent = try agentArg(args) // args.reason is ignored
        try withAuthSlot {
            try requireSettledState()
            try auth.authenticate(reason: Controller.grantPrompt(agent))
            try state.update(reload: true, timeout: Controller.authUpdateWait) { s in
                if !s.agents.contains(agent) { s.agents.append(agent) }
            }
        }
        logLine("granted PC control to \(agent) (owner authenticated)")
        refreshUI()
        return ["granted": true]
    }

    private func revoke(_ args: Args) throws -> [String: Any] {
        let agent = try agentArg(args)
        let pending = state.revoke(agent) // memory at once; the Keychain is saved in the background
        logLine("revoked PC control for \(agent)" + (pending ? " (applied when the state loads)" : ""))
        refreshUI()
        return ["revoked": true, "pending": pending]
    }

    // MARK: - Kill switch

    /// Takes effect at once (memory flag), then the DB (waited for when `waitForDatabase`), then the Keychain in the
    /// background. Returns whether the DB write succeeded (true when not waited for).
    @discardableResult
    func engageKill(by: String, waitForDatabase: Bool) -> Bool {
        killFlag.engage()
        refreshUI()
        logLine("kill switch engaged by \(by)")
        let writeDb = { [db] () -> Bool in
            do {
                try db.writeKilled(true, by: by)
                return true
            } catch {
                logLine("kill: database not written: \(asHelperError(error).message)")
                return false
            }
        }
        state.persistKill()
        if waitForDatabase {
            let ok = writeDb()
            refreshUI()
            return ok
        }
        persistQueue.async { [self] in
            _ = writeDb()
            refreshUI()
        }
        return true
    }

    /// Owner auth, then killed = false in the Keychain state. A kill that lands meanwhile wins.
    func releaseKill() throws {
        try withAuthSlot {
            let gen = killFlag.generation
            try requireSettledState()
            try auth.authenticate(reason: Controller.unkillPrompt)
            try state.update(reload: true, timeout: Controller.authUpdateWait) { [killFlag] s in
                guard killFlag.generation == gen else { throw HelperError.killed("PC control was stopped again during re-enable") }
                s.killed = false
            }
            guard killFlag.clear(ifGeneration: gen) else {
                throw HelperError.killed("PC control was stopped again during re-enable")
            }
        }
        logLine("kill switch released (owner authenticated)")
        refreshUI()
    }

    /// Menu "Re-enable PC control…": unkill with owner auth, then DB killed='0' (updated_by 'menu'). Runs off the main thread.
    func menuReenable() {
        do {
            try releaseKill()
            try db.writeKilled(false, by: "menu")
            logLine("kill switch released from the menu")
        } catch {
            let e = asHelperError(error)
            logLine("menu re-enable failed: \(e.code) \(e.message)")
            DispatchQueue.main.async { NSSound.beep() }
        }
        refreshUI()
    }

    /// Recomputes the effective kill state off the main thread; never waits for the Keychain.
    func refreshUI() {
        uiQueue.async { [self] in
            var killed = killFlag.value
            if !killed { killed = state.snapshot().state.killed }
            if !killed, let dbKilled = try? db.readKilled() { killed = dbKilled }
            onKilledChange?(killed)
        }
    }

    // MARK: - Access check

    /// Security model 4: Keychain grant AND NOT Keychain stop AND DB enabled=1 AND DB killed != '1'. Errors and a
    /// state that is still loading fail closed (bounded wait).
    func checkAccess(_ agent: String?) throws {
        guard let agent, isValidAgentId(agent) else {
            throw HelperError.notAllowed("this op needs a valid agent id")
        }
        if killFlag.value { throw HelperError.killed("PC control is stopped (kill switch)") }
        guard let usable = state.usable(timeout: Controller.accessWait) else { throw state.waitingError() }
        let s = usable.state
        if s.killed {
            throw HelperError.killed(usable.signatureOk
                ? "PC control is stopped (kill switch)"
                : "PC control is stopped: BruceControl cannot read its state from the Keychain (fail closed)")
        }
        let access: DbAccess
        do {
            access = try db.access(agent: agent)
        } catch {
            throw HelperError.notAllowed("fail closed: cannot read PC control state from the Bruce Comm database (\(asHelperError(error).message))")
        }
        if access.killed { throw HelperError.killed("PC control is stopped (kill switch)") }
        guard s.agents.contains(agent) else {
            throw HelperError.notAllowed("agent '\(agent)' has no owner-approved PC-control grant")
        }
        guard access.enabled else {
            throw HelperError.notAllowed("agent '\(agent)' is not switched on for PC control")
        }
        if killFlag.value { throw HelperError.killed("PC control is stopped (kill switch)") }
    }

// MARK: - Action ops

    private func runAction(op: String, agent: String?, args: Args) throws -> [String: Any] {
        let gate: Gate = { [self] in try checkAccess(agent) }
        try gate()
        switch op {
        case "screenshot":
            let req = try ScreenshotRequest(args)
            try Controller.requireScreenRecording()
            let shot = try Capture.screenshot(req)
            try gate() // a stop during the capture wins: the image is dropped
            return shot

        case "cursor":
            let p = Input.cursor()
            return ["x": Double(p.x), "y": Double(p.y)]

        case "mouse_move":
            let p = try args.point()
            try Displays.requireOnScreen(p)
            try Controller.requireAccessibility()
            try gate()
            try Input.move(to: p)
            return ["x": Double(p.x), "y": Double(p.y)]

        case "click":
            let p = try args.point()
            try Displays.requireOnScreen(p)
            let button = try MouseButtonSpec.parse(try args.string("button"))
            let count = try args.int("count", default: 1, range: 1...3)
            let mods = try Input.parseModifiers(try args.stringArray("modifiers") ?? [])
            try Controller.requireAccessibility()
            try gate()
            try Input.click(at: p, button: button, count: count, modifiers: mods)
            return ["x": Double(p.x), "y": Double(p.y)]

        case "drag":
            guard let raw = try args.array("path"), raw.count >= 2 else {
                throw HelperError.invalid("path needs at least 2 points")
            }
            guard raw.count <= 1000 else { throw HelperError.invalid("path has too many points (max 1000)") }
            let path = try raw.enumerated().map { i, item -> CGPoint in
                guard let d = item as? [String: Any] else { throw HelperError.invalid("path[\(i)] must be {x,y}") }
                let p = try Args(d).point()
                try Displays.requireOnScreen(p, "path[\(i)]")
                return p
            }
            let button = try MouseButtonSpec.parse(try args.string("button"))
            let duration = try args.int("duration_ms", default: 400, range: 0...60_000)
            try Controller.requireAccessibility()
            try gate()
            try Input.drag(path: path, button: button, durationMs: duration, gate: gate)
            return [:]

        case "scroll":
            let p = try args.point()
            try Displays.requireOnScreen(p)
            guard let direction = try args.string("direction") else { throw HelperError.invalid("direction is required") }
            let amount = try args.int("amount", default: 3, range: 1...50)
            try Controller.requireAccessibility()
            try gate()
            try Input.scroll(at: p, direction: direction, amount: amount, gate: gate)
            return [:]

        case "type":
            guard let text = try args.string("text") else { throw HelperError.invalid("text is required") }
            try Controller.requireAccessibility()
            try gate()
            return ["typed": try Input.type(text, gate: gate)]

        case "key":
            guard let code = try args.int("key_code"), (0...127).contains(code) else {
                throw HelperError.invalid("key_code must be a macOS virtual key code 0..127")
            }
            let mods = try Input.parseModifiers(try args.stringArray("modifiers") ?? [])
            let repeatCount = try args.int("repeat", default: 1, range: 1...100)
            try Controller.requireAccessibility()
            try gate()
            try Input.key(code: CGKeyCode(code), modifiers: mods, repeatCount: repeatCount, gate: gate)
            return [:]

        case "open_app":
            guard let name = try args.string("name") else { throw HelperError.invalid("name is required") }
            try gate()
            return try Apps.openApp(name)

        case "open_url":
            guard let url = try args.string("url") else { throw HelperError.invalid("url is required") }
            let app = try args.string("app")
            try gate()
            return try Apps.openURL(url, app: (app?.isEmpty == false) ? app : nil)

        case "list_windows":
            let all = try args.bool("all") ?? false
            try Controller.requireScreenRecording()
            let windows = try Apps.listWindows(all: all)
            try gate() // a stop meanwhile wins: the list is dropped
            return windows

        case "focus_window":
            let wid = try args.int("window_id")
            let app = try args.string("app")
            let title = try args.string("title")
            try Controller.requireAccessibility()
            try gate()
            return try Apps.focusWindow(windowId: wid, app: app, title: title)

        default:
            throw HelperError("unsupported", "unknown op '\(op)'")
        }
    }
}
