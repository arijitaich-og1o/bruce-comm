// Displays (global points) and ScreenCaptureKit screenshots with PNG/JPEG encoding.
import CoreGraphics
import Foundation
import ImageIO
import ScreenCaptureKit

struct DisplayInfo {
    let id: CGDirectDisplayID
    let index: Int
    let main: Bool
    let frame: CGRect // global points
    let pixelWidth: Int
    let pixelHeight: Int
    let scale: Double
    let rotation: Int // degrees: 0, 90, 180, 270

    var json: [String: Any] {
        [
            "id": Int(id), "index": index, "main": main,
            "frame": ["x": Double(frame.origin.x), "y": Double(frame.origin.y),
                      "width": Double(frame.width), "height": Double(frame.height)],
            "pixel_width": pixelWidth, "pixel_height": pixelHeight, "scale": scale, "rotation": rotation,
        ]
    }
}

enum Displays {
    /// Active displays, main first, hardware mirrors skipped.
    static func list() -> [DisplayInfo] {
        var count: UInt32 = 0
        guard CGGetActiveDisplayList(0, nil, &count) == .success, count > 0 else { return [] }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        guard CGGetActiveDisplayList(count, &ids, &count) == .success else { return [] }
        ids = Array(ids.prefix(Int(count)))
        let mainId = CGMainDisplayID()
        ids = ids.filter { $0 == mainId || CGDisplayMirrorsDisplay($0) == kCGNullDirectDisplay }
        let ordered = ids.filter { $0 == mainId } + ids.filter { $0 != mainId }
        return ordered.enumerated().map { idx, id in
            let frame = CGDisplayBounds(id)
            var pw = Int(frame.width.rounded())
            var ph = Int(frame.height.rounded())
            if let mode = CGDisplayCopyDisplayMode(id), mode.pixelWidth > 0, mode.pixelHeight > 0 {
                pw = mode.pixelWidth
                ph = mode.pixelHeight
            }
            let rotation = normalizedRotation(CGDisplayRotation(id))
            (pw, ph) = orientedPixelSize(frameWidth: Double(frame.width), frameHeight: Double(frame.height),
                                         pixelWidth: pw, pixelHeight: ph)
            let scale = frame.width > 0 ? Double(pw) / Double(frame.width) : 1
            return DisplayInfo(id: id, index: idx, main: id == mainId, frame: frame,
                               pixelWidth: pw, pixelHeight: ph, scale: scale, rotation: rotation)
        }
    }

    /// 0, 90, 180 or 270.
    static func normalizedRotation(_ degrees: Double) -> Int {
        guard degrees.isFinite else { return 0 }
        let r = ((Int(degrees.rounded()) % 360) + 360) % 360
        return (r / 90) * 90
    }

    /// Display modes give the panel's unrotated pixel size, while the frame (points) is rotated. A display turned
    /// 90/270 degrees therefore shows a landscape mode on a portrait frame (or the reverse): swap so pixels follow
    /// the frame. When the sizes already agree (also if macOS reports rotated modes) nothing changes.
    static func orientedPixelSize(frameWidth: Double, frameHeight: Double, pixelWidth: Int, pixelHeight: Int) -> (Int, Int) {
        guard frameWidth > 0, frameHeight > 0, frameWidth != frameHeight, pixelWidth != pixelHeight else {
            return (pixelWidth, pixelHeight)
        }
        if (frameWidth > frameHeight) != (pixelWidth > pixelHeight) { return (pixelHeight, pixelWidth) }
        return (pixelWidth, pixelHeight)
    }

    /// True if the global point lies on some active display (edges inclusive, 1 pt tolerance).
    static func contains(_ p: CGPoint) -> Bool {
        list().contains { d in
            let f = d.frame
            return p.x >= f.minX - 1 && p.x <= f.maxX + 1 && p.y >= f.minY - 1 && p.y <= f.maxY + 1
        }
    }

    static func requireOnScreen(_ p: CGPoint, _ what: String = "point") throws {
        guard contains(p) else {
            throw HelperError.invalid("\(what) (\(p.x), \(p.y)) is not on any display (global points)")
        }
    }
}

// MARK: - Screenshot

struct ScreenshotRequest {
    var displayId: CGDirectDisplayID?
    var width: Int?
    var height: Int?
    var region: CGRect?
    var format: String
    var jpegQuality: Double
    var maxBytes: Int
    var showCursor: Bool
    var thumbnail: (maxWidth: Int, quality: Double)?

    init(_ a: Args) throws {
        if let id = try a.int("display_id") {
            guard id >= 0, id <= Int(UInt32.max) else { throw HelperError.invalid("display_id out of range") }
            displayId = CGDirectDisplayID(id)
        }
        width = try a.int("width")
        height = try a.int("height")
        if let w = width, !(1...16384).contains(w) { throw HelperError.invalid("width must be 1..16384") }
        if let h = height, !(1...16384).contains(h) { throw HelperError.invalid("height must be 1..16384") }
        region = try a.rect("region")
        format = (try a.string("format") ?? "auto").lowercased()
        if format == "jpg" { format = "jpeg" }
        guard ["auto", "png", "jpeg"].contains(format) else { throw HelperError.invalid("format must be auto, png or jpeg") }
        jpegQuality = try a.number("jpeg_quality") ?? 0.8
        guard jpegQuality > 0, jpegQuality <= 1 else { throw HelperError.invalid("jpeg_quality must be in (0, 1]") }
        maxBytes = try a.int("max_bytes") ?? 1_000_000
        guard maxBytes >= 1 else { throw HelperError.invalid("max_bytes must be >= 1") }
        showCursor = try a.bool("show_cursor") ?? true
        if let t = try a.object("thumbnail") {
            let mw = try t.int("max_width", default: 480, range: 16...4096)
            let q = try t.number("quality") ?? 0.6
            guard q > 0, q <= 1 else { throw HelperError.invalid("thumbnail.quality must be in (0, 1]") }
            thumbnail = (mw, q)
        }
    }
}

enum Capture {
    static let pngThreshold = 600_000
    static let fallbackQualities: [Double] = [0.65, 0.5, 0.4]

    static func screenshot(_ r: ScreenshotRequest) throws -> [String: Any] {
        let displays = Displays.list()
        let id = r.displayId ?? CGMainDisplayID()
        guard let display = displays.first(where: { $0.id == id }) else {
            throw HelperError.notFound("display \(id) is not an active display")
        }
        let frame = display.frame
        var region = frame
        if let req = r.region {
            let tol: CGFloat = 0.5
            guard req.minX >= frame.minX - tol, req.minY >= frame.minY - tol,
                  req.maxX <= frame.maxX + tol, req.maxY <= frame.maxY + tol else {
                throw HelperError.invalid("region must lie inside display \(id) (frame \(frame.origin.x),\(frame.origin.y) \(frame.width)x\(frame.height) points)")
            }
            region = req.intersection(frame)
            guard region.width > 0, region.height > 0 else { throw HelperError.invalid("region is empty") }
        }
        let width = r.width ?? max(1, Int((Double(region.width) * display.scale).rounded()))
        let height = r.height ?? max(1, Int((Double(region.height) * display.scale).rounded()))
        guard width * height <= 100_000_000 else { throw HelperError.invalid("requested image is too large") }

        // sourceRect is display-LOCAL points.
        let local = CGRect(x: region.minX - frame.minX, y: region.minY - frame.minY, width: region.width, height: region.height)
        let captured = try captureDisplay(id, sourceRect: local, width: width, height: height, showCursor: r.showCursor)
        guard let image = render(captured, width: width, height: height) else {
            throw HelperError.failed("could not render captured image")
        }

        let (data, mime) = try encodeWithPolicy(image, format: r.format, jpegQuality: r.jpegQuality, maxBytes: r.maxBytes)
        var out: [String: Any] = [
            "data": data.base64EncodedString(), "mime_type": mime,
            "width": width, "height": height, "bytes": data.count,
        ]
        if let t = r.thumbnail {
            let tw = min(t.maxWidth, width)
            let th = max(1, Int((Double(height) * Double(tw) / Double(width)).rounded()))
            if let small = render(image, width: tw, height: th), let jpg = encode(small, type: "public.jpeg", quality: t.quality) {
                out["thumbnail"] = ["data": jpg.base64EncodedString(), "mime_type": "image/jpeg", "width": tw, "height": th]
            }
        }
        return out
    }

    private static func captureDisplay(_ id: CGDirectDisplayID, sourceRect: CGRect, width: Int, height: Int, showCursor: Bool) throws -> CGImage {
        let contentResult: Result<SCShareableContent, Error>? = waitFor(timeout: 15) { finish in
            SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, error in
                if let content { finish(.success(content)) } else { finish(.failure(error ?? HelperError.failed("no shareable content"))) }
            }
        }
        guard let contentResult else { throw HelperError.failed("timed out listing shareable content") }
        let content: SCShareableContent
        switch contentResult {
        case .success(let c): content = c
        case .failure(let e): throw mapCaptureError(e)
        }
        guard let scDisplay = content.displays.first(where: { $0.displayID == id }) else {
            throw HelperError.notFound("display \(id) is not available to ScreenCaptureKit")
        }
        let filter = SCContentFilter(display: scDisplay, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = width
        cfg.height = height
        cfg.sourceRect = sourceRect
        cfg.showsCursor = showCursor
        cfg.scalesToFit = true
        cfg.preservesAspectRatio = false
        cfg.captureResolution = .best
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.colorSpaceName = CGColorSpace.sRGB
        let imageResult: Result<CGImage, Error>? = waitFor(timeout: 20) { finish in
            SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg) { image, error in
                if let image { finish(.success(image)) } else { finish(.failure(error ?? HelperError.failed("no image"))) }
            }
        }
        guard let imageResult else { throw HelperError.failed("timed out capturing the screen") }
        switch imageResult {
        case .success(let img): return img
        case .failure(let e): throw mapCaptureError(e)
        }
    }

    private static func mapCaptureError(_ e: Error) -> HelperError {
        if let he = e as? HelperError { return he }
        let ns = e as NSError
        if ns.domain == SCStreamErrorDomain, ns.code == SCStreamError.Code.userDeclined.rawValue {
            return .screenRecordingMissing
        }
        return .failed("screen capture failed: \(ns.localizedDescription) (\(ns.domain) \(ns.code))")
    }

    /// Redraws into an opaque sRGB bitmap of exactly width x height.
    static func render(_ image: CGImage, width: Int, height: Int) -> CGImage? {
        if image.width == width, image.height == height, image.alphaInfo == .noneSkipFirst || image.alphaInfo == .noneSkipLast {
            return image
        }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space,
                                  bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue) else {
            return nil
        }
        ctx.interpolationQuality = .high
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        return ctx.makeImage()
    }

    static func encode(_ image: CGImage, type: String, quality: Double? = nil) -> Data? {
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out as CFMutableData, type as CFString, 1, nil) else { return nil }
        var props: [CFString: Any] = [:]
        if let q = quality { props[kCGImageDestinationLossyCompressionQuality] = q }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    /// png: PNG. jpeg: JPEG at q, then 0.65/0.5/0.4 (below q) until <= maxBytes.
    /// auto: PNG if <= 600,000 bytes, else as jpeg. Returns the smallest candidate when none fits.
    static func encodeWithPolicy(_ image: CGImage, format: String, jpegQuality: Double, maxBytes: Int) throws -> (Data, String) {
        if format == "png" || format == "auto" {
            guard let png = encode(image, type: "public.png") else { throw HelperError.failed("PNG encoding failed") }
            if format == "png" || png.count <= pngThreshold { return (png, "image/png") }
            var best = (png, "image/png")
            for q in [jpegQuality] + fallbackQualities.filter({ $0 < jpegQuality }) {
                guard let jpg = encode(image, type: "public.jpeg", quality: q) else { continue }
                if jpg.count < best.0.count { best = (jpg, "image/jpeg") }
                if jpg.count <= maxBytes {
                    // Lossless PNG wins if it also fits and is not larger.
                    return (png.count <= maxBytes && png.count <= jpg.count) ? (png, "image/png") : (jpg, "image/jpeg")
                }
            }
            return best
        }
        var best: (Data, String)?
        for q in [jpegQuality] + fallbackQualities.filter({ $0 < jpegQuality }) {
            guard let jpg = encode(image, type: "public.jpeg", quality: q) else { continue }
            if best == nil || jpg.count < best!.0.count { best = (jpg, "image/jpeg") }
            if jpg.count <= maxBytes { return (jpg, "image/jpeg") }
        }
        guard let b = best else { throw HelperError.failed("JPEG encoding failed") }
        return b
    }
}
