// GlowCursor bridge: pc_* calls and the kill switch reported to a FAKE GlowCursor (HTTP on a random port, a temp
// GLOWCURSOR_HOME with `port` and `bridge.token`; never the real ~/.glowcursor). PC control runs against an in-process
// fake BruceControl helper (same approach as pc-control.test.mjs; never the real app, no real mouse/keyboard event).
// Tests share one context and run in order.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import zlib from 'node:zlib';
import {
  GLOW_KILL_TTL_MS,
  GlowBridge,
  KEY_CODES,
  canonicalPath,
  getPcControl,
  glowConfig,
  glowDetail,
  mapHelperError,
  setPcHelperClientForTests,
  startPcGlowKillSync,
} from '../dist/pccontrol/index.js';
import { connectInMemory, connectStdio, delay, runCli, startHttp, tempDir, testContext, waitFor } from './helpers.mjs';

// The fake cursor's home. Set before any PC control service exists (the bridge reads the environment when created).
const GLOW_HOME = tempDir('glow');
process.env.GLOWCURSOR_HOME = GLOW_HOME;
delete process.env.BRUCE_GLOW;
// helpers.mjs sets BRUCE_TEST_FIXTURE=1: without GLOWCURSOR_HOME the bridge would be off.
assert.equal(process.env.BRUCE_TEST_FIXTURE, '1');
const SOCKET_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'bcgl-'));
for (const key of ['BRUCE_PC_MAX_LONG_EDGE', 'BRUCE_PC_MAX_PIXELS']) delete process.env[key];
process.env.BRUCE_PC_HELPER_NO_LAUNCH = '1';
process.env.BRUCE_PC_HELPER_APP = path.join(SOCKET_DIR, 'NoSuch.app');
process.env.BRUCE_PC_HELPER_SOCKET = path.join(SOCKET_DIR, 'missing.sock'); // the in-process fake client is used instead

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** GlowCursor's limit for detail.key (Control.swift: `x.string("key", max: 32, .text)`; longer -> 400). */
const KEY_MAX = 32;
const ALL_MODS = ['cmd', 'shift', 'option', 'control', 'fn'];
const HYPER = ['cmd', 'shift', 'option', 'control'];
/** keys.ts names of the keys that type no character (sent under the canonical name). */
const NAMED_KEYS = new Set([
  'return', 'enter', 'kp_enter', 'tab', 'escape', 'esc', 'delete', 'backspace', 'forwarddelete', 'del',
  'up', 'down', 'left', 'right', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'home', 'end',
  'pageup', 'page_up', 'prior', 'pagedown', 'page_down', 'next', 'space', 'spacebar',
  ...Array.from({ length: 20 }, (_, i) => `f${i + 1}`),
]);

// ---------------------------------------------------------------- fake BruceControl helper (from pc-control.test.mjs)

const MAIN = { id: 1, index: 0, main: true, frame: { x: 0, y: 0, width: 1512, height: 982 }, pixel_width: 3024, pixel_height: 1964, scale: 2 };
const ACTION_OPS = new Set(['screenshot', 'cursor', 'mouse_move', 'click', 'drag', 'scroll', 'type', 'key', 'open_app', 'open_url', 'list_windows', 'focus_window']);

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

const pngCache = new Map();

function makePng(width, height) {
  const key = `${width}x${height}`;
  if (!pngCache.has(key)) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x++) row.set([x & 0xff, 128, 200], 1 + x * 3);
    const raw = Buffer.alloc(row.length * height);
    for (let y = 0; y < height; y++) row.copy(raw, y * row.length);
    pngCache.set(key, Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', zlib.deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]));
  }
  return pngCache.get(key);
}

function makeJpeg(width, height) {
  return Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x0b, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x01, 0x01, 0x11, 0x00,
    0xff, 0xd9,
  ]);
}

function createFakeHelper() {
  const fake = { requests: [], authOk: true, granted: new Set(), killed: false, cursor: { x: 10, y: 10 }, failNext: {}, serves: {}, onScreenshot: null };
  const fail = (code, message) => ({ ok: false, error: { code, message } });

  function screenshot(args) {
    fake.onScreenshot?.(args);
    if (args.display_id !== MAIN.id) return fail('not_found', `No display ${args.display_id}.`);
    const jpeg = args.format === 'jpeg';
    const bytes = jpeg ? makeJpeg(args.width, args.height) : makePng(args.width, args.height);
    const result = { data: bytes.toString('base64'), mime_type: jpeg ? 'image/jpeg' : 'image/png', width: args.width, height: args.height, bytes: bytes.length };
    if (args.thumbnail) {
      const tw = Math.min(args.thumbnail.max_width, args.width);
      const th = Math.max(1, Math.round((tw * args.height) / args.width));
      result.thumbnail = { data: makeJpeg(tw, th).toString('base64'), mime_type: 'image/jpeg', width: tw, height: th };
    }
    return { ok: true, result };
  }

  function handle(req) {
    fake.requests.push({ op: req.op, agent: req.agent, args: req.args ?? {} });
    const args = req.args ?? {};
    const planned = fake.failNext[req.op];
    if (planned) {
      delete fake.failNext[req.op];
      return fail(planned.code, planned.message);
    }
    if (ACTION_OPS.has(req.op)) {
      if (fake.killed) return fail('killed', 'PC control is stopped.');
      if (!fake.granted.has(req.agent)) return fail('not_allowed', `Agent ${req.agent} is not granted.`);
    }
    switch (req.op) {
      case 'status':
        return { ok: true, result: { version: '1.0.0-fake', pid: process.pid, ...fake.serves, killed: fake.killed, state_loading: false, signature_ok: true } };
      case 'grants':
        return { ok: true, result: { ...fake.serves, agents: [...fake.granted].sort(), killed: fake.killed, state_loading: false, signature_ok: true } };
      case 'displays':
        return { ok: true, result: { displays: [MAIN] } };
      case 'kill':
        fake.killed = true;
        return { ok: true, result: { killed: true } };
      case 'unkill':
        if (!fake.authOk) return fail('auth_failed', 'Authentication failed.');
        fake.killed = false;
        return { ok: true, result: { killed: false } };
      case 'screenshot':
        return screenshot(args);
      case 'cursor':
        return { ok: true, result: { ...fake.cursor } };
      case 'mouse_move':
      case 'click':
        fake.cursor = { x: args.x, y: args.y };
        return { ok: true, result: { x: args.x, y: args.y } };
      case 'drag':
      case 'scroll':
      case 'key':
        return { ok: true, result: {} };
      case 'type':
        return { ok: true, result: { typed: args.text.length } };
      case 'open_app':
        return { ok: true, result: { pid: 4242, bundle_id: 'com.apple.Safari', name: 'Safari', path: '/Applications/Safari.app' } };
      case 'open_url':
        return { ok: true, result: { opened: true } };
      case 'focus_window':
        return { ok: true, result: { pid: 4242, app: 'Safari', title: 'Docs' } };
      default:
        return fail('unsupported', `Unknown op ${req.op}.`);
    }
  }

  fake.client = () => ({
    async request(op, args = {}, opts = {}) {
      const res = handle({ op, agent: opts.agent, args });
      if (res.ok) return res.result;
      throw mapHelperError(res.error.code, res.error.message);
    },
  });
  return fake;
}

// ---------------------------------------------------------------- fake GlowCursor

/**
 * Records every request ({at, method, url, headers, raw, json, status, repliedAt}). `token` is the accepted bridge
 * token (others get 401), `delayMs` delays the reply, `hang` never replies. Like GlowCursor, a detail.key longer than
 * 32 characters gets 400.
 */
async function startFakeGlow() {
  const glow = { requests: [], token: 'tok-A', delayMs: 0, hang: false };
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (d) => (raw += d));
    req.on('end', async () => {
      let json = null;
      try {
        json = JSON.parse(raw);
      } catch {
        // recorded as raw only
      }
      const entry = { at: performance.now(), method: req.method, url: req.url, headers: req.headers, raw, json, status: 0, repliedAt: 0 };
      glow.requests.push(entry);
      res.on('error', () => {});
      if (req.headers.authorization !== `Bearer ${glow.token}`) {
        entry.status = 401;
        res.writeHead(401, { 'Content-Type': 'application/json' }).end('{"error":"unauthorized"}');
        return;
      }
      const key = json?.detail?.key;
      if (typeof key === 'string' && [...key].length > KEY_MAX) {
        entry.status = 400;
        res.writeHead(400, { 'Content-Type': 'application/json' }).end('{"error":"invalid_detail"}');
        return;
      }
      if (glow.hang) return;
      if (glow.delayMs) await delay(glow.delayMs);
      entry.status = req.url === '/v1/action' ? 202 : 200;
      entry.repliedAt = performance.now();
      res.writeHead(entry.status, { 'Content-Type': 'application/json', Connection: 'close' }).end('{}');
    });
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  glow.port = server.address().port;
  glow.close = () =>
    new Promise((resolve) => {
      for (const s of sockets) s.destroy();
      server.close(() => resolve());
    });
  /** Accepted /v1/action bodies, in arrival order. */
  glow.actions = () => glow.requests.filter((r) => r.url === '/v1/action' && r.status !== 401).map((r) => r.json);
  glow.kills = () => glow.requests.filter((r) => r.url === '/v1/overlay/kill' && r.status !== 401).map((r) => r.json);
  glow.reset = () => (glow.requests.length = 0);
  return glow;
}

function writeGlowFiles({ port, token }) {
  if (port !== undefined) fs.writeFileSync(path.join(GLOW_HOME, 'port'), `${port}\n`);
  if (token !== undefined) fs.writeFileSync(path.join(GLOW_HOME, 'bridge.token'), `${token}\n`, { mode: 0o600 });
}

// ---------------------------------------------------------------- shared state

let ctx;
let home;
let logs;
let pc;
let fake;
let glow;
let A;
let O;
let N;
const clients = [];

async function connect(session) {
  const agent = await connectInMemory(ctx, session);
  clients.push(agent);
  return agent;
}

/** Run a tool call and wait until every GlowCursor request it caused has settled. */
async function settled(promise) {
  const r = await promise;
  await pc.glow.idle();
  return r;
}

async function timedMin(runs, fn) {
  let best = Infinity;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    const r = await fn();
    best = Math.min(best, performance.now() - t);
    assert.equal(r.isError, false, r.text);
  }
  return best;
}

before(async () => {
  ({ ctx, home, logs } = testContext('glow', { port: 0 }));
  glow = await startFakeGlow();
  writeGlowFiles({ port: glow.port, token: glow.token });
  fake = createFakeHelper();
  fake.serves = { home: fs.realpathSync(home), db: canonicalPath(ctx.config.dbPath) };
  setPcHelperClientForTests(ctx, fake.client());
  pc = getPcControl(ctx);
  pc.platform = 'darwin';
  assert.equal(pc.glow.enabled, true, 'bridge on for the temp GLOWCURSOR_HOME');
  assert.equal(pc.glow.home, path.resolve(GLOW_HOME));
  ctx.store.registerAgent({ id: 'pc-agent', name: 'PC Agent', platform: 'claude-code', instructions: 'Test agent for the GlowCursor bridge.' });
  ctx.store.registerAgent({ id: 'pc-other', name: 'Other Agent', platform: 'cursor', instructions: 'Never switched on.' });
  pc.store.setEnabled('pc-agent', true, 'human');
  fake.granted.add('pc-agent');
  A = await connect({ transport: 'http', sessionId: 'glow-A', agentId: 'pc-agent' });
  O = await connect({ transport: 'stdio', agentId: 'pc-other' });
  N = await connect({ transport: 'http', sessionId: 'glow-N' });
});

after(async () => {
  await pc?.idle();
  await pc?.glow.idle();
  for (const client of clients) await client.close();
  ctx?.close();
  await glow?.close();
  fs.rmSync(SOCKET_DIR, { recursive: true, force: true });
});

// ================================================================ pure

test('config: BRUCE_GLOW=0 switches it off; test fixtures need an explicit GLOWCURSOR_HOME that is not the real one', () => {
  const real = path.join(os.homedir(), '.glowcursor');
  assert.deepEqual(glowConfig({}), { enabled: true, home: real });
  for (const v of ['0', 'false', 'off']) assert.equal(glowConfig({ BRUCE_GLOW: v }).enabled, false, `BRUCE_GLOW=${v}`);
  assert.equal(glowConfig({ BRUCE_GLOW: '1' }).enabled, true);
  assert.equal(glowConfig({ BRUCE_TEST_FIXTURE: '1' }).enabled, false, 'fixture without GLOWCURSOR_HOME');
  assert.equal(glowConfig({ BRUCE_TEST_FIXTURE: '1', GLOWCURSOR_HOME: real }).enabled, false, 'fixture pointed at the real home');
  assert.equal(glowConfig({ BRUCE_TEST_FIXTURE: '1', GLOWCURSOR_HOME: `${real}/` }).enabled, false, 'trailing slash');
  assert.deepEqual(glowConfig({ BRUCE_TEST_FIXTURE: '1', GLOWCURSOR_HOME: GLOW_HOME }), { enabled: true, home: path.resolve(GLOW_HOME) });
  assert.equal(glowConfig({ BRUCE_TEST_FIXTURE: '1', GLOWCURSOR_HOME: GLOW_HOME, BRUCE_GLOW: '0' }).enabled, false);
  assert.equal(new GlowBridge({ env: { BRUCE_TEST_FIXTURE: '1' } }).enabled, false);
});

test('detail: only button, clicks, direction, dx/dy, key, mods and a character count; never text, URLs, apps or titles', () => {
  assert.deepEqual(glowDetail('pc_click', { x: 5, y: 6, button: 'left', clicks: 1, display: 0 }), { button: 'left', clicks: 1 });
  assert.deepEqual(glowDetail('pc_click', { x: 5, y: 6, button: 'right', clicks: 2, modifiers: ['Command', 'alt'] }), { button: 'right', clicks: 2, mods: ['cmd', 'option'] });
  assert.deepEqual(glowDetail('pc_click', { button: 'left', clicks: 1, modifiers: ['hyper'] }), { button: 'left', clicks: 1 }, 'unknown modifier: none sent');
  assert.deepEqual(glowDetail('pc_drag', { path: [{ x: 1, y: 2 }], button: 'middle' }), { button: 'middle' });
  assert.deepEqual(glowDetail('pc_scroll', { x: 1, y: 2, direction: 'down', amount: 3 }), { direction: 'down' });
  assert.deepEqual(glowDetail('pc_scroll', { direction: 'sideways', dx: 0, dy: -3 }), { dx: 0, dy: -3 });
  assert.deepEqual(glowDetail('pc_type', { text: 'my secret password' }), { chars: 18 });
  assert.deepEqual(glowDetail('pc_key', { keys: 'Cmd+Shift+T', repeat: 2 }), { key: 'cmd+shift+t', mods: ['cmd', 'shift'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'Return' }), { key: 'return' });
  assert.deepEqual(glowDetail('pc_key', { keys: 'ctrl+c' }), { key: 'control+c', mods: ['control'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'hello world secret' }), {}, 'not a key combo: nothing echoed');
  assert.deepEqual(glowDetail('pc_open_url', { url: 'https://secret.example.com/?q=1', app: 'Safari' }), {});
  assert.deepEqual(glowDetail('pc_open_app', { name: 'Secret App' }), {});
  assert.deepEqual(glowDetail('pc_focus_window', { app: 'Mail', title: 'Secret thread' }), {});
  assert.deepEqual(glowDetail('pc_type', { text: 'x', button: 'nope', clicks: 7, direction: 'in', dx: Infinity }), { chars: 1 });
  for (const bad of [null, undefined, 'text', 42, ['a']]) assert.deepEqual(glowDetail('pc_click', bad), {});
});

test('detail: pc_key names the key only for a shortcut or a named non-printing key, never a key that types a character', () => {
  // A key that types a character (a PIN or password entered key by key): nothing, or only the modifiers.
  for (const keys of ['4', 'p', 'P', '0', 'kp_5', 'semicolon', ';', 'period', 'slash', 'minus', 'plus', 'grave', 'kp_multiply']) {
    assert.deepEqual(glowDetail('pc_key', { keys }), {}, keys);
  }
  assert.deepEqual(glowDetail('pc_key', { keys: 'shift+a' }), { mods: ['shift'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'Shift+4' }), { mods: ['shift'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'shift_l+p' }), { mods: ['shift'] });
  // Shortcuts (cmd / control / option / fn): the whole combo.
  assert.deepEqual(glowDetail('pc_key', { keys: 'cmd+4' }), { key: 'cmd+4', mods: ['cmd'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'option+e' }), { key: 'option+e', mods: ['option'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'fn+f' }), { key: 'fn+f', mods: ['fn'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'Alt+Shift+P' }), { key: 'shift+option+p', mods: ['shift', 'option'] });
  // Named non-printing keys, alone or with shift, under one canonical name.
  const named = {
    Return: 'return', enter: 'enter', kp_enter: 'enter', tab: 'tab', ESC: 'escape', escape: 'escape', backspace: 'delete',
    delete: 'delete', del: 'forwarddelete', forwarddelete: 'forwarddelete', up: 'up', ArrowDown: 'down', left: 'left',
    arrowright: 'right', home: 'home', end: 'end', page_up: 'pageup', prior: 'pageup', PageDown: 'pagedown', next: 'pagedown',
    space: 'space', spacebar: 'space', f1: 'f1', F12: 'f12', f20: 'f20',
  };
  for (const [keys, key] of Object.entries(named)) assert.deepEqual(glowDetail('pc_key', { keys }), { key }, keys);
  assert.deepEqual(glowDetail('pc_key', { keys: 'shift+tab' }), { key: 'shift+tab', mods: ['shift'] });
  assert.deepEqual(glowDetail('pc_key', { keys: 'option+arrowleft' }), { key: 'option+left', mods: ['option'] });
  // Every key the helper knows: without cmd / control / option / fn only the named keys are ever sent.
  for (const name of Object.keys(KEY_CODES)) {
    for (const [prefix, mods] of [['', undefined], ['shift+', ['shift']]]) {
      const d = glowDetail('pc_key', { keys: `${prefix}${name}` });
      if (NAMED_KEYS.has(name)) assert.match(String(d.key), /^(shift\+)?[a-z0-9]+$/, `${prefix}${name}`);
      else assert.deepEqual(d, mods ? { mods } : {}, `${prefix}${name}: no key sent`);
    }
  }
});

test('detail: key labels stay within the 32 characters GlowCursor accepts; a longer combo still sends its mods', () => {
  // Exactly 32 characters: sent.
  assert.deepEqual(glowDetail('pc_key', { keys: 'fn+ctrl+alt+shift+cmd+home' }), { key: 'cmd+shift+option+control+fn+home', mods: ALL_MODS });
  // The "hyper" window-manager combo fits with the canonical arrow name (30 characters).
  assert.deepEqual(glowDetail('pc_key', { keys: 'ctrl+option+cmd+shift+arrowright' }), { key: 'cmd+shift+option+control+right', mods: HYPER });
  // 33+ characters: no label, the mods only (the cursor still shows the modifier keycap).
  assert.deepEqual(glowDetail('pc_key', { keys: 'ctrl+option+cmd+shift+pagedown' }), { mods: HYPER });
  assert.deepEqual(glowDetail('pc_key', { keys: 'ctrl+option+cmd+shift+forwarddelete' }), { mods: HYPER });
  assert.deepEqual(glowDetail('pc_key', { keys: 'cmd+shift+option+control+fn+escape' }), { mods: ALL_MODS });
  assert.deepEqual(glowDetail('pc_key', { keys: 'ctrl+option+cmd+shift+kp_multiply' }), { mods: HYPER });
  for (const name of Object.keys(KEY_CODES)) {
    for (const mods of [['cmd'], HYPER, ALL_MODS]) {
      const d = glowDetail('pc_key', { keys: [...mods, name].join('+') });
      assert.deepEqual(d.mods, mods, `${name}: mods always sent`);
      if (d.key !== undefined) assert.ok(d.key.length <= KEY_MAX, `${d.key}: ${d.key.length} characters`);
    }
  }
});

// ================================================================ calls

test('begin and end: one call id per call, begin first, headers for 127.0.0.1 with the bridge token and no Origin', async () => {
  glow.reset();
  let r = await settled(A.call('pc_click', { x: 10, y: 10 }));
  assert.equal(r.isError, false, r.text);
  assert.equal(glow.requests.length, 2);
  const [begin, end] = glow.requests;
  for (const req of [begin, end]) {
    assert.equal(req.method, 'PUT');
    assert.equal(req.url, '/v1/action');
    assert.equal(req.headers.host, `127.0.0.1:${glow.port}`);
    assert.equal(req.headers['content-type'], 'application/json');
    assert.equal(req.headers.authorization, 'Bearer tok-A');
    assert.equal(req.headers.origin, undefined);
    assert.equal(req.headers['sec-fetch-site'], undefined);
    assert.ok(Buffer.byteLength(req.raw) < 4096, 'body under the 4 KB limit');
  }
  assert.ok(begin.at <= end.at);
  assert.match(begin.json.call_id, UUID);
  assert.deepEqual(begin.json, {
    phase: 'begin',
    call_id: begin.json.call_id,
    tool: 'pc_click',
    agent: 'pc-agent',
    detail: { button: 'left', clicks: 1 },
    sync: false,
    ttl_ms: 15000,
  });
  assert.deepEqual(end.json, {
    phase: 'end',
    call_id: begin.json.call_id,
    tool: 'pc_click',
    agent: 'pc-agent',
    detail: { button: 'left', clicks: 1 },
    ok: true,
    outcome: 'ok',
    sync: false,
  });

  r = await settled(A.call('pc_cursor_position'));
  assert.equal(r.isError, false, r.text);
  const [b2, e2] = glow.actions().slice(2);
  assert.deepEqual([b2.phase, e2.phase, b2.tool, e2.tool], ['begin', 'end', 'pc_cursor_position', 'pc_cursor_position']);
  assert.equal(b2.call_id, e2.call_id);
  assert.notEqual(b2.call_id, begin.json.call_id, 'a new call id per call');
  assert.deepEqual(b2.detail, {});
  // pc_status is not an action: nothing is sent.
  glow.reset();
  await settled(A.call('pc_status'));
  assert.equal(glow.requests.length, 0);
});

test('detail through the tools: right / double click, type (count only), key, scroll; no text, URL, app or title leaks', async () => {
  glow.reset();
  const calls = [
    ['pc_click', { x: 20, y: 20, button: 'right' }, { button: 'right', clicks: 1 }],
    ['pc_click', { x: 20, y: 20, clicks: 2, modifiers: ['cmd'] }, { button: 'left', clicks: 2, mods: ['cmd'] }],
    ['pc_type', { text: 'TOP-SECRET typed words' }, { chars: 22 }],
    ['pc_key', { keys: 'cmd+c' }, { key: 'cmd+c', mods: ['cmd'] }],
    ['pc_scroll', { x: 30, y: 30, direction: 'up', amount: 5 }, { direction: 'up' }],
    ['pc_drag', { path: [{ x: 1, y: 1 }, { x: 50, y: 50 }] }, { button: 'left' }],
    ['pc_open_url', { url: 'https://hidden.example.org/private?q=TOP-SECRET', app: 'HiddenBrowser' }, {}],
    ['pc_open_app', { name: 'HiddenApp' }, {}],
    ['pc_focus_window', { app: 'HiddenApp', title: 'Hidden title' }, {}],
  ];
  for (const [tool, args, detail] of calls) {
    glow.reset();
    const r = await settled(A.call(tool, args));
    assert.equal(r.isError, false, `${tool}: ${r.text}`);
    const [begin, end] = glow.actions();
    assert.deepEqual([begin.phase, end.phase, begin.tool, begin.call_id], ['begin', 'end', tool, end.call_id], tool);
    assert.deepEqual(begin.detail, detail, `${tool} begin detail`);
    assert.deepEqual(end.detail, detail, `${tool} end detail`);
    for (const req of glow.requests) {
      for (const secret of ['TOP-SECRET', 'hidden.example', 'https://', 'HiddenBrowser', 'HiddenApp', 'Hidden title', 'Safari', 'Docs']) {
        assert.ok(!req.raw.includes(secret), `${tool}: "${secret}" must not be sent`);
      }
      assert.deepEqual(Object.keys(req.json).filter((k) => !['phase', 'call_id', 'tool', 'agent', 'detail', 'sync', 'ttl_ms', 'ok', 'outcome', 'error_code'].includes(k)), []);
    }
  }
});

test('pc_key through the tools: typed characters never sent, long combos accepted with their mods', async () => {
  const calls = [
    ['4', {}],
    ['p', {}],
    ['shift+a', { mods: ['shift'] }],
    ['tab', { key: 'tab' }],
    ['cmd+v', { key: 'cmd+v', mods: ['cmd'] }],
    ['ctrl+option+cmd+shift+arrowright', { key: 'cmd+shift+option+control+right', mods: HYPER }],
    ['ctrl+option+cmd+shift+pagedown', { mods: HYPER }],
    ['fn+ctrl+alt+shift+cmd+forwarddelete', { mods: ALL_MODS }],
  ];
  for (const [keys, detail] of calls) {
    glow.reset();
    const r = await settled(A.call('pc_key', { keys }));
    assert.equal(r.isError, false, `${keys}: ${r.text}`);
    const [begin, end] = glow.actions();
    assert.deepEqual([begin.phase, end.phase, begin.call_id], ['begin', 'end', end.call_id], keys);
    assert.deepEqual(begin.detail, detail, `${keys} begin detail`);
    assert.deepEqual(end.detail, detail, `${keys} end detail`);
    assert.deepEqual(glow.requests.map((q) => q.status), [202, 202], `${keys}: both accepted (no 400)`);
  }
  // A PIN entered key by key: no request carries a key.
  glow.reset();
  for (const keys of ['7', '3', '9', '1']) assert.equal((await settled(A.call('pc_key', { keys }))).isError, false);
  assert.equal(glow.requests.length, 8);
  for (const req of glow.requests) {
    assert.deepEqual(req.json.detail, {});
    assert.ok(!req.raw.includes('"key"'), 'no key field');
  }
});

test('refused before it began: a single end (ok false, refused) with the configured agent or "unknown"', async () => {
  glow.reset();
  let r = await settled(O.call('pc_click', { x: 5, y: 5, button: 'right' }));
  assert.match(r.text, /^Error \[pc_not_allowed\]/);
  assert.equal(glow.requests.length, 1);
  let [end] = glow.actions();
  assert.match(end.call_id, UUID);
  assert.deepEqual({ ...end, call_id: 'x' }, {
    phase: 'end',
    call_id: 'x',
    tool: 'pc_click',
    agent: 'pc-other',
    ok: false,
    outcome: 'refused',
    error_code: 'pc_not_allowed',
    detail: { button: 'right', clicks: 1 },
    sync: false,
  });

  glow.reset();
  r = await settled(N.call('pc_type', { text: 'never shown' }));
  assert.match(r.text, /^Error \[pc_control_refused\]/);
  [end] = glow.actions();
  assert.deepEqual([glow.requests.length, end.phase, end.agent, end.outcome, end.error_code, end.detail], [1, 'end', 'unknown', 'refused', 'pc_control_refused', { chars: 11 }]);
  assert.ok(!glow.requests[0].raw.includes('never shown'));
});

test('failed calls end with outcome error / refused and the error code', async () => {
  glow.reset();
  fake.failNext.click = { code: 'not_found', message: 'gone' };
  let r = await settled(A.call('pc_click', { x: 5, y: 5 }));
  assert.match(r.text, /^Error \[not_found\]/);
  let [begin, end] = glow.actions();
  assert.equal(begin.phase, 'begin');
  assert.deepEqual([end.phase, end.call_id, end.ok, end.outcome, end.error_code], ['end', begin.call_id, false, 'error', 'not_found']);

  glow.reset();
  r = await settled(A.call('pc_key', { keys: 'hello world secret' }));
  assert.match(r.text, /^Error \[invalid_argument\]/);
  [begin, end] = glow.actions();
  assert.deepEqual([begin.detail, end.outcome, end.error_code], [{}, 'error', 'invalid_argument']);
  for (const req of glow.requests) assert.ok(!req.raw.includes('secret'), 'a bad key combo is never echoed');

  glow.reset();
  fake.failNext.click = { code: 'killed', message: 'stopped' };
  r = await settled(A.call('pc_click', { x: 5, y: 5 }));
  assert.match(r.text, /^Error \[pc_killed\]/);
  [, end] = glow.actions();
  assert.deepEqual([end.ok, end.outcome, end.error_code], [false, 'refused', 'pc_killed']);
});

test('pc_screenshot / pc_zoom: sync begin is awaited before the capture, but never longer than ~30 ms', async (t) => {
  await pc.idle(); // no background thumbnail captures pending
  glow.reset();
  // A cursor that answers within the cap: the capture starts only after the reply.
  glow.delayMs = 15;
  let shotAt = 0;
  fake.onScreenshot = () => (shotAt ||= performance.now());
  let r = await settled(A.call('pc_screenshot'));
  fake.onScreenshot = null;
  assert.equal(r.isError, false, r.text);
  let [begin, end] = glow.requests;
  assert.deepEqual([begin.json.phase, begin.json.sync, end.json.phase, end.json.sync], ['begin', true, 'end', false]);
  assert.ok(begin.repliedAt > 0 && shotAt >= begin.repliedAt, `capture (${shotAt}) after the duck reply (${begin.repliedAt})`);

  glow.reset();
  r = await settled(A.call('pc_zoom', { x: 10, y: 10, width: 100, height: 100 }));
  assert.equal(r.isError, false, r.text);
  assert.deepEqual([glow.actions()[0].tool, glow.actions()[0].sync], ['pc_zoom', true]);

  // A slow cursor (200 ms) delays the screenshot by the 30 ms cap at most.
  glow.delayMs = 0;
  const fast = await timedMin(3, () => A.call('pc_screenshot'));
  await pc.glow.idle();
  glow.delayMs = 200;
  const slow = await timedMin(3, () => A.call('pc_screenshot'));
  await pc.glow.idle();
  glow.delayMs = 0;
  t.diagnostic(`screenshot: ${fast.toFixed(1)} ms with a fast cursor, ${slow.toFixed(1)} ms with a 200 ms cursor`);
  assert.ok(slow - fast <= 50, `slow cursor added ${(slow - fast).toFixed(1)} ms (fast ${fast.toFixed(1)}, slow ${slow.toFixed(1)})`);
  // Each end still follows its own begin, even when the begin timed out (calls may interleave).
  const byCall = new Map();
  for (const a of glow.actions()) byCall.set(a.call_id, [...(byCall.get(a.call_id) ?? []), a.phase]);
  assert.equal(byCall.size, 7);
  for (const phases of byCall.values()) assert.deepEqual(phases, ['begin', 'end']);
  await pc.idle();
});

test('cursor down or hanging: tool latency is unaffected; a moved port is found again', async (tc) => {
  const baseline = await timedMin(3, () => A.call('pc_mouse_move', { x: 40, y: 40 }));
  await pc.glow.idle();

  // Hanging: accepts, never answers. Fire-and-forget calls do not wait; the screenshot waits the 30 ms cap at most.
  glow.hang = true;
  const hanging = await timedMin(3, () => A.call('pc_mouse_move', { x: 41, y: 41 }));
  assert.ok(hanging - baseline <= 25, `hanging cursor added ${(hanging - baseline).toFixed(1)} ms`);
  const t = performance.now();
  assert.equal((await A.call('pc_screenshot')).isError, false);
  const shot = performance.now() - t;
  await pc.glow.idle();
  glow.hang = false;
  assert.ok(shot < 1000, `screenshot took ${shot.toFixed(1)} ms`);

  // Down: nothing listens on the port.
  const oldPort = glow.port;
  await glow.close();
  const down = await timedMin(3, () => A.call('pc_mouse_move', { x: 42, y: 42 }));
  tc.diagnostic(`pc_mouse_move: ${baseline.toFixed(1)} ms baseline, ${hanging.toFixed(1)} ms hanging, ${down.toFixed(1)} ms down; screenshot hanging ${shot.toFixed(1)} ms`);
  assert.ok(down - baseline <= 25, `cursor down added ${(down - baseline).toFixed(1)} ms`);
  const t2 = performance.now();
  assert.equal((await A.call('pc_screenshot')).isError, false);
  await pc.glow.idle();
  assert.ok(performance.now() - t2 < 1000);

  // GlowCursor comes back on another port: the refused connection re-reads the port file and resends.
  const token = glow.token;
  glow = await startFakeGlow();
  glow.token = token;
  assert.notEqual(glow.port, oldPort);
  writeGlowFiles({ port: glow.port });
  const r = await settled(A.call('pc_click', { x: 7, y: 7 }));
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(glow.actions().map((a) => a.phase), ['begin', 'end']);
  await pc.idle();
});

test('401: the bridge token is re-read once and the request resent; an unchanged token is not retried', async () => {
  glow.reset();
  glow.token = 'tok-B';
  writeGlowFiles({ token: 'tok-B' });
  let r = await settled(A.call('pc_click', { x: 8, y: 8 }));
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(
    glow.requests.map((q) => [q.json.phase, q.headers.authorization, q.status]),
    [
      ['begin', 'Bearer tok-A', 401],
      ['begin', 'Bearer tok-B', 202],
      ['end', 'Bearer tok-B', 202],
    ],
  );
  assert.equal(glow.requests[0].json.call_id, glow.requests[1].json.call_id, 'the same begin is resent');

  // Wrong token and the file still has the old one: one 401 per request, no retry loop.
  glow.reset();
  glow.token = 'tok-C';
  r = await settled(A.call('pc_click', { x: 8, y: 8 }));
  assert.equal(r.isError, false, r.text);
  assert.deepEqual(glow.requests.map((q) => [q.json.phase, q.status]), [['begin', 401], ['end', 401]]);

  glow.reset();
  writeGlowFiles({ token: 'tok-C' });
  r = await settled(A.call('pc_click', { x: 8, y: 8 }));
  assert.deepEqual(glow.requests.map((q) => [q.json.phase, q.status]), [['begin', 401], ['begin', 202], ['end', 202]]);
  await pc.idle();
});

// ================================================================ kill switch

test('setKilled pushes /v1/overlay/kill (engage and release); refused calls then carry pc_killed', async () => {
  glow.reset();
  let res = await pc.setKilled(true, 'human');
  assert.equal(res.killed, true);
  // Awaited inside setKilled: already there.
  assert.deepEqual(glow.kills(), [{ engaged: true, by: 'human', ttl_ms: GLOW_KILL_TTL_MS }]);
  const kill = glow.requests[0];
  assert.deepEqual([kill.method, kill.headers.host, kill.headers['content-type'], kill.headers.origin], ['PUT', `127.0.0.1:${glow.port}`, 'application/json', undefined]);

  glow.reset();
  const r = await settled(A.call('pc_click', { x: 3, y: 3 }));
  assert.match(r.text, /^Error \[pc_killed\]/);
  assert.deepEqual(glow.actions().map((a) => [a.phase, a.outcome, a.error_code, a.agent]), [['end', 'refused', 'pc_killed', 'pc-agent']]);

  glow.reset();
  fake.authOk = false;
  await assert.rejects(pc.setKilled(false, 'human'));
  assert.deepEqual(glow.kills(), [], 'a failed release pushes nothing');
  fake.authOk = true;
  res = await pc.setKilled(false, 'human');
  assert.equal(res.killed, false);
  assert.deepEqual(glow.kills(), [{ engaged: false, by: 'human', ttl_ms: GLOW_KILL_TTL_MS }]);
});

test('serve daemon: a database-only stop (hotkey / CLI) reaches the cursor within ~500 ms; close() stops the sync', async () => {
  glow.reset();
  const srv = await startHttp(ctx);
  try {
    // First tick pushes the current state.
    await waitFor(() => glow.kills().length >= 1, { timeout: 2000, label: 'initial kill state' });
    assert.deepEqual(glow.kills()[0], { engaged: false, by: 'human', ttl_ms: GLOW_KILL_TTL_MS });
    glow.reset();
    await delay(400);
    assert.deepEqual(glow.kills(), [], 'no push while nothing changes');

    const t = performance.now();
    pc.store.setKilled(true, 'hotkey');
    await waitFor(() => glow.kills().length >= 1, { timeout: 2000, interval: 10, label: 'kill push' });
    const took = performance.now() - t;
    assert.ok(took <= 500, `detected after ${took.toFixed(0)} ms`);
    assert.deepEqual(glow.kills(), [{ engaged: true, by: 'hotkey', ttl_ms: GLOW_KILL_TTL_MS }]);

    glow.reset();
    pc.store.setKilled(false, 'human');
    await waitFor(() => glow.kills().length >= 1, { timeout: 2000, interval: 10, label: 'release push' });
    assert.deepEqual(glow.kills(), [{ engaged: false, by: 'human', ttl_ms: GLOW_KILL_TTL_MS }]);
  } finally {
    await srv.close();
  }
  glow.reset();
  pc.store.setKilled(true, 'hotkey');
  await delay(600);
  assert.deepEqual(glow.kills(), [], 'no sync after close()');
  pc.store.setKilled(false, 'human');
});

test('kill sync re-pushes while engaged (10 s in production) and stops when released', async () => {
  glow.reset();
  pc.store.setKilled(true, 'hotkey');
  const stop = pc.startGlowKillSync({ intervalMs: 50, repushMs: 300 });
  try {
    await delay(1100);
    const pushes = glow.kills();
    assert.ok(pushes.length >= 3 && pushes.length <= 5, `${pushes.length} pushes in 1.1 s with a 300 ms re-push`);
    for (const p of pushes) assert.deepEqual(p, { engaged: true, by: 'hotkey', ttl_ms: GLOW_KILL_TTL_MS });
    glow.reset();
    pc.store.setKilled(false, 'human');
    await waitFor(() => glow.kills().length >= 1, { timeout: 1000, label: 'release' });
    await delay(700);
    assert.deepEqual(glow.kills(), [{ engaged: false, by: 'human', ttl_ms: GLOW_KILL_TTL_MS }], 'no re-push while released');
  } finally {
    stop();
  }
});

test('CLI: pc-control stop pushes the kill before the process exits', async () => {
  glow.reset();
  const r = await runCli(['pc-control', 'stop', '--json'], { env: { BRUCE_COMM_HOME: home } });
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).killed, true);
  assert.deepEqual(glow.kills(), [{ engaged: true, by: 'cli', ttl_ms: GLOW_KILL_TTL_MS }]);
  pc.store.setKilled(false, 'human');
});

// ================================================================ off

test('BRUCE_GLOW=0: no request at all (calls, refusals, kill pushes, kill sync)', async () => {
  const original = pc.glow;
  pc.glow = new GlowBridge({ env: { ...process.env, BRUCE_GLOW: '0' } });
  assert.equal(pc.glow.enabled, false);
  glow.reset();
  try {
    assert.equal((await A.call('pc_click', { x: 9, y: 9 })).isError, false);
    assert.match((await O.call('pc_click', { x: 9, y: 9 })).text, /pc_not_allowed/);
    assert.equal((await A.call('pc_screenshot')).isError, false);
    await pc.setKilled(true, 'human');
    const stop = pc.startGlowKillSync({ intervalMs: 20, repushMs: 50 });
    await delay(200);
    stop();
    await pc.setKilled(false, 'human');
    process.env.BRUCE_GLOW = '0';
    const stop2 = startPcGlowKillSync(ctx);
    pc.store.setKilled(true, 'hotkey');
    await delay(400);
    stop2();
    pc.store.setKilled(false, 'human');
  } finally {
    delete process.env.BRUCE_GLOW;
    pc.glow = original;
  }
  await pc.idle();
  assert.deepEqual(glow.requests, []);
});

test('failures are logged once per process, never per call', () => {
  const lines = logs.filter((l) => l.startsWith('glowcursor bridge:'));
  assert.equal(lines.length, 1, lines.join('\n'));
  assert.match(lines[0], /later failures are not logged/);
});

test('the bridge never points at the real ~/.glowcursor in tests', () => {
  assert.notEqual(pc.glow.home, path.join(os.homedir(), '.glowcursor'));
  assert.notEqual(glow.port, 47800);
});

// ================================================================ stdio children

test('connectStdio children have the bridge off (BRUCE_TEST_FIXTURE=1, BRUCE_GLOW=0): ~/.glowcursor is never used', async () => {
  // A fake user home whose ~/.glowcursor points at the fake cursor: the "real" home as the child sees it.
  const userHome = tempDir('glow-user');
  const userGlow = path.join(userHome, '.glowcursor');
  fs.mkdirSync(userGlow);
  fs.writeFileSync(path.join(userGlow, 'port'), `${glow.port}\n`);
  fs.writeFileSync(path.join(userGlow, 'bridge.token'), `${glow.token}\n`, { mode: 0o600 });
  const helperEnv = {
    BRUCE_PC_HELPER_NO_LAUNCH: '1',
    BRUCE_PC_HELPER_APP: process.env.BRUCE_PC_HELPER_APP,
    BRUCE_PC_HELPER_SOCKET: process.env.BRUCE_PC_HELPER_SOCKET,
  };
  /** A refused pc_click in a `bruce-comm stdio` child; resolves with the requests the fake cursor got. */
  const refusedClick = async (env, waitMs) => {
    const child = await connectStdio({ home: tempDir('glow-stdio'), name: 'glow-stdio', env: { ...helperEnv, ...env } });
    try {
      glow.reset();
      const r = await child.call('pc_click', { x: 1, y: 1, button: 'right' });
      assert.match(r.text, /^Error \[pc_control_refused\]/);
      if (waitMs) await delay(waitMs);
      else await waitFor(() => glow.requests.length >= 1, { timeout: 3000, label: 'refused end from the child' });
      return [...glow.requests];
    } finally {
      await child.close();
    }
  };

  // Control: pointed explicitly at the fake cursor's home (not the child's ~/.glowcursor) and switched on, the child
  // does send its refused end.
  const sent = await refusedClick({ GLOWCURSOR_HOME: userGlow, BRUCE_GLOW: '1' }, 0);
  assert.deepEqual(sent.map((q) => [q.url, q.status, q.json.phase, q.json.tool, q.json.agent, q.json.outcome, q.json.error_code]), [
    ['/v1/action', 202, 'end', 'pc_click', 'unknown', 'refused', 'pc_control_refused'],
  ]);
  assert.deepEqual(sent[0].json.detail, { button: 'right', clicks: 1 });

  // connectStdio defaults: ~/.glowcursor (here the fake one) is never reached.
  assert.deepEqual(await refusedClick({ HOME: userHome }, 500), [], 'no request from a stdio child');
});
