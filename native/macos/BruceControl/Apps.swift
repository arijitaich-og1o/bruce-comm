// Apps and windows: open_app, open_url, list_windows (CGWindowList), focus_window (AX).
import AppKit
import ApplicationServices
import CoreGraphics

enum Apps {
    static let searchDirs = [
        "/Applications", "/System/Applications", "/System/Applications/Utilities", "/Applications/Utilities",
        (NSHomeDirectory() as NSString).appendingPathComponent("Applications"),
    ]

    /// App name or bundle id -> app bundle URL.
    static func resolve(_ raw: String) throws -> URL {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, name.count <= 255 else { throw HelperError.invalid("app name must be 1..255 characters") }
        guard !name.contains("/"), !name.hasPrefix("."), !name.contains("\u{0}") else {
            throw HelperError.invalid("app name must be a plain name or bundle id, not a path")
        }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: name) { return url }
        var base = name
        if base.lowercased().hasSuffix(".app") { base = String(base.dropLast(4)) }
        guard !base.isEmpty else { throw HelperError.invalid("app name is empty") }
        for dir in searchDirs {
            let path = (dir as NSString).appendingPathComponent("\(base).app")
            var isDir: ObjCBool = false
            if FileManager.default.fileExists(atPath: path, isDirectory: &isDir), isDir.boolValue {
                return URL(fileURLWithPath: path)
            }
        }
        throw HelperError.notFound("no application named '\(name)' (searched bundle ids and \(searchDirs.joined(separator: ", ")))")
    }

    static func openApp(_ name: String) throws -> [String: Any] {
        let url = try resolve(name)
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let result: Result<NSRunningApplication, Error>? = waitFor(timeout: 30) { finish in
            NSWorkspace.shared.openApplication(at: url, configuration: cfg) { app, error in
                if let app { finish(.success(app)) } else { finish(.failure(error ?? HelperError.failed("launch failed"))) }
            }
        }
        guard let result else { throw HelperError.failed("timed out launching \(url.path)") }
        switch result {
        case .failure(let e):
            throw HelperError.failed("could not open \(url.path): \(e.localizedDescription)")
        case .success(let app):
            return [
                "pid": Int(app.processIdentifier),
                "bundle_id": app.bundleIdentifier ?? Bundle(url: url)?.bundleIdentifier ?? "",
                "name": app.localizedName ?? url.deletingPathExtension().lastPathComponent,
                "path": app.bundleURL?.path ?? url.path,
            ]
        }
    }

    static func openURL(_ raw: String, app: String?) throws -> [String: Any] {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              url.host?.isEmpty == false else {
            throw HelperError.invalid("url must be an absolute http(s) URL")
        }
        let cfg = NSWorkspace.OpenConfiguration()
        cfg.activates = true
        let appURL = try app.map { try resolve($0) }
        let result: Result<Void, Error>? = waitFor(timeout: 30) { finish in
            let done: (NSRunningApplication?, Error?) -> Void = { _, error in
                if let error { finish(.failure(error)) } else { finish(.success(())) }
            }
            if let appURL {
                NSWorkspace.shared.open([url], withApplicationAt: appURL, configuration: cfg, completionHandler: done)
            } else {
                NSWorkspace.shared.open(url, configuration: cfg, completionHandler: done)
            }
        }
        guard let result else { throw HelperError.failed("timed out opening the URL") }
        if case .failure(let e) = result { throw HelperError.failed("could not open URL: \(e.localizedDescription)") }
        return ["opened": true]
    }

    // MARK: - Windows (CGWindowList)

    private static func frontmost() -> (name: String, pid: Int) {
        let read = { () -> (String, Int) in
            let app = NSWorkspace.shared.frontmostApplication
            return (app?.localizedName ?? "", Int(app?.processIdentifier ?? 0))
        }
        return Thread.isMainThread ? read() : DispatchQueue.main.sync(execute: read)
    }

    private static func bounds(_ info: [String: Any]) -> CGRect {
        guard let d = info[kCGWindowBounds as String] as? NSDictionary,
              let r = CGRect(dictionaryRepresentation: d as CFDictionary) else { return .zero }
        return r
    }

    private static func boundsJSON(_ r: CGRect) -> [String: Any] {
        ["x": Double(r.origin.x), "y": Double(r.origin.y), "width": Double(r.width), "height": Double(r.height)]
    }

    static func listWindows(all: Bool) throws -> [String: Any] {
        let opts: CGWindowListOption = all ? [.optionAll] : [.optionOnScreenOnly, .excludeDesktopElements]
        guard let list = CGWindowListCopyWindowInfo(opts, kCGNullWindowID) as? [[String: Any]] else {
            throw HelperError.failed("could not read the window list")
        }
        var windows: [[String: Any]] = []
        for info in list {
            let layer = (info[kCGWindowLayer as String] as? NSNumber)?.intValue ?? 0
            if !all && layer != 0 { continue }
            windows.append([
                "window_id": (info[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0,
                "pid": (info[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? 0,
                "app": info[kCGWindowOwnerName as String] as? String ?? "",
                "title": info[kCGWindowName as String] as? String ?? "",
                "bounds": boundsJSON(bounds(info)),
                "layer": layer,
                "on_screen": (info[kCGWindowIsOnscreen as String] as? NSNumber)?.boolValue ?? false,
            ])
            if windows.count >= 1000 { break }
        }
        let front = frontmost()
        return ["frontmost_app": front.name, "frontmost_pid": front.pid, "windows": windows]
    }

    // MARK: - focus_window (AX)

    private static func axCopy(_ el: AXUIElement, _ attr: String) -> CFTypeRef? {
        var v: CFTypeRef?
        guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
        return v
    }

    private static func axTitle(_ w: AXUIElement) -> String {
        axCopy(w, kAXTitleAttribute) as? String ?? ""
    }

    private static func axFrame(_ w: AXUIElement) -> CGRect? {
        guard let pv = axCopy(w, kAXPositionAttribute), let sv = axCopy(w, kAXSizeAttribute),
              CFGetTypeID(pv) == AXValueGetTypeID(), CFGetTypeID(sv) == AXValueGetTypeID() else { return nil }
        var p = CGPoint.zero
        var s = CGSize.zero
        guard AXValueGetValue(pv as! AXValue, .cgPoint, &p), AXValueGetValue(sv as! AXValue, .cgSize, &s) else { return nil }
        return CGRect(origin: p, size: s)
    }

    private static func axWindows(pid: pid_t) -> [AXUIElement] {
        let app = AXUIElementCreateApplication(pid)
        AXUIElementSetMessagingTimeout(app, 2)
        guard let v = axCopy(app, kAXWindowsAttribute), let arr = v as? [AnyObject] else { return [] }
        return arr.compactMap { item in
            CFGetTypeID(item) == AXUIElementGetTypeID() ? (item as! AXUIElement) : nil
        }
    }

    private static func runningApps(matching name: String) -> [NSRunningApplication] {
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let base = n.hasSuffix(".app") ? String(n.dropLast(4)) : n
        return NSWorkspace.shared.runningApplications.filter { app in
            if app.localizedName?.lowercased() == base { return true }
            if app.bundleIdentifier?.lowercased() == n { return true }
            if let url = app.bundleURL, url.deletingPathExtension().lastPathComponent.lowercased() == base { return true }
            return false
        }.sorted { a, b in
            (a.activationPolicy == .regular ? 0 : 1) < (b.activationPolicy == .regular ? 0 : 1)
        }
    }

    static func focusWindow(windowId: Int?, app: String?, title: String?) throws -> [String: Any] {
        let wantTitle = title?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let titleFilter = (wantTitle?.isEmpty == false) ? wantTitle : nil
        func titleMatches(_ w: AXUIElement) -> Bool {
            guard let t = titleFilter else { return true }
            return axTitle(w).lowercased().contains(t)
        }

        var target: (pid: pid_t, window: AXUIElement?)?
        if let wid = windowId {
            guard wid > 0, wid <= Int(UInt32.max),
                  let infos = CGWindowListCopyWindowInfo([.optionIncludingWindow], CGWindowID(wid)) as? [[String: Any]],
                  let info = infos.first(where: { ($0[kCGWindowNumber as String] as? NSNumber)?.intValue == wid }),
                  let pidNum = info[kCGWindowOwnerPID as String] as? NSNumber else {
                throw HelperError.notFound("no window with window_id \(wid)")
            }
            let pid = pid_t(pidNum.int32Value)
            let cgFrame = bounds(info)
            let cgTitle = (info[kCGWindowName as String] as? String ?? "").lowercased()
            let candidates = axWindows(pid: pid).filter { w in
                guard let f = axFrame(w) else { return false }
                return abs(f.minX - cgFrame.minX) <= 2 && abs(f.minY - cgFrame.minY) <= 2
                    && abs(f.width - cgFrame.width) <= 2 && abs(f.height - cgFrame.height) <= 2
            }
            var match = candidates.first { !cgTitle.isEmpty && axTitle($0).lowercased() == cgTitle } ?? candidates.first
            if match == nil, !cgTitle.isEmpty {
                // Fallback when the window moved since it was listed: exact title match.
                match = axWindows(pid: pid).first { axTitle($0).lowercased() == cgTitle }
            }
            guard let w = match else {
                throw HelperError.notFound("window \(wid) was not found in the Accessibility tree of pid \(pid)")
            }
            target = (pid, w)
        } else if let app, !app.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            let apps = runningApps(matching: app)
            guard !apps.isEmpty else { throw HelperError.notFound("no running app named '\(app)'") }
            if titleFilter != nil {
                for a in apps {
                    if let w = axWindows(pid: a.processIdentifier).first(where: titleMatches) {
                        target = (a.processIdentifier, w)
                        break
                    }
                }
                guard target != nil else { throw HelperError.notFound("no window of '\(app)' has a title containing '\(title ?? "")'") }
            } else {
                let pid = apps[0].processIdentifier
                let appEl = AXUIElementCreateApplication(pid)
                AXUIElementSetMessagingTimeout(appEl, 2)
                var main: AXUIElement?
                if let v = axCopy(appEl, kAXMainWindowAttribute), CFGetTypeID(v) == AXUIElementGetTypeID() {
                    main = (v as! AXUIElement)
                }
                target = (pid, main ?? axWindows(pid: pid).first)
            }
        } else if titleFilter != nil {
            let apps = NSWorkspace.shared.runningApplications.filter { $0.activationPolicy == .regular }
            for a in apps {
                if let w = axWindows(pid: a.processIdentifier).first(where: titleMatches) {
                    target = (a.processIdentifier, w)
                    break
                }
            }
            guard target != nil else { throw HelperError.notFound("no window title contains '\(title ?? "")'") }
        } else {
            throw HelperError.invalid("give window_id, app or title")
        }

        guard let t = target else { throw HelperError.notFound("window not found") }
        let running = NSRunningApplication(processIdentifier: t.pid)
        running?.activate(options: [])
        let appEl = AXUIElementCreateApplication(t.pid)
        AXUIElementSetMessagingTimeout(appEl, 2)
        AXUIElementSetAttributeValue(appEl, kAXFrontmostAttribute as CFString, kCFBooleanTrue)
        var windowTitle = ""
        if let w = t.window {
            if let m = axCopy(w, kAXMinimizedAttribute) as? Bool, m {
                AXUIElementSetAttributeValue(w, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
            }
            AXUIElementPerformAction(w, kAXRaiseAction as CFString)
            AXUIElementSetAttributeValue(w, kAXMainAttribute as CFString, kCFBooleanTrue)
            AXUIElementSetAttributeValue(w, kAXFocusedAttribute as CFString, kCFBooleanTrue)
            windowTitle = axTitle(w)
        }
        return [
            "pid": Int(t.pid),
            "app": running?.localizedName ?? "",
            "title": windowTitle,
        ]
    }
}
