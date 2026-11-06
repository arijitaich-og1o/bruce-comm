// Menu bar item, global kill hotkey (Carbon, ctrl+option+cmd+K) and app lifecycle.
import AppKit
import Carbon

// MARK: - Hotkey

private let hotKeySignature: OSType = 0x4252_434B // 'BRCK'
private var hotKeyAction: (() -> Void)? // main thread only

private func hotKeyEventHandler(_ next: EventHandlerCallRef?, _ event: EventRef?, _ user: UnsafeMutableRawPointer?) -> OSStatus {
    guard let event else { return OSStatus(eventNotHandledErr) }
    var hk = EventHotKeyID()
    let st = GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                               nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
    guard st == noErr, hk.signature == hotKeySignature, hk.id == 1 else { return OSStatus(eventNotHandledErr) }
    hotKeyAction?()
    return noErr
}

final class KillHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?

    /// Registers ctrl+option+cmd+K (no permission needed). Main thread.
    func register(_ action: @escaping () -> Void) -> Bool {
        hotKeyAction = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        guard InstallEventHandler(GetApplicationEventTarget(), hotKeyEventHandler, 1, &spec, nil, &handlerRef) == noErr else {
            return false
        }
        let id = EventHotKeyID(signature: hotKeySignature, id: 1)
        let mods = UInt32(cmdKey | optionKey | controlKey)
        return RegisterEventHotKey(UInt32(kVK_ANSI_K), mods, id, GetApplicationEventTarget(), 0, &hotKeyRef) == noErr
    }
}

// MARK: - App delegate / status item

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private let controller: Controller
    private let server: SocketServer
    private let hotKey = KillHotKey()
    private var statusItem: NSStatusItem?
    private let statusLine = NSMenuItem(title: "Bruce Control: Active", action: nil, keyEquivalent: "")
    private let accessibilityLine = NSMenuItem(title: "Accessibility: …", action: nil, keyEquivalent: "")
    private let recordingLine = NSMenuItem(title: "Screen Recording: …", action: nil, keyEquivalent: "")
    private var stopItem: NSMenuItem?
    private var reenableItem: NSMenuItem?
    private var timer: Timer?
    private var killed = false

    init(controller: Controller, server: SocketServer) {
        self.controller = controller
        self.server = server
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        setUpStatusItem()
        controller.onKilledChange = { [weak self] killed in
            DispatchQueue.main.async { self?.render(killed: killed) }
        }
        let ok = hotKey.register { [weak self] in self?.hotKeyPressed() }
        controller.hotkeyRegistered = ok
        if !ok { logLine("could not register the kill hotkey \(hotkeyName)") }
        timer = Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            self?.controller.refreshUI()
        }
        controller.refreshUI()
        server.startAccepting(controller)
        logLine("Bruce Control \(helperVersion) ready (home \(controller.config.home), db \(controller.config.dbPath))")
    }

    func applicationWillTerminate(_ notification: Notification) {
        server.stop()
    }

    private func setUpStatusItem() {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem = item
        let menu = NSMenu()
        menu.autoenablesItems = false
        menu.delegate = self
        statusLine.isEnabled = false
        accessibilityLine.isEnabled = false
        recordingLine.isEnabled = false
        menu.addItem(statusLine)
        menu.addItem(accessibilityLine)
        menu.addItem(recordingLine)
        menu.addItem(.separator())
        let stop = NSMenuItem(title: "Stop all PC control  ⌃⌥⌘K", action: #selector(stopAll(_:)), keyEquivalent: "")
        stop.target = self
        menu.addItem(stop)
        stopItem = stop
        let reenable = NSMenuItem(title: "Re-enable PC control…", action: #selector(reenable(_:)), keyEquivalent: "")
        reenable.target = self
        menu.addItem(reenable)
        reenableItem = reenable
        menu.addItem(.separator())
        let perms = NSMenuItem(title: "Request permissions…", action: #selector(requestPermissions(_:)), keyEquivalent: "")
        perms.target = self
        menu.addItem(perms)
        let dash = NSMenuItem(title: "Open Bruce Comm dashboard", action: #selector(openDashboard(_:)), keyEquivalent: "")
        dash.target = self
        menu.addItem(dash)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit", action: #selector(quit(_:)), keyEquivalent: "")
        quit.target = self
        menu.addItem(quit)
        item.menu = menu
        render(killed: controller.killFlag.value)
    }

    private func render(killed: Bool) {
        self.killed = killed
        statusLine.title = killed ? "Bruce Control: STOPPED" : "Bruce Control: Active"
        stopItem?.isEnabled = !killed
        reenableItem?.isEnabled = killed
        guard let button = statusItem?.button else { return }
        if let img = NSImage(systemSymbolName: killed ? "hand.raised.fill" : "cursorarrow.rays", accessibilityDescription: "Bruce Control") {
            img.isTemplate = true
            button.image = img
            button.imagePosition = .imageLeading
            button.title = killed ? " STOPPED" : ""
        } else {
            button.image = nil
            button.title = killed ? "BC STOPPED" : "BC"
        }
        button.toolTip = killed ? "Bruce Control: PC control STOPPED" : "Bruce Control: PC control active (\(hotkeyName) stops it)"
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        accessibilityLine.title = "Accessibility: " + (AXIsProcessTrusted() ? "granted" : "missing")
        recordingLine.title = "Screen Recording: " + (CGPreflightScreenCaptureAccess() ? "granted" : "missing")
        render(killed: killed || controller.killFlag.value)
        controller.refreshUI()
    }

    private func hotKeyPressed() {
        controller.engageKill(by: "hotkey", waitForDatabase: false)
        render(killed: true)
        if let sound = NSSound(named: NSSound.Name("Basso")) { sound.play() } else { NSSound.beep() }
    }

    @objc private func stopAll(_ sender: Any?) {
        controller.engageKill(by: "menu", waitForDatabase: false)
        render(killed: true)
    }

    @objc private func reenable(_ sender: Any?) {
        let c = controller
        DispatchQueue.global(qos: .userInitiated).async { c.menuReenable() }
    }

    @objc private func requestPermissions(_ sender: Any?) {
        let c = controller
        DispatchQueue.global(qos: .userInitiated).async { _ = c.requestPermissions() }
    }

    @objc private func openDashboard(_ sender: Any?) {
        if let url = URL(string: dashboardURL) { NSWorkspace.shared.open(url) }
    }

    @objc private func quit(_ sender: Any?) {
        NSApp.terminate(nil)
    }
}
