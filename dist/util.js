import { randomBytes } from 'node:crypto';
/** Crockford base32 alphabet (no I, L, O, U) - short ids that are easy for LLMs to copy. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newId(prefix, length = 10) {
    const bytes = randomBytes(length);
    let out = '';
    for (const b of bytes)
        out += ALPHABET[b & 31];
    return `${prefix}-${out}`;
}
export function nowMs() {
    return Date.now();
}
export function iso(ms) {
    return ms == null ? null : new Date(ms).toISOString();
}
export function parseJson(text, fallback) {
    if (text == null || text === '')
        return fallback;
    try {
        return JSON.parse(text);
    }
    catch {
        return fallback;
    }
}
export function sleep(ms, signal) {
    return new Promise((resolve) => {
        if (signal?.aborted)
            return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal?.removeEventListener('abort', done);
            resolve();
        }
        signal?.addEventListener('abort', done, { once: true });
    });
}
export function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}
/** Error with a machine-readable code and an optional hint telling the calling agent how to recover. */
export class BruceError extends Error {
    code;
    hint;
    constructor(code, message, hint) {
        super(message);
        this.code = code;
        this.hint = hint;
        this.name = 'BruceError';
    }
}
//# sourceMappingURL=util.js.map