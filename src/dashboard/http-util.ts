import { createHash, timingSafeEqual } from 'node:crypto';
import type http from 'node:http';

/** Largest request body accepted on /mcp and /api (JSON). */
export const BODY_LIMIT_BYTES = 1024 * 1024;

/** An error that maps directly onto an HTTP response (`{error: {code, message, hint}}`). */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly hint?: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** Headers every response carries, whatever the route. */
export function setBaseHeaders(res: http.ServerResponse): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
}

/** Send a JSON document. Never cached: everything the gateway serves as JSON is live state. */
export function sendJson(
  res: http.ServerResponse,
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': String(Buffer.byteLength(body)),
    ...headers,
  });
  res.end(body);
}

/** REST error envelope: `{error: {code, message, hint?}}`. */
export function sendError(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  hint?: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { error: { code, message, ...(hint ? { hint } : {}) } }, headers);
}

/** JSON-RPC error envelope used on /mcp, matching the SDK's own transport errors. */
export function sendJsonRpcError(
  res: http.ServerResponse,
  status: number,
  code: number,
  message: string,
  headers: Record<string, string> = {},
): void {
  sendJson(res, status, { jsonrpc: '2.0', error: { code, message }, id: null }, headers);
}

/**
 * After answering a request early (e.g. 413), discard the rest of its upload without buffering it,
 * so the client is still reading when the response arrives (closing a socket with unread input
 * makes the OS send a reset and the client loses the response). Gives up after `graceMs`.
 */
export function discardRemainingBody(req: http.IncomingMessage, graceMs = 5000): void {
  if (req.complete) return;
  const timer = setTimeout(() => req.socket.destroy(), graceMs);
  timer.unref();
  const clear = () => clearTimeout(timer);
  req.once('end', clear);
  req.once('close', clear);
  req.resume();
}

/**
 * Read the raw request body, enforcing `limit`. Exceeding the limit rejects with a 413 HttpError;
 * the rest of the upload is discarded (see discardRemainingBody).
 */
export function readBody(req: http.IncomingMessage, limit = BODY_LIMIT_BYTES): Promise<Buffer> {
  const tooLarge = () =>
    new HttpError(413, 'payload_too_large', `Request body exceeds ${Math.round(limit / 1024)} KB.`, 'Send less data.');
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    discardRemainingBody(req);
    return Promise.reject(tooLarge());
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (err) {
        discardRemainingBody(req);
        reject(err);
      } else {
        resolve(Buffer.concat(chunks));
      }
    };
    const onData = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) return finish(tooLarge());
      chunks.push(chunk);
    };
    const onEnd = () => finish(null);
    const onError = (err: Error) => finish(err);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** Whether a Content-Type header denotes JSON (`application/json`, optionally with parameters). */
export function isJsonContentType(value: string | undefined): boolean {
  if (!value) return false;
  const type = value.split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

/** Whether the request carries a body at all (declared length > 0 or chunked). */
export function hasBody(req: http.IncomingMessage): boolean {
  const length = Number(req.headers['content-length'] ?? 0);
  return (Number.isFinite(length) && length > 0) || req.headers['transfer-encoding'] !== undefined;
}

/**
 * Read a JSON object body for the REST API. An empty body yields `{}`. Requires a JSON
 * Content-Type when a body is present: browsers cannot send that cross-site without a CORS
 * preflight, which this server never grants.
 */
export async function readJsonObject(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  if (!hasBody(req)) return {};
  if (!isJsonContentType(req.headers['content-type'])) {
    req.resume();
    throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json.');
  }
  const raw = (await readBody(req)).toString('utf8');
  if (!raw.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_argument', 'Request body must be a JSON object.');
  }
  return value as Record<string, unknown>;
}

/** Parse a Cookie header into a name -> value map (first occurrence wins). */
export function parseCookies(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) return cookies;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    if (!name || cookies.has(name)) continue;
    let value = part.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) value = value.slice(1, -1);
    try {
      cookies.set(name, decodeURIComponent(value));
    } catch {
      cookies.set(name, value);
    }
  }
  return cookies;
}

/** Constant-time string comparison (hashing first makes the comparison length-independent). */
export function secretEquals(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== 'string' || given.length === 0) return false;
  const a = createHash('sha256').update(expected, 'utf8').digest();
  const b = createHash('sha256').update(given, 'utf8').digest();
  return timingSafeEqual(a, b);
}

/** First value of a header that may be repeated. */
export function headerValue(req: http.IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}
