// BruceControl test harness: compiles every helper source except main.swift and MenuBar.swift with this file.
// In-memory Keychain backend, fake owner auth, temp home + temp SQLite DB, a real unix socket in a short temp dir.
// It never launches the app, never posts input events and never touches the real Keychain or ~/.bruce-comm.
import Foundation

signal(SIGPIPE, SIG_IGN)
unifiedLogEnabled = false
setvbuf(stdout, nil, _IOLBF, 0)

let started = Date()
print("BruceControl helper tests (temp root \(TempRoot.root))")
testCodecAndConfig()
testHomeDbBinding()
testReconcile()
testReconcileRaces()
testBlockedKeychain()
testOwnerAuth()
testInput()
testDatabase()
testSocket()
testStartup()

let runner = TestRunner.shared
TempRoot.cleanup()
print("")
if !runner.failures.isEmpty {
    print("Failures:")
    for f in runner.failures { print("  - \(f)") }
}
print(String(format: "RESULT: %d passed, %d failed (%.1f s)", runner.passed, runner.failed, Date().timeIntervalSince(started)))
exit(runner.failed == 0 ? 0 : 1)
