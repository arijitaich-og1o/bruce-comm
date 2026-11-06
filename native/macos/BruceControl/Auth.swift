// Owner authentication (Touch ID or login password) via LocalAuthentication.
import AppKit
import LocalAuthentication

/// Owner authentication; the app uses LocalOwnerAuth, tests a fake.
protocol OwnerAuthenticating: AnyObject {
    /// Blocks until the owner answers. Throws auth_failed / auth_canceled.
    func authenticate(reason: String) throws
}

final class LocalOwnerAuth: OwnerAuthenticating {
    func authenticate(reason: String) throws { try OwnerAuth.authenticate(reason: reason) }
}

enum OwnerAuth {
    /// Blocks the calling (non-main) thread until the owner answers. Throws auth_failed / auth_canceled.
    static func authenticate(reason: String, timeout: TimeInterval = 110) throws {
        let ctx = LAContext()
        var canErr: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &canErr) else {
            throw HelperError("auth_failed", "owner authentication unavailable: \(canErr?.localizedDescription ?? "unknown reason")")
        }
        DispatchQueue.main.async { NSApp.activate() }
        let sem = DispatchSemaphore(value: 0)
        let box = ResultBox<HelperError?>()
        ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { ok, error in
            box.set(ok ? nil : mapError(error))
            sem.signal()
        }
        if sem.wait(timeout: .now() + timeout) == .timedOut {
            ctx.invalidate()
            _ = sem.wait(timeout: .now() + 5)
            throw HelperError("auth_canceled", "owner authentication timed out")
        }
        guard let outcome = box.get() else { throw HelperError("auth_failed", "owner authentication gave no answer") }
        if let err = outcome { throw err }
    }

    private static func mapError(_ error: Error?) -> HelperError {
        guard let error else { return HelperError("auth_failed", "owner authentication failed") }
        if let la = error as? LAError {
            switch la.code {
            case .userCancel, .appCancel, .systemCancel, .userFallback:
                return HelperError("auth_canceled", "owner authentication canceled")
            default:
                return HelperError("auth_failed", "owner authentication failed: \(la.localizedDescription)")
            }
        }
        return HelperError("auth_failed", "owner authentication failed: \(error.localizedDescription)")
    }
}
