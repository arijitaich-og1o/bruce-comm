import { randomBytes } from 'node:crypto';

/** Crockford base32 alphabet (no I, L, O, U) - short ids that are easy for LLMs to copy. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function newId(prefix: string, length = 10): string {
  const bytes = randomBytes(length);
  let out = '';
  for (const b of bytes) out += ALPHABET[b & 31];
  return `${prefix}-${out}`;
}

export function nowMs(): number {
  return Date.now();
}

export function iso(ms: number | null | undefined): string | null {
  return ms == null ? null : new Date(ms).toISOString();
}

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (text == null || text === '') return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Error with a machine-readable code and an optional hint telling the calling agent how to recover. */
export class BruceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'BruceError';
  }
}
