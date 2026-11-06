// Shared helpers for the Bruce Comm test suite. Tests import the BUILT code (../dist); `npm test` builds first.
//
// Isolation: importing this module points every Bruce Comm default at a throwaway directory (BRUCE_COMM_HOME,
// BRUCE_COMM_CLIENT_CONFIG_DIR) and an unused port (BRUCE_COMM_PORT), and drops variables that would change behaviour
// (token, db path, wait cap, pre-bound identity). Tests never touch the real ~/.bruce-comm or real client configs.
//
// `node --test "test/**/*.{js,mjs,cjs}"` also executes this file and test/fixtures/* as stand-alone "test files":
// this module has no side effects beyond creating (and removing) its temp directory, and the fixtures exit at once
// unless BRUCE_TEST_FIXTURE=1 (set below, so only processes started by a test run them).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createContext } from '../dist/context.js';
import { createBruceServer } from '../dist/mcp/server.js';
import { startHttpServer } from '../dist/transports/http.js';

// ---------------------------------------------------------------- paths & environment

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const BIN = path.join(ROOT, 'bin', 'bruce-comm.js');
export const FIXTURES = path.join(ROOT, 'test', 'fixtures');
export const IS_WINDOWS = process.platform === 'win32';

/** Absolute path of a fake agent script in test/fixtures. */
export function fixture(name) {
  return path.join(FIXTURES, name);
}

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'bruce-comm-test-'));
process.on('exit', () => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
  } catch {
    // a child process may still hold a file on Windows; the OS temp cleaner gets it later
  }
});

for (const key of ['BRUCE_COMM_TOKEN', 'BRUCE_COMM_DB', 'BRUCE_COMM_HOST', 'BRUCE_COMM_MAX_WAIT_SECONDS', 'BRUCE_AGENT_ID', 'BRUCE_COMM_DEBUG']) {
  delete process.env[key];
}
process.env.BRUCE_COMM_HOME = path.join(BASE, 'default-home');
process.env.BRUCE_COMM_CLIENT_CONFIG_DIR = path.join(BASE, 'client-configs');
process.env.BRUCE_TEST_FIXTURE = '1';

/** A port nothing listens on (the CLI probes the configured port for a daemon; it must never find the user's). */
export const UNUSED_PORT = await freePort();
process.env.BRUCE_COMM_PORT = String(UNUSED_PORT);

/** A fresh empty directory inside this process's temp base. */
export function tempDir(prefix = 'dir') {
  return fs.mkdtempSync(path.join(BASE, `${prefix}-`));
}

/**
 * A Bruce Comm context on a fresh temp home. Diagnostics are captured in `logs` (set BRUCE_TEST_VERBOSE=1 to also
 * print them). `overrides` go to createContext (e.g. {port: 0} or {token}).
 */
export function testContext(prefix = 'home', overrides = {}) {
  const home = tempDir(prefix);
  const ctx = createContext({ home, ...overrides }, { quiet: true });
  const logs = [];
  ctx.log = (message) => {
    logs.push(message);
    if (process.env.BRUCE_TEST_VERBOSE) process.stderr.write(`    [log] ${message}\n`);
  };
  return { ctx, home, logs };
}

// ---------------------------------------------------------------- timing

export const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Poll `check` until it returns a truthy value (returned) or `timeout` ms pass (throws, naming `label`).
 * Use instead of fixed sleeps.
 */
export async function waitFor(check, { timeout = 5000, interval = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${label}`);
    await delay(interval);
  }
}

/** Resolve with the promise's value, or reject when it takes longer than `ms`. */
export function within(promise, ms, label = 'operation') {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
    }),
  ]);
}

// ---------------------------------------------------------------- processes & ports

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Whether a process id is running. */
export function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

/** Kill a process and its children right away (taskkill /T /F on Windows). */
export function killTree(pid) {
  if (!pid || !alive(pid)) return;
  if (IS_WINDOWS) spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true });
  else {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

/** The PID of a process that has certainly exited. */
export function deadPid() {
  return spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
}

/**
 * Run the real CLI (`node bin/bruce-comm.js ...args`) asynchronously - an in-process daemon keeps serving meanwhile.
 * Resolves {code, stdout, stderr}. `env` is merged over this (sanitised) process environment.
 */
export function runCli(args, { env = {}, cwd, input = '', timeout = 30_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      killTree(child.pid);
      reject(new Error(`bruce-comm ${args.join(' ')} did not exit within ${timeout} ms\n${stdout}\n${stderr}`));
    }, timeout);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

// ---------------------------------------------------------------- MCP clients

/** Parse a Bruce Comm tool result: headline line, last line, JSON payload (the last pretty-printed object). */
export function parseResult(res) {
  const text = (res.content ?? []).map((c) => c.text ?? '').join('\n');
  const lines = text.split('\n');
  let payload = {};
  if (!res.isError) {
    const start = lines.lastIndexOf('{');
    const end = start < 0 ? -1 : lines.indexOf('}', start);
    if (start >= 0 && end > start) payload = JSON.parse(lines.slice(start, end + 1).join('\n'));
  }
  return { text, isError: res.isError === true, payload, headline: lines[0], last: lines[lines.length - 1] };
}

/** A connected SDK client with a `call(tool, args, requestOptions)` shortcut returning parseResult(). */
class McpAgent {
  constructor(client, extra = {}) {
    this.client = client;
    Object.assign(this, extra);
  }

  async call(name, args = {}, options) {
    return parseResult(await this.client.callTool({ name, arguments: args }, undefined, options));
  }

  close() {
    return this.client.close().catch(() => {});
  }
}

/**
 * Connect an SDK client to a fresh createBruceServer() over InMemoryTransport.
 * `roots`: root URIs the client reports (declares the roots capability) - `rootsState.handler(n)` overrides answers.
 */
export async function connectInMemory(ctx, session, { name = 'test-client', version = '1.0.0', roots = null } = {}) {
  const server = createBruceServer(ctx, session);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const { client, rootsState, errors } = makeClient(name, version, roots);
  await client.connect(clientTransport);
  return new McpAgent(client, { server, session, rootsState, errors, sid: () => session.bruceSessionId });
}

/**
 * An SDK client; with `roots` it declares the roots capability and answers roots/list from `rootsState.roots`
 * (or `rootsState.handler(callNumber)` when set, to simulate failures).
 */
function makeClient(name, version, roots) {
  const client = new Client({ name, version }, { capabilities: roots ? { roots: { listChanged: true } } : {} });
  const errors = [];
  client.onerror = (err) => errors.push(err.message);
  const rootsState = { roots: roots ?? [], calls: 0, handler: null };
  if (roots) {
    client.setRequestHandler(ListRootsRequestSchema, async () => {
      rootsState.calls++;
      if (rootsState.handler) return rootsState.handler(rootsState.calls);
      return { roots: rootsState.roots.map((uri) => ({ uri })) };
    });
  }
  return { client, rootsState, errors };
}

/** Connect an SDK client over Streamable HTTP (`roots`: see makeClient). */
export async function connectHttp(url, { name = 'http-client', version = '1.0.0', headers, roots = null } = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url), headers ? { requestInit: { headers } } : undefined);
  const { client, rootsState, errors } = makeClient(name, version, roots);
  await client.connect(transport);
  return new McpAgent(client, { transport, rootsState, errors });
}

/** Spawn `bruce-comm stdio` (the real bin) on `home` and connect an SDK client to it (`roots`: see makeClient). */
export async function connectStdio({ home, agentId, name = 'stdio-client', env = {}, roots = null } = {}) {
  const args = [BIN, 'stdio'];
  if (agentId) args.push('--agent-id', agentId);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { BRUCE_COMM_HOME: home, BRUCE_COMM_PORT: String(UNUSED_PORT), BRUCE_TEST_FIXTURE: '1', BRUCE_GLOW: '0', ...env },
    stderr: 'pipe',
  });
  let stderr = '';
  transport.stderr?.on('data', (d) => (stderr += d));
  const { client, rootsState, errors } = makeClient(name, '1.0.0', roots);
  await client.connect(transport);
  return new McpAgent(client, { transport, rootsState, errors, pid: transport.pid, stderr: () => stderr });
}

// ---------------------------------------------------------------- HTTP

/** Start the HTTP daemon in-process on a free port (ctx must have been created with port 0). */
export function startHttp(ctx, tuning) {
  return startHttpServer(ctx, tuning);
}

/** Raw node:http request (fetch would rewrite Host, which the security tests set on purpose). */
export function raw(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (data += chunk));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {
          // not JSON
        }
        resolve({ status: res.statusCode, headers: res.headers, body: data, json });
      });
    });
    req.on('error', reject);
    if (body === undefined) req.end();
    else req.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
  });
}

/** JSON REST call (same-origin style: no Origin header). */
export function rest(port, method, p, body, headers = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  return raw(port, { method, path: p, headers: h, body });
}

/** Open an SSE stream. Returns {status, headers, events, waitFor(predicate, ms), close()}. */
export function openSse(port, p = '/api/events', headers = {}) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    let buffer = '';
    const req = http.request(
      { host: '127.0.0.1', port, path: p, headers: { Host: `127.0.0.1:${port}`, Accept: 'text/event-stream', ...headers } },
      (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          buffer += chunk;
          let index;
          while ((index = buffer.indexOf('\n\n')) >= 0) {
            const block = buffer.slice(0, index);
            buffer = buffer.slice(index + 2);
            const event = { event: 'message', data: '', comment: null, retry: undefined };
            for (const line of block.split('\n')) {
              if (line.startsWith(':')) event.comment = line.slice(1).trim();
              else if (line.startsWith('event:')) event.event = line.slice(6).trim();
              else if (line.startsWith('data:')) event.data += line.slice(5).trim();
              else if (line.startsWith('retry:')) event.retry = Number(line.slice(6));
            }
            events.push(event);
            for (const waiter of [...waiters]) {
              if (waiter.predicate(event)) {
                waiters.splice(waiters.indexOf(waiter), 1);
                waiter.resolve(event);
              }
            }
          }
        });
        resolve({
          status: res.statusCode,
          headers: res.headers,
          events,
          close: () => req.destroy(),
          waitFor: (predicate, ms = 3000) =>
            new Promise((resolveWait, rejectWait) => {
              const found = events.find(predicate);
              if (found) return resolveWait(found);
              const waiter = {
                predicate,
                resolve: (event) => {
                  clearTimeout(timer);
                  resolveWait(event);
                },
              };
              const timer = setTimeout(() => {
                waiters.splice(waiters.indexOf(waiter), 1);
                rejectWait(new Error('SSE event did not arrive in time'));
              }, ms);
              waiters.push(waiter);
            }),
        });
      },
    );
    req.on('error', (err) => {
      if (err.code !== 'ECONNRESET') reject(err);
    });
    req.end();
  });
}

// ---------------------------------------------------------------- runner

/** A runners.json entry for a fake agent (preset "custom": node <fixture> ...argsTail). */
export function customRunner(id, script, { argsTail = [], ...extra } = {}) {
  return {
    agent: { id, name: `Fake ${id}`, instructions: 'Test agent started by the Bruce Comm test suite.' },
    preset: 'custom',
    command: process.execPath,
    args: [fixture(script), ...argsTail],
    ...extra,
  };
}

/** Write a runners.json with these entries into `home` and return its path. */
export function writeRunnerConfig(home, runners) {
  const file = path.join(home, 'runners.json');
  fs.writeFileSync(file, JSON.stringify({ runners }, null, 2));
  return file;
}
