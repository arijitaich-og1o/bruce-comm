// Bruce Control: the macOS PC-control helper for Bruce Comm (menu-bar app, NDJSON over a unix socket).
import AppKit
import Foundation

signal(SIGPIPE, SIG_IGN)

var helperConfig = HelperConfig.fromArguments(CommandLine.arguments)

let instanceLockPath = userInstanceLockPath()
let instanceLockFD: Int32
switch acquireInstanceLock(instanceLockPath) {
case .acquired(let fd):
    instanceLockFD = fd
case .held:
    logLine("another Bruce Control helper is already running for this user; exiting (requested home \(helperConfig.home))")
    exit(0)
case .failed(let why):
    logLine("cannot take the instance lock \(instanceLockPath): \(why)")
    exit(1)
}

// The lock file sits in a folder this user can change, so also look for another running helper by bundle id.
if let other = olderRunningHelper() {
    logLine("another Bruce Control helper (pid \(other)) is already running for this user; exiting")
    exit(0)
}

do {
    try prepareControlDirectory(helperConfig)
} catch {
    logLine("cannot prepare \(helperConfig.controlDir): \(error)")
    exit(1)
}
helperConfig = helperConfig.canonicalized()

// Never take over a socket a live helper answers on (e.g. an older build without the per-user lock).
let socketServer = SocketServer(path: helperConfig.socketPath)
do {
    try socketServer.bindAndListen()
} catch let inUse as SocketInUse {
    logLine("another Bruce Control helper already serves \(inUse.path); exiting")
    exit(0)
} catch {
    logLine("cannot listen on \(helperConfig.socketPath): \(error)")
    exit(1)
}

let helperController = Controller(config: helperConfig, stateBackend: KeychainStateBackend(), authenticator: LocalOwnerAuth())
helperController.start() // Keychain state + startup check in the background; actions wait for it (bounded)
let appDelegate = AppDelegate(controller: helperController, server: socketServer)

var signalSources: [DispatchSourceSignal] = []
for sig in [SIGTERM, SIGINT, SIGHUP] {
    signal(sig, SIG_IGN)
    let src = DispatchSource.makeSignalSource(signal: sig, queue: .main)
    src.setEventHandler {
        socketServer.stop()
        exit(0)
    }
    src.resume()
    signalSources.append(src)
}

let application = NSApplication.shared
application.setActivationPolicy(.accessory)
application.delegate = appDelegate
withExtendedLifetime(instanceLockFD) {
    application.run()
}
