// State codec, config paths, home/DB binding, startup check (incl. the reconcile races) and blocked-Keychain behaviour.
import Foundation

func testCodecAndConfig() {
    group("state codec")
    let s = StoredState(home: "/h", db: "/h/bruce-comm.db", agents: ["b1", "a1", "a1"], killed: true, seq: 7, updatedAt: 123)
    let text = String(decoding: StateCodec.encode(s), as: UTF8.self)
    checkEq(text, #"{"agents":["a1","b1"],"db":"/h/bruce-comm.db","home":"/h","killed":true,"seq":7,"updated_at":123,"version":2}"#,
            "canonical JSON: sorted keys, sorted unique agents, db bound")
    checkEq(StateCodec.decode(Data(text.utf8)),
            StoredState(home: "/h", db: "/h/bruce-comm.db", agents: ["a1", "b1"], killed: true, seq: 7, updatedAt: 123), "round trip")
    let legacy = StateCodec.decode(Data(#"{"agents":["a1"],"home":"/h","killed":false,"seq":1,"updated_at":1,"version":2}"#.utf8))
    check(legacy != nil && legacy?.db == nil, "a version-2 item without db decodes with db = nil (treated as a mismatch)")
    let bad: [(String, String)] = [
        (#"{"agents":[],"db":"/d","home":"/h","killed":false,"seq":1,"updated_at":1,"version":1}"#, "version 1"),
        (#"{"agents":[],"db":"/d","home":"h","killed":false,"seq":1,"updated_at":1,"version":2}"#, "relative home"),
        (#"{"agents":[],"db":"d.db","home":"/h","killed":false,"seq":1,"updated_at":1,"version":2}"#, "relative db"),
        (#"{"agents":[],"db":5,"home":"/h","killed":false,"seq":1,"updated_at":1,"version":2}"#, "db not a string"),
        (#"{"agents":[],"db":null,"home":"/h","killed":false,"seq":1,"updated_at":1,"version":2}"#, "db null"),
        (#"{"agents":["A!"],"db":"/d","home":"/h","killed":false,"seq":1,"updated_at":1,"version":2}"#, "invalid agent id"),
        (#"{"agents":[],"db":"/d","home":"/h","killed":1,"seq":1,"updated_at":1,"version":2}"#, "killed as a number"),
        (#"{"agents":[],"db":"/d","home":"/h","killed":false,"seq":true,"updated_at":1,"version":2}"#, "seq as a boolean"),
        (#"{"agents":[],"db":"/d","home":"/h","killed":false,"seq":-1,"updated_at":1,"version":2}"#, "negative seq"),
        (#"[1,2]"#, "not an object"),
        ("garbage", "not JSON"),
    ]
    for (json, why) in bad { check(StateCodec.decode(Data(json.utf8)) == nil, "decode rejects \(why) (fail closed)") }

    group("config paths")
    let root = TempRoot.dir("c")
    let realRoot = realPath(root) ?? root
    let cfg = HelperConfig.fromArguments(["x", "--home", root + "/home/../home", "--db=" + root + "/data/x.db", "--other"])
    check(cfg.dbExplicit && cfg.home == root + "/home" && cfg.dbPath == root + "/data/x.db", "--home / --db= parsed and standardized",
          "\(cfg.home) \(cfg.dbPath)")
    mkdir(root + "/home", 0o700)
    let canon = cfg.canonicalized()
    checkEq(canon.home, realPath(root + "/home") ?? "?", "home is realpath'd")
    checkEq(canon.dbPath, realRoot + "/data/x.db", "db not created yet: deepest existing ancestor realpath'd (like Node)")
    let def = HelperConfig.fromArguments(["x", "--home", root + "/home"]).canonicalized()
    check(!def.dbExplicit && def.dbPath == (realPath(root + "/home") ?? "?") + "/bruce-comm.db", "default db = <home>/bruce-comm.db",
          def.dbPath)
    symlink(root + "/home", root + "/lnk")
    checkEq(canonicalPath(root + "/lnk/sub/bruce-comm.db"), (realPath(root + "/home") ?? "?") + "/sub/bruce-comm.db",
            "canonicalPath resolves a symlinked ancestor")
}

func testHomeDbBinding() {
    let cases: [(String, (String, String) -> StoredState?)] = [
        ("another database", { h, d in StoredState(home: h, db: d + ".other", agents: ["a1"], killed: false, seq: 5, updatedAt: 1) }),
        ("another home", { h, d in StoredState(home: h + "-x", db: d, agents: ["a1"], killed: false, seq: 5, updatedAt: 1) }),
        ("no db recorded (older item)", { h, _ in StoredState(home: h, db: nil, agents: ["a1"], killed: false, seq: 5, updatedAt: 1) }),
    ]
    for (label, make) in cases {
        group("stored state for \(label)")
        let f = Fixture(enabled: ["a1", "a2"], stored: make)
        let original = f.backend.raw
        let g = resultOf(f.call("grants"))
        check((g["agents"] as? [String]) == [] && (g["killed"] as? Bool) == false && (g["signature_ok"] as? Bool) == true,
              "loads as {agents:[], killed:false}", "\(g)")
        checkEq(f.access("a1"), "not_allowed", "the other setup's grant is not usable here")
        checkEq(f.backend.writes, 0, "startup check does not write back")
        check(isOk(f.call("kill", ["by": "test"])), "kill ok")
        f.state.waitIdle()
        check(f.backend.raw == original, "kill does not overwrite the other setup's item (memory + DB only)")
        checkEq(f.access("a1"), "killed", "kill enforced")
        _ = f.call("revoke", ["agent": "a1"])
        f.state.waitIdle()
        check(f.backend.raw == original, "revoke does not overwrite it")
        check(isOk(f.call("unkill")), "unkill ok (owner auth)")
        check(f.backend.raw == original, "unkill does not overwrite it")
        f.db?.setKilled(false) // what Node does after a successful unkill
        check(isOk(f.call("grant", ["agent": "a2"])), "grant ok")
        let st = f.backend.stored
        check(st?.home == f.home && st?.db == f.config.dbPath && st?.agents == ["a2"] && st?.seq == 6,
              "a grant takes the item over for this home + db (seq continues)", "\(String(describing: st))")
        checkEq(f.access("a2"), "ok", "granted + enabled agent allowed")
    }

    group("malformed stored state")
    let f = Fixture(enabled: ["a1"], raw: Data("not json".utf8))
    let g = resultOf(f.call("grants"))
    check((g["signature_ok"] as? Bool) == false && (g["killed"] as? Bool) == true && (g["agents"] as? [String]) == [],
          "fail closed: signature_ok false, killed, no agents", "\(g)")
    checkEq(f.access("a1"), "killed", "actions refused")
    check(isOk(f.call("grant", ["agent": "a1"])), "a grant may replace the unreadable item")
    let st = f.backend.stored
    check(st?.agents == ["a1"] && st?.killed == true && st?.db == f.config.dbPath, "rewritten from fail-closed values (still stopped)",
          "\(String(describing: st))")
}

func testReconcile() {
    group("startup check with a complete database")
    do {
        let f = Fixture(enabled: ["a1"], dbKilled: true, stored: Fixture.mine(["a1", "b1", "c1"], seq: 4))
        checkEq(f.memoryAgents, ["a1"], "grants not switched on in the DB are dropped")
        checkEq(f.state.debugValues().state.killed, true, "DB killed='1' stops")
        let st = f.backend.stored
        check(st?.agents == ["a1"] && st?.killed == true && st?.seq == 5, "written back (same home + db)", "\(String(describing: st))")
        checkEq(f.reconciles.value, 1, "startup check ran once")
        let reads = f.backend.reads
        f.state.start() // a load queued after ready must be a no-op
        f.state.waitIdle()
        check(f.backend.reads == reads && f.reconciles.value == 1, "a later load request neither re-reads nor re-checks")
    }

    group("startup check without a database file (R4)")
    do {
        let f = Fixture(dbFile: "none", stored: Fixture.mine(["a1", "b1"]))
        checkEq(f.phase, .ready, "state ready (not stuck loading)")
        checkEq(f.memoryAgents, [], "no grant usable in memory (fail closed)")
        checkEq(f.held, ["a1", "b1"], "stored grants kept as unconfirmed")
        checkEq(f.backend.writes, 0, "no write-back: Keychain grants not wiped")
        checkEq(f.access("a1"), "not_allowed", "action refused")
        // Node creates the DB later; a new grant must keep the unconfirmed ones stored.
        let t = TestDB(path: f.config.dbPath)
        t.setEnabled("a1", true)
        t.setEnabled("c1", true)
        check(isOk(f.call("grant", ["agent": "c1"])), "grant c1")
        checkEq(f.backend.stored?.agents ?? [], ["a1", "b1", "c1"], "the grant keeps the unconfirmed grants stored")
        checkEq(f.access("c1"), "ok", "newly granted agent allowed")
        checkEq(f.access("a1"), "not_allowed", "an unconfirmed grant stays unusable in this process")
        _ = f.call("revoke", ["agent": "b1"])
        f.state.waitIdle()
        checkEq(f.backend.stored?.agents ?? [], ["a1", "c1"], "revoking an unconfirmed grant removes it from storage")
    }

    group("startup check with pc_control tables missing (R4)")
    do {
        let f = Fixture(dbFile: "empty", stored: Fixture.mine(["a1"]), start: false)
        f.controller.engageKill(by: "test", waitForDatabase: true) // before the first load; creates pc_control_state only
        f.controller.start()
        _ = f.state.waitSettled(timeout: 10)
        f.state.waitIdle() // let a (wrong) write-back finish before checking
        checkEq(f.phase, .ready, "state ready")
        check(f.memoryAgents == [] && f.held == ["a1"] && f.state.debugValues().state.killed, "in memory: no agents, kill merged")
        checkEq(f.backend.writes, 1, "only the stop is written back")
        checkEq(f.backend.stored?.agents ?? [], ["a1"], "stored grant kept")
        checkEq(f.backend.stored?.killed, true, "the stop is saved in the Keychain (not lost when the DB is unreadable)")
    }

    group("stop before the first load with no database file is saved (not lost)")
    do {
        let f = Fixture(dbFile: "none", stored: Fixture.mine(["a1", "b1"]), start: false)
        f.backend.blockReads(true)
        f.controller.start()
        _ = f.backend.waitForBlockedRead(3)
        let k = f.call("kill", ["by": "test"])
        check(isOk(k), "kill ok while the state loads")
        f.backend.blockReads(false)
        _ = f.state.waitSettled(timeout: 10)
        f.state.waitIdle()
        let st = f.backend.stored
        check(st?.killed == true && st?.agents == ["a1", "b1"], "stop saved, every stored grant kept", "\(String(describing: st))")
        checkEq(f.access("a1"), "killed", "actions stopped")
    }

    group("startup check with an unreadable database (R4)")
    do {
        let f = Fixture(dbFile: "garbage", stored: Fixture.mine(["a1"]))
        checkEq(f.phase, .ready, "state ready (unreadable is not retried forever)")
        check(f.memoryAgents == [] && f.held == ["a1"], "fail closed in memory, grant kept as unconfirmed")
        checkEq(f.backend.writes, 0, "no write-back")
    }

    group("startup check while the database is locked (transient: retried)")
    do {
        let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"]), start: false)
        guard let lock = DBLock(path: f.config.dbPath) else {
            check(false, "could not lock the test database")
            return
        }
        f.controller.start()
        usleep(300_000)
        checkEq(f.phase, .loading, "still loading while the DB is busy")
        let msg = f.accessMessage("a1")
        check(msg.contains("waiting for the Bruce Comm database"), "actions fail closed while waiting", msg)
        // The first attempt gives up after the 3 s busy timeout; release once the retry has started.
        check(waitUntil(10) { f.reconciles.value >= 2 }, "busy DB is retried")
        lock.release()
        check(f.state.waitSettled(timeout: 6) && f.phase == .ready, "retry succeeds once the lock is gone")
        f.state.waitIdle()
        checkEq(f.memoryAgents, ["a1"], "grant confirmed")
        checkEq(f.reconciles.value >= 2 && f.backend.reads == 1, true, "retries re-check the DB without re-reading the Keychain")
        checkEq(f.backend.writes, 0, "nothing to write back")
    }
}

/// R2: a queued startup load must never undo a just-approved grant / unkill.
func testReconcileRaces() {
    group("R2 S1: grant while a retryable Keychain failure is being retried")
    do {
        let f = Fixture(readErrors: [errInteractionNotAllowed], retryInterval: 0.2)
        check(waitUntil(2) { f.phase == .failed(retryable: true) }, "first read failed (retryable)")
        f.backend.blockReads(true)
        let grant = Background { f.call("grant", ["agent": "a1"]) }
        check(f.backend.waitForBlockedRead(3), "grant re-reads the Keychain (blocked like a prompt)")
        usleep(350_000) // the retry interval has passed
        for _ in 0..<3 {
            _ = f.call("grants")
            _ = f.call("status")
        }
        f.backend.blockReads(false)
        let r = grant.wait(10) ?? [:]
        check(isOk(r), "grant ok", "\(r)")
        f.db?.setEnabled("a1", true) // Node writes enabled=1 only after the helper answered
        usleep(500_000)
        for _ in 0..<3 { _ = f.call("grants") }
        f.state.waitIdle()
        checkEq(f.backend.stored?.agents ?? [], ["a1"], "Keychain keeps the grant")
        checkEq(f.memoryAgents, ["a1"], "memory keeps the grant")
        checkEq(f.access("a1"), "ok", "agent allowed after Node enabled it")
        checkEq(f.reconciles.value, 1, "startup check ran exactly once")
        checkEq(f.backend.reads, 2, "no second load after the grant")
    }

    group("R2 S2: unkill while a retryable Keychain failure is being retried")
    do {
        let f = Fixture(enabled: ["a1"], dbKilled: true, stored: Fixture.mine(["a1"], killed: true),
                        readErrors: [errInteractionNotAllowed], retryInterval: 0.2)
        check(waitUntil(2) { f.phase == .failed(retryable: true) }, "first read failed (retryable)")
        f.backend.blockReads(true)
        let unkill = Background { f.call("unkill") }
        check(f.backend.waitForBlockedRead(3), "unkill re-reads the Keychain")
        usleep(350_000)
        for _ in 0..<3 {
            _ = f.call("grants")
            _ = f.call("status")
        }
        f.backend.blockReads(false)
        let r = unkill.wait(10) ?? [:]
        check(isOk(r), "unkill ok", "\(r)")
        f.db?.setKilled(false) // Node writes killed=0 after the helper answered
        usleep(500_000)
        for _ in 0..<3 { _ = f.call("grants") }
        f.state.waitIdle()
        checkEq(f.backend.stored?.killed, false, "Keychain stays re-enabled")
        checkEq(f.access("a1"), "ok", "agent allowed after Node cleared the DB stop")
        checkEq(f.reconciles.value, 1, "startup check ran exactly once")
    }

    group("grant while a background reload waits on the Keychain")
    do {
        let f = Fixture(readErrors: [errInteractionNotAllowed], retryInterval: 0.05)
        check(waitUntil(2) { f.phase == .failed(retryable: true) }, "first read failed (retryable)")
        usleep(100_000)
        f.backend.blockReads(true)
        _ = f.call("grants") // due: starts the background reload, which waits on the Keychain
        check(f.backend.waitForBlockedRead(2), "background reload waiting")
        let grant = Background { f.call("grant", ["agent": "a1"]) }
        usleep(200_000)
        checkEq(f.auth.reasons.count, 0, "no Touch ID prompt while the state is loading")
        f.backend.blockReads(false)
        let r = grant.wait(10) ?? [:]
        check(isOk(r), "grant ok after the load", "\(r)")
        f.db?.setEnabled("a1", true)
        f.state.start() // any later load request is a no-op
        f.state.waitIdle()
        checkEq(f.reconciles.value, 1, "one startup check in total")
        checkEq(f.backend.stored?.agents ?? [], ["a1"], "grant kept in the Keychain")
        checkEq(f.access("a1"), "ok", "agent allowed")
    }
}

func testBlockedKeychain() {
    group("Keychain read blocked at launch (prompt pending)")
    do {
        let f = Fixture(enabled: ["a1", "b1"], stored: Fixture.mine(["a1", "b1"]), start: false)
        f.backend.blockReads(true)
        f.controller.start()
        check(f.backend.waitForBlockedRead(3), "load waits on the Keychain")
        let (st, tStatus) = timed { resultOf(f.call("status")) }
        check(tStatus < 0.5 && (st["state_loading"] as? Bool) == true && st["signature_ok"] is NSNull,
              "status answers at once (state_loading, signature_ok null)", "\(tStatus)s \(st)")
        checkEq(st["db"] as? String, f.config.dbPath, "status reports the canonical db")
        let (g, tGrants) = timed { resultOf(f.call("grants")) }
        check(tGrants < 0.5 && (g["agents"] as? [String]) == [], "grants answers at once with no agents", "\(tGrants)s")
        let (code, tAccess) = timed { f.access("a1") }
        check(code == "failed" && tAccess >= 1.8 && tAccess < 3.5, "action check waits at most ~2 s, then fails closed",
              "\(code) after \(tAccess)s")
        let (k, tKill) = timed { f.call("kill", ["by": "test-kill"]) }
        check(isOk(k) && tKill < 0.5 && (resultOf(k)["db_written"] as? Bool) == true, "kill is immediate and writes the DB",
              "\(tKill)s \(k)")
        let row = f.db?.killedRow()
        check(row?.value == "1" && row?.by == "test-kill", "DB killed='1' by test-kill", "\(String(describing: row))")
        let rv = f.call("revoke", ["agent": "a1"])
        check(isOk(rv) && (resultOf(rv)["pending"] as? Bool) == true, "revoke while loading is pending", "\(rv)")
        f.backend.blockReads(false)
        check(f.state.waitSettled(timeout: 5), "load completes after the prompt")
        f.state.waitIdle()
        let stored = f.backend.stored
        check(stored?.agents == ["b1"] && stored?.killed == true, "kill merged and pending revoke applied at load",
              "\(String(describing: stored))")
        checkEq(f.access("b1"), "killed", "still stopped")
    }

    group("revoke while the Keychain write is blocked (R3)")
    do {
        let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"]))
        checkEq(f.access("a1"), "ok", "granted agent allowed")
        f.backend.blockWrites(true)
        let (r, t) = timed { f.call("revoke", ["agent": "a1"]) }
        check(isOk(r) && t < 0.5 && (resultOf(r)["pending"] as? Bool) == false, "revoke answers at once", "\(t)s \(r)")
        let (code, t2) = timed { f.access("a1") }
        check(code == "not_allowed" && t2 < 0.5, "revoked agent refused at once (DB still enabled=1)", "\(code) \(t2)s")
        checkEq(f.backend.stored?.agents ?? [], ["a1"], "Keychain not written yet")
        check(f.backend.waitForBlockedWrite(2), "the save waits in the background")
        f.backend.blockWrites(false)
        f.state.waitIdle()
        checkEq(f.backend.stored?.agents ?? ["?"], [], "saved once the Keychain answers")
    }

    group("revoke while the Keychain write is denied (R3)")
    do {
        let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"]))
        f.backend.failWrites([errUserCanceled])
        check(isOk(f.call("revoke", ["agent": "a1"])), "revoke ok")
        f.state.waitIdle()
        checkEq(f.access("a1"), "not_allowed", "still revoked in memory")
        checkEq(f.backend.stored?.agents ?? [], ["a1"], "Keychain unchanged (startup check drops it next launch)")
    }

    group("revoke that lands while a grant is being saved")
    do {
        let f = Fixture(enabled: ["y1"])
        f.backend.blockWrites(true)
        let grant = Background { f.call("grant", ["agent": "y1"]) }
        check(f.backend.waitForBlockedWrite(3), "grant save blocked")
        let rv = f.call("revoke", ["agent": "y1"])
        check(isOk(rv), "revoke ok meanwhile")
        f.backend.blockWrites(false)
        _ = grant.wait(10)
        f.state.waitIdle()
        checkEq(f.memoryAgents, [], "the later revoke wins in memory")
        checkEq(f.backend.stored?.agents ?? ["?"], [], "and in the Keychain")
        checkEq(f.access("y1"), "not_allowed", "agent refused")
    }

    group("kill while the Keychain write is blocked")
    do {
        let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"]))
        f.backend.blockWrites(true)
        let (k, t) = timed { f.call("kill", ["by": "test"]) }
        check(isOk(k) && t < 0.5, "kill answers at once", "\(t)s")
        checkEq(f.access("a1"), "killed", "actions stopped at once")
        f.backend.blockWrites(false)
        f.state.waitIdle()
        checkEq(f.backend.stored?.killed, true, "stop saved once the Keychain answers")
    }
}
