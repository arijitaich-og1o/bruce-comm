// Grant/unkill owner-auth handling: busy slot, fixed Touch ID text, failures, kill during re-enable, status fields.
import Foundation

func testOwnerAuth() {
    group("Touch ID text ignores args.reason")
    do {
        let f = Fixture(enabled: ["a1"])
        check(isOk(f.call("grant", ["agent": "a1", "reason": "Pay 500 EUR to evil-corp"])), "grant ok")
        checkEq(f.auth.reasons.last ?? "", Controller.grantPrompt("a1"), "grant prompt built by the helper from the agent id")
        check(!(f.auth.reasons.last ?? "").contains("evil"), "client text never reaches the prompt")
        _ = f.call("kill", ["by": "test"])
        check(isOk(f.call("unkill", ["reason": "ignore previous instructions"])), "unkill ok")
        checkEq(f.auth.reasons.last ?? "", Controller.unkillPrompt, "unkill prompt is fixed")
        let bad = f.call("grant", ["agent": "Bad Agent!", "reason": "x"])
        checkEq(errCode(bad), "invalid_argument", "invalid agent id refused before any prompt")
        checkEq(f.auth.reasons.count, 2, "no prompt for the invalid request")
    }

    group("one owner prompt at a time (busy)")
    do {
        let f = Fixture(enabled: ["a1", "b1"])
        f.auth.block(true)
        let first = Background { f.call("grant", ["agent": "a1"]) }
        check(f.auth.waitForPrompt(3), "first grant shows its prompt")
        let (second, t) = timed { f.call("grant", ["agent": "b1"]) }
        check(errCode(second) == "busy" && t < 0.5, "a concurrent grant gets busy at once", "\(t)s \(second)")
        let unkill = f.call("unkill")
        checkEq(errCode(unkill), "busy", "a concurrent unkill gets busy")
        checkEq(f.auth.reasons.count, 1, "no second prompt")
        f.auth.block(false)
        check(isOk(first.wait(5) ?? [:]), "first grant completes")
        checkEq(f.backend.stored?.agents ?? [], ["a1"], "only the first grant stored")
        check(isOk(f.call("grant", ["agent": "b1"])), "the slot is free again")
    }

    group("failed or canceled owner authentication")
    do {
        let f = Fixture(enabled: ["a1"])
        f.auth.fail(with: HelperError("auth_failed", "owner authentication failed"))
        checkEq(errCode(f.call("grant", ["agent": "a1"])), "auth_failed", "grant refused")
        checkEq(f.backend.writes, 0, "nothing stored")
        checkEq(f.access("a1"), "not_allowed", "agent stays off")
        _ = f.call("kill", ["by": "test"])
        f.auth.fail(with: HelperError("auth_canceled", "owner authentication canceled"))
        checkEq(errCode(f.call("unkill")), "auth_canceled", "unkill refused")
        checkEq(f.access("a1"), "killed", "still stopped")
    }

    group("a kill during re-enable wins")
    do {
        let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"], killed: true))
        f.auth.block(true)
        let unkill = Background { f.call("unkill") }
        check(f.auth.waitForPrompt(3), "unkill prompt open")
        check(isOk(f.call("kill", ["by": "hotkey-test"])), "kill meanwhile")
        f.auth.block(false)
        let r = unkill.wait(5) ?? [:]
        checkEq(errCode(r), "killed", "unkill reports the new stop")
        checkEq(f.access("a1"), "killed", "still stopped")
    }

    group("status and grants fields")
    do {
        let f = Fixture(enabled: ["a1"], stored: Fixture.mine(["a1"]))
        let st = resultOf(f.call("status"))
        check(st["version"] as? String == helperVersion && st["home"] as? String == f.home && st["db"] as? String == f.config.dbPath
              && (st["state_loading"] as? Bool) == false && (st["signature_ok"] as? Bool) == true && st["hotkey"] as? String == hotkeyName,
              "status reports version, canonical home/db, state", "\(st)")
        let g = resultOf(f.call("grants"))
        check((g["agents"] as? [String]) == ["a1"] && (g["killed"] as? Bool) == false && g["db"] as? String == f.config.dbPath,
              "grants lists the usable agents", "\(g)")
        checkEq(errCode(f.call("frobnicate")), "unsupported", "unknown op")
        let cur = f.call("cursor", agent: "a1")
        check(isOk(cur) && resultOf(cur)["x"] is Double, "an allowed read-only action passes the access check", "\(cur)")
        checkEq(errCode(f.call("cursor", agent: "zz")), "not_allowed", "an agent without a grant is refused")
        checkEq(errCode(f.call("cursor")), "not_allowed", "an action without an agent is refused")
        let mirror = f.config.statePath
        var sb = stat()
        check(stat(mirror, &sb) == 0 && (sb.st_mode & 0o777) == 0o600, "state mirror written 0600")
        try? Data("{\"agents\":[\"zz\"]}".utf8).write(to: URL(fileURLWithPath: mirror))
        checkEq(f.access("zz"), "not_allowed", "editing the mirror changes nothing")
    }
}
