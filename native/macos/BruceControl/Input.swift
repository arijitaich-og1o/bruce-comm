// Synthetic mouse/keyboard/scroll events (CGEvent, HID system state source, posted to the HID tap).
import CoreGraphics
import Foundation

/// Access re-check between chunks of long operations; throws to stop.
typealias Gate = () throws -> Void

/// Posts one synthetic event. The app always uses Input.postToHID; tests pass a recorder (nothing is posted).
typealias EventPoster = (CGEvent) -> Void

/// Requested modifiers: cmd/shift/option/control are pressed as real keys (in the order given), fn is a flag only.
struct Modifiers: Equatable {
    var keys: [CGKeyCode] = []
    var flags: CGEventFlags = []
}

/// One synthetic key event (for building and testing the modifier sequence).
struct KeyStroke: Equatable {
    let code: CGKeyCode
    let down: Bool
    let flags: CGEventFlags
}

struct MouseButtonSpec {
    let down: CGEventType
    let up: CGEventType
    let dragged: CGEventType
    let button: CGMouseButton

    static func parse(_ name: String?) throws -> MouseButtonSpec {
        switch (name ?? "left").lowercased() {
        case "left": return MouseButtonSpec(down: .leftMouseDown, up: .leftMouseUp, dragged: .leftMouseDragged, button: .left)
        case "right": return MouseButtonSpec(down: .rightMouseDown, up: .rightMouseUp, dragged: .rightMouseDragged, button: .right)
        case "middle": return MouseButtonSpec(down: .otherMouseDown, up: .otherMouseUp, dragged: .otherMouseDragged, button: .center)
        default: throw HelperError.invalid("button must be left, right or middle")
        }
    }
}

enum Input {
    static let returnKey: CGKeyCode = 36
    static let tabKey: CGKeyCode = 48
    static let maxChunkUnits = 16

    private static func source() throws -> CGEventSource {
        guard let src = CGEventSource(stateID: .hidSystemState) else { throw HelperError.failed("could not create event source") }
        src.localEventsSuppressionInterval = 0 // keep the owner's own mouse/keyboard live
        return src
    }

    /// Left-hand modifier keys (kVK_Command, kVK_Shift, kVK_Option, kVK_Control).
    static let modifierKeys: [(name: String, code: CGKeyCode, flag: CGEventFlags)] = [
        ("cmd", 55, .maskCommand), ("shift", 56, .maskShift), ("option", 58, .maskAlternate), ("control", 59, .maskControl),
    ]

    static func parseModifiers(_ names: [String]) throws -> Modifiers {
        var m = Modifiers()
        for n in names {
            let name = n.lowercased()
            if name == "fn" {
                m.flags.insert(.maskSecondaryFn) // a synthetic fn key event is unreliable: flag only
                continue
            }
            guard let entry = modifierKeys.first(where: { $0.name == name }) else {
                throw HelperError.invalid("unknown modifier '\(n)' (use cmd, shift, option, control, fn)")
            }
            if !m.keys.contains(entry.code) {
                m.keys.append(entry.code)
                m.flags.insert(entry.flag)
            }
        }
        return m
    }

    private static func modifierFlag(_ code: CGKeyCode) -> CGEventFlags {
        modifierKeys.first { $0.code == code }?.flag ?? []
    }

    /// Modifier key-downs with growing flags, then key-ups in reverse order with shrinking flags.
    static func modifierStrokes(_ m: Modifiers) -> (press: [KeyStroke], release: [KeyStroke]) {
        var acc: CGEventFlags = []
        var press: [KeyStroke] = []
        for code in m.keys {
            acc.insert(modifierFlag(code))
            press.append(KeyStroke(code: code, down: true, flags: acc))
        }
        var release: [KeyStroke] = []
        for code in m.keys.reversed() {
            acc.remove(modifierFlag(code))
            release.append(KeyStroke(code: code, down: false, flags: acc))
        }
        return (press, release)
    }

    /// Posts `press`, runs `body`, then always posts `release`, also when `body` throws (e.g. the kill gate).
    static func holding<E>(_ press: [E], _ release: [E], post: (E) -> Void, _ body: () throws -> Void) rethrows {
        for e in press { post(e) }
        defer { for e in release { post(e) } }
        try body()
    }

    private static func keyEvents(_ src: CGEventSource, _ strokes: [KeyStroke]) throws -> [CGEvent] {
        try strokes.map { k in
            guard let e = CGEvent(keyboardEventSource: src, virtualKey: k.code, keyDown: k.down) else {
                throw HelperError.failed("could not create keyboard event")
            }
            e.flags = k.flags
            return e
        }
    }

    static let postToHID: EventPoster = { $0.post(tap: .cghidEventTap) }

    static func cursor() -> CGPoint {
        CGEvent(source: nil)?.location ?? .zero
    }

    private static func mouseEvent(_ src: CGEventSource, _ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton) throws -> CGEvent {
        guard let e = CGEvent(mouseEventSource: src, mouseType: type, mouseCursorPosition: p, mouseButton: button) else {
            throw HelperError.failed("could not create mouse event")
        }
        return e
    }

    static func move(to p: CGPoint) throws {
        let src = try source()
        let e = try mouseEvent(src, .mouseMoved, p, .left)
        e.flags = []
        e.post(tap: .cghidEventTap)
    }

    /// Moves, holds the modifier keys, posts `count` down/up pairs with mouseEventClickState 1..count, releases.
    static func click(at p: CGPoint, button: MouseButtonSpec, count: Int, modifiers: Modifiers,
                      post: EventPoster = postToHID) throws {
        let src = try source()
        // Build every event first so a down is never left without its up.
        let move = try mouseEvent(src, .mouseMoved, p, .left)
        var pairs: [(CGEvent, CGEvent)] = []
        for state in 1...count {
            let down = try mouseEvent(src, button.down, p, button.button)
            let up = try mouseEvent(src, button.up, p, button.button)
            down.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            up.setIntegerValueField(.mouseEventClickState, value: Int64(state))
            down.flags = modifiers.flags
            up.flags = modifiers.flags
            pairs.append((down, up))
        }
        let strokes = modifierStrokes(modifiers)
        let press = try keyEvents(src, strokes.press)
        let release = try keyEvents(src, strokes.release)
        move.flags = []
        post(move)
        sleepMs(30)
        holding(press, release, post: { post($0); sleepMs(8) }) {
            for (i, pair) in pairs.enumerated() {
                if i > 0 { sleepMs(40) }
                post(pair.0)
                sleepMs(15)
                post(pair.1)
            }
        }
    }

    /// Down at path[0], *Dragged events about every 16 ms through every vertex, up at the last point.
    /// The button is always released, also when `gate` stops the drag.
    static func drag(path: [CGPoint], button: MouseButtonSpec, durationMs: Int, gate: Gate) throws {
        precondition(path.count >= 2)
        let src = try source()
        let move = try mouseEvent(src, .mouseMoved, path[0], .left)
        let down = try mouseEvent(src, button.down, path[0], button.button)
        down.setIntegerValueField(.mouseEventClickState, value: 1)
        down.flags = []
        let steps = dragSteps(path, durationMs: durationMs)
        let interval = Double(durationMs) / Double(steps.count)

        move.flags = []
        move.post(tap: .cghidEventTap)
        sleepMs(30)
        down.post(tap: .cghidEventTap)
        var last = path[0]
        var stopError: Error?
        for p in steps {
            sleepMs(interval)
            do {
                try gate()
                let e = try mouseEvent(src, button.dragged, p, button.button)
                e.setIntegerValueField(.mouseEventClickState, value: 1)
                e.flags = []
                e.post(tap: .cghidEventTap)
                last = p
            } catch {
                stopError = error
                break
            }
        }
        sleepMs(20)
        if let up = CGEvent(mouseEventSource: src, mouseType: button.up, mouseCursorPosition: last, mouseButton: button.button) {
            up.setIntegerValueField(.mouseEventClickState, value: 1)
            up.flags = []
            up.post(tap: .cghidEventTap)
        } else {
            logLine("drag: could not create the mouse-up event")
        }
        if let stopError { throw stopError }
    }

    /// Interpolated drag points: at least one per segment, ~duration/16 overall, ending exactly on each vertex.
    static func dragSteps(_ path: [CGPoint], durationMs: Int) -> [CGPoint] {
        let segments = path.count - 1
        let target = max(segments, Int((Double(durationMs) / 16).rounded()))
        let lengths = (0..<segments).map { i in hypot(Double(path[i + 1].x - path[i].x), Double(path[i + 1].y - path[i].y)) }
        let total = lengths.reduce(0, +)
        var counts = [Int](repeating: 1, count: segments)
        let extra = target - segments
        if extra > 0 {
            var assigned = 0
            if total > 0 {
                for i in 0..<segments {
                    let share = Int((Double(extra) * lengths[i] / total).rounded(.down))
                    counts[i] += share
                    assigned += share
                }
            }
            counts[segments - 1] += extra - assigned
        }
        var out: [CGPoint] = []
        out.reserveCapacity(target)
        for i in 0..<segments {
            let a = path[i], b = path[i + 1]
            for k in 1...counts[i] {
                let t = CGFloat(k) / CGFloat(counts[i])
                out.append(CGPoint(x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t))
            }
        }
        return out
    }

    /// Moves to p, then `amount` line-unit wheel events of 3 lines each ("down" = content moves up = negative wheel1).
    static func scroll(at p: CGPoint, direction: String, amount: Int, gate: Gate) throws {
        let (w1, w2): (Int32, Int32)
        switch direction.lowercased() {
        case "up": (w1, w2) = (3, 0)
        case "down": (w1, w2) = (-3, 0)
        case "left": (w1, w2) = (0, 3)
        case "right": (w1, w2) = (0, -3)
        default: throw HelperError.invalid("direction must be up, down, left or right")
        }
        let src = try source()
        let move = try mouseEvent(src, .mouseMoved, p, .left)
        move.flags = []
        move.post(tap: .cghidEventTap)
        sleepMs(30)
        for i in 0..<amount {
            if i > 0 {
                sleepMs(20)
                try gate()
            }
            guard let e = CGEvent(scrollWheelEvent2Source: src, units: .line, wheelCount: 2, wheel1: w1, wheel2: w2, wheel3: 0) else {
                throw HelperError.failed("could not create scroll event")
            }
            e.location = p
            e.flags = []
            e.post(tap: .cghidEventTap)
        }
    }

    enum TypeChunk: Equatable {
        case text([UInt16])
        case key(CGKeyCode, units: Int)
    }

    /// Splits text into <=16 UTF-16 unit chunks on grapheme boundaries; newline/tab become Return/Tab.
    static func typeChunks(_ text: String) -> [TypeChunk] {
        var chunks: [TypeChunk] = []
        var current: [UInt16] = []
        func flush() {
            if !current.isEmpty { chunks.append(.text(current)) }
            current = []
        }
        for ch in text {
            switch ch {
            case "\n", "\r", "\r\n":
                flush()
                chunks.append(.key(returnKey, units: ch.utf16.count))
            case "\t":
                flush()
                chunks.append(.key(tabKey, units: 1))
            default:
                let units = Array(ch.utf16)
                if units.count > maxChunkUnits {
                    // Pathological grapheme: split on scalar boundaries.
                    flush()
                    for scalar in ch.unicodeScalars {
                        let su = Array(String(scalar).utf16)
                        if current.count + su.count > maxChunkUnits { flush() }
                        current += su
                    }
                    flush()
                } else {
                    if current.count + units.count > maxChunkUnits { flush() }
                    current += units
                }
            }
        }
        flush()
        return chunks
    }

    /// Types text; returns the number of UTF-16 units typed. `gate` runs between chunks.
    static func type(_ text: String, gate: Gate) throws -> Int {
        let chunks = typeChunks(text)
        let total = text.utf16.count
        guard !chunks.isEmpty else { return 0 }
        let src = try source()
        var typed = 0
        for (i, chunk) in chunks.enumerated() {
            if i > 0 {
                sleepMs(8)
                do {
                    try gate()
                } catch let e as HelperError {
                    throw HelperError(e.code, "\(e.message) (stopped after \(typed) of \(total) characters)")
                }
            }
            let down: CGEvent?
            let up: CGEvent?
            let units: Int
            switch chunk {
            case .text(let u):
                down = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: true)
                up = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: false)
                down?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
                up?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u)
                units = u.count
            case .key(let code, let n):
                down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true)
                up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false)
                units = n
            }
            guard let down, let up else { throw HelperError.failed("could not create keyboard event") }
            down.flags = []
            up.flags = []
            down.post(tap: .cghidEventTap)
            up.post(tap: .cghidEventTap)
            typed += units
        }
        return typed
    }

    /// Key press while the modifier keys are held (flags also on down and up); `gate` runs between repeats.
    /// The modifiers are released even when the gate stops the repeats.
    static func key(code: CGKeyCode, modifiers: Modifiers, repeatCount: Int, gate: Gate,
                    post: EventPoster = postToHID) throws {
        let src = try source()
        var f = modifiers.flags
        // Hardware sets these for navigation/function keys; some apps rely on them.
        switch code {
        case 123, 124, 125, 126: f.formUnion([.maskNumericPad, .maskSecondaryFn])
        case 115, 116, 117, 119, 121,
             122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90:
            f.insert(.maskSecondaryFn)
        default: break
        }
        // Build every event first so nothing is pressed without its release.
        var pairs: [(CGEvent, CGEvent)] = []
        for _ in 0..<repeatCount {
            guard let down = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: true),
                  let up = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: false) else {
                throw HelperError.failed("could not create keyboard event")
            }
            down.flags = f
            up.flags = f
            pairs.append((down, up))
        }
        let strokes = modifierStrokes(modifiers)
        let press = try keyEvents(src, strokes.press)
        let release = try keyEvents(src, strokes.release)
        try holding(press, release, post: { post($0); sleepMs(8) }) {
            for (i, pair) in pairs.enumerated() {
                if i > 0 {
                    sleepMs(30)
                    try gate()
                }
                post(pair.0)
                sleepMs(10)
                post(pair.1)
            }
        }
    }
}
