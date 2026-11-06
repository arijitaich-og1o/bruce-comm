import { BruceError } from '../util.js';
export const DEFAULT_LIMITS = { maxLongEdge: 1568, maxPixels: 1_150_000 };
/** DEFAULT_LIMITS with the env overrides BRUCE_PC_MAX_LONG_EDGE / BRUCE_PC_MAX_PIXELS (positive integers) applied. */
export function imageLimits(env = process.env) {
    return {
        maxLongEdge: positiveInt(env.BRUCE_PC_MAX_LONG_EDGE) ?? DEFAULT_LIMITS.maxLongEdge,
        maxPixels: positiveInt(env.BRUCE_PC_MAX_PIXELS) ?? DEFAULT_LIMITS.maxPixels,
    };
}
function positiveInt(raw) {
    const n = Number(raw);
    return raw && Number.isInteger(n) && n >= 1 ? n : undefined;
}
/**
 * Scale (width x height) down - never up - so the long edge <= maxLongEdge and width*height <= maxPixels.
 * Integers >= 1, aspect kept (rounded down).
 */
export function fitWithin(width, height, limits = imageLimits()) {
    if (!(width > 0) || !(height > 0) || !Number.isFinite(width) || !Number.isFinite(height)) {
        throw new BruceError('invalid_argument', `Invalid image size ${width}x${height}.`);
    }
    const maxLongEdge = Math.max(1, limits.maxLongEdge);
    const maxPixels = Math.max(1, limits.maxPixels);
    let f = Math.min(1, maxLongEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
    const size = (factor) => ({
        width: Math.max(1, Math.floor(width * factor + 1e-9)),
        height: Math.max(1, Math.floor(height * factor + 1e-9)),
    });
    let out = size(f);
    // Floating point may land a hair over a limit: shrink until it fits.
    while ((out.width * out.height > maxPixels || Math.max(out.width, out.height) > maxLongEdge) && (out.width > 1 || out.height > 1)) {
        f *= 0.999;
        out = size(f);
    }
    return out;
}
/** Size of a full screenshot of `display`: native pixels scaled down to the limits. */
export function screenshotSize(display, limits = imageLimits()) {
    const { width, height } = fitWithin(display.pixel_width, display.pixel_height, limits);
    return { width, height, pointsPerPixel: display.frame.width / width };
}
/** Round to 2 decimals. */
function round2(n) {
    return Math.round(n * 100) / 100;
}
/** Map screenshot pixel (x, y) to global screen points (centre of that pixel). Throws invalid_argument outside the image. */
export function imageToScreen(display, shot, x, y) {
    const okX = Number.isFinite(x) && x >= 0 && x < shot.width;
    const okY = Number.isFinite(y) && y >= 0 && y < shot.height;
    if (!okX || !okY) {
        throw new BruceError('invalid_argument', `(${x}, ${y}) is outside the ${shot.width}x${shot.height} px screenshot of display ${display.index}.`, `Use 0 <= x < ${shot.width} and 0 <= y < ${shot.height} (pixels of the pc_screenshot of display ${display.index}).`);
    }
    const f = display.frame;
    const sx = round2(f.x + ((x + 0.5) * f.width) / shot.width);
    const sy = round2(f.y + ((y + 0.5) * f.height) / shot.height);
    return {
        x: Math.min(Math.max(sx, f.x), round2(f.x + f.width - 0.01)),
        y: Math.min(Math.max(sy, f.y), round2(f.y + f.height - 0.01)),
    };
}
/** Map global points to integer screenshot pixels of `display`; null if the point is not on that display. */
export function screenToImage(display, shot, px, py) {
    if (!contains(display.frame, px, py))
        return null;
    const f = display.frame;
    const x = Math.floor(((px - f.x) * shot.width) / f.width + 1e-9);
    const y = Math.floor(((py - f.y) * shot.height) / f.height + 1e-9);
    return { x: Math.min(Math.max(x, 0), shot.width - 1), y: Math.min(Math.max(y, 0), shot.height - 1) };
}
function contains(r, px, py) {
    return Number.isFinite(px) && Number.isFinite(py) && px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height;
}
/** The display containing global point (px, py). */
export function displayAt(displays, px, py) {
    return displays.find((d) => contains(d.frame, px, py));
}
/** Smallest zoom region edge, in screenshot pixels. */
export const MIN_ZOOM_PX = 8;
/** Small zoom regions are enlarged until their long edge reaches this many pixels (within the image limits). */
export const MIN_ZOOM_LONG_EDGE = 400;
/**
 * Plan a zoom of screenshot-pixel rectangle `r` of `display`: the region in points, captured at native pixel density,
 * enlarged when its long edge is under {@link MIN_ZOOM_LONG_EDGE} px and scaled down to the limits.
 */
export function zoomPlan(display, shot, r, limits = imageLimits()) {
    const finite = [r.x, r.y, r.width, r.height].every(Number.isFinite);
    if (!finite || r.x < 0 || r.y < 0 || r.width < MIN_ZOOM_PX || r.height < MIN_ZOOM_PX || r.x + r.width > shot.width || r.y + r.height > shot.height) {
        throw new BruceError('invalid_argument', `Zoom region x=${r.x}, y=${r.y}, ${r.width}x${r.height} is not inside the ${shot.width}x${shot.height} px screenshot of display ${display.index} ` +
            `(minimum ${MIN_ZOOM_PX}x${MIN_ZOOM_PX} px).`, `Use x >= 0, y >= 0, width/height >= ${MIN_ZOOM_PX}, x + width <= ${shot.width}, y + height <= ${shot.height} (screenshot pixels).`);
    }
    const f = display.frame;
    const px = f.width / shot.width;
    const py = f.height / shot.height;
    const region = {
        x: round2(f.x + r.x * px),
        y: round2(f.y + r.y * py),
        width: round2(r.width * px),
        height: round2(r.height * py),
    };
    const nativeW = Math.max(1, region.width * (display.pixel_width / f.width));
    const nativeH = Math.max(1, region.height * (display.pixel_height / f.height));
    // Enlarge small regions (one factor for both axes); fitWithin then caps the result at the limits.
    const longEdge = Math.max(nativeW, nativeH);
    const up = longEdge < MIN_ZOOM_LONG_EDGE ? MIN_ZOOM_LONG_EDGE / longEdge : 1;
    const size = fitWithin(nativeW * up, nativeH * up, limits);
    const kx = size.width / r.width;
    const ky = size.height / r.height;
    return { region, width: size.width, height: size.height, kx, ky, imagePerScreenshotPixel: kx };
}
//# sourceMappingURL=geometry.js.map