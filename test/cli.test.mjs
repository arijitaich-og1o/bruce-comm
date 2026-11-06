// CLI through the real launcher (`node bin/bruce-comm.js ...`) on temp homes and a temp client-config directory:
// send / tasks / task / status / agents / agent, sessions, send --session / --workspace, close-session (database
// only, and through a daemon that disconnects the live MCP connection), human actions, errors, config (generated
// commands), install, and `stdio --runner-task`.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createContext } from '../dist/context.js';
import { BIN, connectHttp, freePort, killTree, raw, runCli, startHttp, tempDir, testContext, UNUSED_PORT, waitFor, within } from './helpers.mjs';

/** A seeded home plus a `cli(args, options)` runner bound to it. */
function setup(t, prefix) {
  const env = testContext(prefix);
  t.after(() => env.ctx.close());
  const clientDir = path.join(env.home, 'client-configs');
  const cli = (args, options = {}) =>
    runCli(args, { ...options, env: { BRUCE_COMM_HOME: env.home, BRUCE_COMM_CLIENT_CONFIG_DIR: clientDir, ...(options.env ?? {}) } });
  return { ...env, cli, clientDir };
}

function seedAgents(store) {
  store.registerAgent({ id: 'coder', name: 'Coder', platform: 'vscode-copilot', instructions: 'Send code tasks.', skills: [{ id: 'code', name: 'Coding' }] });
  store.registerAgent({ id: 'guarded', name: 'Guarded', platform: 'claude-desktop', instructions: 'Ask first.', require_approval: true });
  store.registerAgent({ id: 'helper', name: 'Helper', platform: 'cursor', instructions: 'Helps.' });
}

const TASK_ID = /T-[0-9A-Z]{10}/;

test('send / tasks / task / status / agents / agent, as text and as --json', async (t) => {
  const { ctx, cli } = setup(t, 'cli-basic');
  seedAgents(ctx.store);
  let r = await cli(['send', '--to', 'coder', '--title', 'Refactor "parser" & tests', '--body', 'Line 1\nLine 2 %PATH% ^!', '--priority', '7', '--input', '{"files":["a.ts"]}']);
  assert.equal(r.code, 0, r.stderr);
  const id = TASK_ID.exec(r.stdout)[0];
  const sent = ctx.store.requireTask(id);
  assert.deepEqual([sent.from_agent, sent.priority, sent.body, sent.input], ['human', 7, 'Line 1\nLine 2 %PATH% ^!', { files: ['a.ts'] }]);
  assert.match(r.stdout, /Follow it with: bruce-comm task T-/);

  const [inbox, detail, status, agents, card, broadcast] = await Promise.all([
    cli(['tasks', '--json', '--agent', 'coder', '--role', 'inbox']),
    cli(['task', id]),
    cli(['status']),
    cli(['agents']),
    cli(['agent', 'coder']),
    cli(['send', '--broadcast', '--message', '--title', 'hello all']),
  ]);
  const rows = JSON.parse(inbox.stdout);
  assert.equal(rows[0].id, id);
  assert.match(rows[0].created_at, /^\d{4}-\d\d-\d\dT/, 'timestamps are ISO in --json');
  assert.match(detail.stdout, /Refactor "parser" & tests/);
  assert.match(detail.stdout, /Line 2 %PATH% \^!/);
  assert.match(detail.stdout, /History:/);
  assert.match(status.stdout, /Agents: +3 total/);
  assert.match(status.stdout, new RegExp(`Daemon: +not running on port ${UNUSED_PORT}`));
  assert.match(agents.stdout, /guarded .*approval/);
  assert.match(card.stdout, /Instructions for other agents:/);
  assert.match(broadcast.stdout, /Sent 3 items \(message\)/);
  for (const result of [inbox, detail, status, agents, card, broadcast]) assert.equal(result.code, 0, result.stderr);

  // --wait: the CLI blocks until the task settles; here another process (this test) does the work.
  const pending = cli(['send', '--skill', 'code', '--title', 'nobody takes this in time', '--wait', '1']);
  const waiting = cli(['send', '--to', 'helper', '--title', 'wait for me', '--wait', '20']);
  const claimed = await waitFor(() => ctx.store.claimNext('helper').task, { timeout: 10_000, label: 'the CLI task to arrive' });
  ctx.store.complete('helper', claimed.id, 'All done by the helper.');
  r = await waiting;
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`${claimed.id} +\\[completed\\] +by helper\\n +All done by the helper\\.`));
  r = await pending;
  assert.match(r.stdout, /still pending/);
});

test('sessions: listing, agent card, send --session / --workspace, routing errors', async (t) => {
  const { ctx, cli } = setup(t, 'cli-sessions');
  const store = ctx.store;
  store.registerAgent({ id: 'coder', name: 'Coder', platform: 'vscode-copilot', instructions: 'Send code tasks.' });
  store.registerAgent({ id: 'idle-one', name: 'Idle', platform: 'cursor', instructions: 'x' });
  store.db.prepare('UPDATE agents SET last_seen_at=? WHERE id=?').run(Date.now() - 10 * 60_000, 'coder');
  const front = store.openSession({ transport: 'stdio', agent_id: 'coder', client_name: 'Visual Studio Code', client_version: '1.105.1', label: 'VS Code - frontend', workspaces: ['C:\\repos\\frontend'] });
  const back = store.openSession({ transport: 'http', agent_id: 'coder', client_name: 'Visual Studio Code', client_version: '1.105.1', label: 'VS Code - backend', workspaces: ['file:///c%3A/repos/backend'] });
  const anon = store.openSession({ transport: 'stdio', client_name: 'claude-ai', client_version: '0.1.0' });
  const oldRunner = store.openSession({ transport: 'runner', agent_id: 'coder', client_name: 'bruce-comm-runner', label: 'custom runner' });
  store.closeSession(oldRunner.id, 'runner stopped');

  const [list, json, all, card, status, idle] = await Promise.all([
    cli(['sessions']),
    cli(['sessions', '--agent', 'Coder', '--json']),
    cli(['sessions', '--all']),
    cli(['agent', 'coder']),
    cli(['status', '--json']),
    cli(['sessions', '--agent', 'idle-one']),
  ]);
  for (const s of [front, back, anon]) assert.match(list.stdout, new RegExp(s.id));
  assert.doesNotMatch(list.stdout, new RegExp(oldRunner.id));
  assert.match(list.stdout, /Visual Studio Code 1\.105\.1 \(http\)/);
  assert.match(list.stdout, /c:\/repos\/backend/);
  assert.match(list.stdout, /\(unregistered\)/);
  assert.deepEqual(JSON.parse(json.stdout).map((s) => s.id).sort(), [front.id, back.id].sort());
  assert.match(all.stdout, new RegExp(`${oldRunner.id}.*closed.*runner stopped`));
  assert.match(card.stdout, /Presence: +connected/);
  assert.match(card.stdout, /Sessions: +2 connected/);
  assert.match(card.stdout, new RegExp(`${front.id} +connected +Visual Studio Code 1\\.105\\.1 \\(stdio\\) +"VS Code - frontend" c:/repos/frontend`));
  assert.deepEqual(JSON.parse(status.stdout).sessions, { connected: 3, listening: 0 });
  assert.match(idle.stdout, /No connected sessions for agent "idle-one"\. Add --all/);

  let r = await cli(['send', '--to', 'coder', '--session', front.id.toLowerCase(), '--title', 'Fix the navbar']);
  assert.equal(r.code, 0, r.stderr);
  const pinned = store.requireTask(TASK_ID.exec(r.stdout)[0]);
  assert.deepEqual([pinned.to_session, pinned.to_workspace, pinned.from_session], [front.id, 'c:/repos/frontend', null]);
  assert.match(r.stdout, new RegExp(`Deliver to: only session ${front.id} while it is connected \\(otherwise a session with workspace "c:/repos/frontend"\\)`));
  assert.equal(store.claimNext('coder', back.id).task, null, 'only the pinned window may claim it');
  assert.equal(store.claimNext('coder', front.id).task.id, pinned.id);

  const here = tempDir('cwd');
  const [byName, byDot, noTo, unknown, otherAgent] = await Promise.all([
    cli(['send', '--to', 'coder', '--workspace', 'backend', '--title', 'API by folder name', '--json']),
    cli(['send', '--to', 'coder', '--workspace', '.', '--title', 'relative path'], { cwd: here }),
    cli(['send', '--session', front.id, '--title', 'x']),
    cli(['send', '--to', 'coder', '--session', 'S-NOPE1234', '--title', 'x']),
    cli(['send', '--to', 'idle-one', '--session', front.id, '--title', 'x']),
  ]);
  assert.equal(JSON.parse(byName.stdout).tasks[0].to_workspace, 'backend');
  assert.equal(byName.stderr, '', 'a live session has the folder open: no warning');
  assert.equal(store.requireTask(TASK_ID.exec(byDot.stdout)[0]).to_workspace, here.replace(/\\/g, '/').toLowerCase(), '"." is resolved against the cwd');
  assert.match(byDot.stderr, /warning: No connected session of "coder" has workspace/);
  for (const [result, pattern] of [
    [noTo, /--session needs --to <agent id>/],
    [unknown, /No session "S-NOPE1234" belongs to agent "coder"[\s\S]*hint: Connected sessions of "coder": /],
    [otherAgent, /No session .* belongs to agent "idle-one"/],
  ]) {
    assert.equal(result.code, 1);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, pattern);
  }
  r = await cli(['tasks', '--agent', 'coder']);
  assert.match(r.stdout, new RegExp(`${pinned.id} .*coder @${front.id}`));
});

test('close-session: database only without a daemon; through the daemon it also disconnects the live MCP connection', async (t) => {
  const { ctx, home, cli } = setup(t, 'cli-close');
  const store = ctx.store;
  store.registerAgent({ id: 'coder', instructions: 'Send code tasks.' });
  const front = store.openSession({ transport: 'stdio', agent_id: 'coder', client_name: 'Visual Studio Code', client_version: '1.105.1', label: 'VS Code - frontend', workspaces: ['C:\\repos\\frontend'] });
  const pinned = store.send('human', { to_agent: 'coder', title: 'pinned', to_session: front.id }).tasks[0];

  let r = await cli(['close-session', front.id]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`Closed session ${front.id} \\(agent "coder", Visual Studio Code 1\\.105\\.1 \\(stdio\\), "VS Code - frontend"\\)\\.`));
  assert.match(r.stdout, new RegExp(`Closed in the database only: the daemon is not running on port ${UNUSED_PORT}\\.`));
  assert.equal(store.getSession(front.id).close_reason, 'closed from the CLI');
  const after = store.requireTask(pinned.id);
  assert.deepEqual([after.to_session, after.to_workspace], [null, 'c:/repos/frontend']);
  const [again, missing] = await Promise.all([cli(['close-session', front.id]), cli(['close-session', 'S-NOPE1234'])]);
  assert.match(again.stdout, /was already closed .* ago \(closed from the CLI\)/);
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /No session "S-NOPE1234"\.\n  hint: See: bruce-comm sessions --all/);

  // A daemon on the same database, in this process (runCli is asynchronous, so it keeps serving).
  const daemonCtx = createContext({ home, port: 0 }, { quiet: true });
  t.after(() => daemonCtx.close());
  const daemon = await startHttp(daemonCtx);
  t.after(() => daemon.close());
  const client = await connectHttp(`${daemon.url}/mcp?agent=coder`, { name: 'cli-test-client', version: '9.9.9' });
  t.after(() => client.close());
  await client.call('bruce_status');
  const live = await waitFor(() => store.listSessions({ agent_id: 'coder' }).find((s) => s.client_name === 'cli-test-client'), { label: 'daemon-hosted session' });
  r = await cli(['close-session', live.id, '--json'], { env: { BRUCE_COMM_PORT: String(daemon.port) } });
  assert.equal(r.code, 0, r.stderr);
  const result = JSON.parse(r.stdout);
  assert.deepEqual([result.closed_via, result.disconnected, result.already_closed], ['daemon', true, false]);
  assert.equal(result.session.close_reason, 'closed from the dashboard');
  await assert.rejects(within(client.client.callTool({ name: 'bruce_status', arguments: {} }), 5000, 'call after disconnect'), (err) => {
    assert.doesNotMatch(err.message, /did not finish within/);
    return true;
  });
});

test('human actions: pending / approve / deny / agent-set / answer / note / cancel / unregister / purge', async (t) => {
  const { ctx, cli } = setup(t, 'cli-human');
  const store = ctx.store;
  seedAgents(store);
  const [held1, held2] = ['needs approval A', 'needs approval B'].map((title) => store.send('helper', { to_agent: 'guarded', title }).tasks[0].id);
  let r = await cli(['pending']);
  assert.match(r.stdout, new RegExp(held1));
  assert.match(r.stdout, new RegExp(held2));
  const [approve, deny] = await Promise.all([cli(['approve', held1, '--note', 'ok go']), cli(['deny', held2, '--reason', 'not now'])]);
  assert.equal(approve.code, 0, approve.stderr);
  assert.equal(deny.code, 0, deny.stderr);
  assert.equal(store.requireTask(held1).status, 'queued');
  assert.deepEqual([store.requireTask(held2).status, store.requireTask(held2).error], ['rejected', 'not now']);
  r = await cli(['agent-set', 'guarded', '--require-approval', 'false', '--accept-from', 'helper,coder', '--max-concurrent', '2']);
  assert.equal(r.code, 0, r.stderr);
  const guarded = store.requireAgent('guarded');
  assert.deepEqual([guarded.require_approval, guarded.accept_from, guarded.max_concurrent_tasks], [false, ['helper', 'coder'], 2]);
  r = await cli(['agent-set', 'guarded', '--require-approval', 'maybe']);
  assert.equal(r.code, 1);

  const id = store.send('human', { to_agent: 'coder', title: 'question time' }).tasks[0].id;
  store.claimNext('coder');
  store.requestInput('coder', id, 'Which branch?');
  r = await cli(['answer', id, 'use', 'main', 'please']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(store.requireTask(id).status, 'queued');
  assert.equal(store.getEvents(id).find((e) => e.type === 'input_provided').message, 'use main please');
  r = await cli(['note', id, 'FYI', 'the CI is red']);
  assert.equal(store.getEvents(id).at(-1).message, 'FYI the CI is red');
  r = await cli(['cancel', id, '--reason', 'superseded']);
  assert.equal(store.requireTask(id).status, 'canceled');
  r = await cli(['cancel', id]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /already "canceled"/);
  assert.doesNotMatch(r.stderr, /at .*\.js:\d+/, 'no stack trace');
  r = await cli(['unregister', 'helper']);
  assert.match(r.stdout, /Unregistered helper/);
  assert.equal(store.getAgent('helper'), undefined);
  // Removing an agent that requires approval is human-only; the CLI acts as the human.
  store.registerAgent({ id: 'sentinel', instructions: 'Ask first.', require_approval: true });
  r = await cli(['unregister', 'sentinel']);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(store.getAgent('sentinel'), undefined);
  r = await cli(['purge', '--days', '0']);
  assert.match(r.stdout, /Purged \d+ finished task/);
  assert.equal(store.getTask(id), undefined);
});

test('stdio --runner-task (what the runner puts in a headless CLI\'s MCP config): accepted, and the session is one-shot', async (t) => {
  const { ctx, home } = setup(t, 'cli-runner-task');
  ctx.store.registerAgent({ id: 'worker', instructions: 'Headless worker.' });
  const [mine, other] = ['the run\'s task', 'another task'].map((title) => ctx.store.send('human', { to_agent: 'worker', title }).tasks[0].id);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN, 'stdio', '--agent-id', 'worker', '--runner-task', mine],
    env: { BRUCE_COMM_HOME: home, BRUCE_COMM_PORT: String(UNUSED_PORT) },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'runner-child', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close().catch(() => {}));
  const res = await client.callTool({ name: 'get_next_task', arguments: { wait_seconds: 0 } });
  const text = res.content.map((c) => c.text ?? '').join('\n');
  assert.equal(res.isError, true, text);
  assert.match(text, new RegExp(`one-shot runner session: report on task ${mine} and stop`));
  assert.equal(ctx.store.requireTask(other).status, 'queued', 'a runner child never claims more work');
});

test('first start: processes opening a brand-new database at the same moment all succeed (no "database is locked")', async () => {
  // Regression: when several clients spawn `bruce-comm stdio` at once on a fresh install, each process switches the new
  // database to WAL. Without a busy timeout set first, about 1 in 10 of them failed at once with "database is locked";
  // with it, still about 1 in 200 (SQLite does not always consult the busy handler for this conversion), hence the retry
  // in openDatabase. The rare case needs a stress run (scratch probe: 1120 processes, 0 failures); this catches the common one.
  for (let round = 0; round < 3; round++) {
    const home = tempDir('first-start');
    const results = await Promise.all(Array.from({ length: 8 }, () => runCli(['agents', '--json'], { env: { BRUCE_COMM_HOME: home } })));
    for (const r of results) {
      assert.equal(r.code, 0, `round ${round}: ${r.stderr}`);
      assert.deepEqual(JSON.parse(r.stdout), []);
    }
  }
});

test('errors are one clean line (+ hint) on stderr with exit code 1; BRUCE_COMM_DEBUG=1 adds the stack', async (t) => {
  const { cli } = setup(t, 'cli-errors');
  const results = await Promise.all([
    cli(['frobnicate']),
    cli(['task', 'T-NOPE000000']),
    cli(['tasks', '--bogus']),
    cli(['send', '--to', 'nobody', '--title', 'x']),
    cli(['config', 'notepad']),
  ]);
  for (const r of results) {
    assert.equal(r.code, 1, r.stderr);
    assert.equal(r.stdout, '');
    assert.ok(r.stderr.trim().split('\n').length <= 2, r.stderr);
    assert.match(r.stderr, /^bruce-comm: /);
  }
  const debug = await cli(['task', 'T-NOPE000000'], { env: { BRUCE_COMM_DEBUG: '1' } });
  assert.match(debug.stderr, /at .*store\.js/);
});

test('config: ready-to-paste snippets for every client, HTTP variants', async (t) => {
  const { cli } = setup(t, 'cli-config');
  const [all, vscode] = await Promise.all([cli(['config', 'all']), cli(['config', 'vscode', '--transport', 'http', '--json'])]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /"BRUCE_AGENT_ID": "claude-desktop"/);
  assert.match(all.stdout, /"BRUCE_AGENT_ID": "vscode-copilot"/);
  assert.match(all.stdout, /BRUCE_AGENT_ID = ['"]codex['"]/);
  // The server name comes first: Claude Code's --env / --header are variadic and would swallow a name after them.
  assert.match(all.stdout, /claude mcp add bruce-comm --transport stdio --scope user --env BRUCE_AGENT_ID=claude-code (--env \S+ )*-- \S/);
  assert.match(all.stdout, /"BRUCE_COMM_HOME": /, 'a non-default home is passed on to the client');
  assert.match(all.stdout, /modelcontextprotocol\/inspector/);
  const [snippet] = JSON.parse(vscode.stdout);
  assert.deepEqual(snippet.entry, { type: 'http', url: `http://127.0.0.1:${UNUSED_PORT}/mcp?agent=vscode-copilot` });
});

test('config: generated claude / gemini commands put positionals before repeatable options and carry the token header', async (t) => {
  const { cli } = setup(t, 'cli-config-commands');
  const env = { BRUCE_COMM_TOKEN: 'secret123' };
  const [claudeHttp, geminiHttp] = await Promise.all([
    cli(['config', 'claude-code', '--transport', 'http', '--json'], { env }),
    cli(['config', 'gemini', '--transport', 'http', '--json'], { env }),
  ]);
  const url = `http://127.0.0.1:${UNUSED_PORT}/mcp?agent=`;
  assert.deepEqual(JSON.parse(claudeHttp.stdout)[0].commands, [
    `claude mcp add bruce-comm "${url}claude-code" --transport http --scope user --header "Authorization: Bearer secret123"`,
  ]);
  const [gemini] = JSON.parse(geminiHttp.stdout);
  assert.deepEqual(gemini.entry.headers, { Authorization: 'Bearer secret123' });
  assert.deepEqual(gemini.commands, [
    `gemini mcp add --scope user --transport http --trust bruce-comm "${url}gemini-cli" -H "Authorization: Bearer secret123"`,
  ]);
});

test('serve (MCP + status through the started daemon, busy port), version, help, runner init / check', async (t) => {
  const { home, cli } = setup(t, 'cli-serve');

  async function daemonChecks() {
    const port = await freePort();
    const env = { BRUCE_COMM_PORT: String(port) };
    const daemon = spawn(process.execPath, [BIN, 'serve', '--port', String(port)], {
      env: { ...process.env, BRUCE_COMM_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    t.after(() => killTree(daemon.pid));
    let banner = '';
    daemon.stdout.setEncoding('utf8').on('data', (d) => (banner += d));
    await waitFor(() => banner.includes('Press Ctrl+C to stop.'), { timeout: 20_000, label: 'serve banner' });
    assert.match(banner, new RegExp(`MCP endpoint: http://127\\.0\\.0\\.1:${port}/mcp`));
    assert.equal((await raw(port, { path: '/healthz' })).json.ok, true);
    const client = await connectHttp(`http://127.0.0.1:${port}/mcp?agent=serve-check`, { name: 'serve-check-client' });
    t.after(() => client.close());
    const registered = await client.call('register_agent', { agent_id: 'serve-check', instructions: 'Checks the CLI daemon.' });
    assert.equal(registered.isError, false, registered.text);
    const [status, second] = await Promise.all([cli(['status'], { env }), cli(['serve'], { env })]);
    assert.match(status.stdout, new RegExp(`Daemon: +running - dashboard http://127\\.0\\.0\\.1:${port}/`));
    assert.match(status.stdout, /Sessions: +1 connected/, 'the daemon\'s MCP connection is a session in the shared database');
    assert.equal(second.code, 1);
    assert.equal(second.stdout, '');
    assert.match(second.stderr, new RegExp(`^bruce-comm: Port ${port} on 127\\.0\\.0\\.1 is already in use\\.\\n  hint: .*/healthz`));
    assert.equal(second.stderr.trim().split('\n').length, 2, `one clean error line + hint, nothing else:\n${second.stderr}`);

    const [version, versionJson, help, helpSend] = await Promise.all([cli(['version']), cli(['version', '--json']), cli(['help']), cli(['help', 'send'])]);
    assert.match(version.stdout, /^bruce-comm \d+\.\d+\.\d+ \(node /);
    assert.equal(JSON.parse(versionJson.stdout).name, 'bruce-comm');
    for (const command of ['serve', 'stdio', 'runner', 'sessions', 'close-session', 'send', 'install']) {
      assert.match(help.stdout, new RegExp(`^  ${command} +\\S`, 'm'), `help lists ${command}`);
    }
    assert.match(helpSend.stdout, /^Usage: bruce-comm send [\s\S]*--session <S-id> \| --workspace <path\|name>/);
  }

  // Independent of the daemon (and slow-ish: it looks the agent CLIs up on PATH), so it runs alongside.
  async function runnerSetupChecks() {
    let r = await cli(['runner', 'init']);
    assert.equal(r.code, 0, r.stderr);
    const runners = JSON.parse(fs.readFileSync(path.join(home, 'runners.json'), 'utf8')).runners;
    assert.ok(runners.length >= 5 && runners.every((entry) => entry.enabled === false), 'one example per preset, all disabled');
    r = await cli(['runner', 'init']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /already exists\.\n  hint: .*runner init --force/);
    r = await cli(['runner', 'check']);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /0 enabled, 0 with problems/, 'the generated example is a valid runner config');
  }

  await Promise.all([daemonChecks(), runnerSetupChecks()]);
});

test('install: --dry-run writes nothing; merges keep other keys and write a .bak; conflicts need --yes', async (t) => {
  const { cli, clientDir, home } = setup(t, 'cli-install');
  let results = await Promise.all(['claude-desktop', 'vscode', 'cursor', 'gemini', 'codex'].map((client) => cli(['install', client, '--dry-run'])));
  for (const r of results) assert.equal(r.code, 0, r.stderr);
  assert.match(results[0].stdout, /Dry run - would write .*claude_desktop_config\.json/);
  assert.ok(!fs.existsSync(clientDir) || fs.readdirSync(clientDir, { recursive: true }).length === 0, 'dry runs write nothing');

  const desktopFile = path.join(clientDir, 'claude-desktop', 'claude_desktop_config.json');
  fs.mkdirSync(path.dirname(desktopFile), { recursive: true });
  fs.writeFileSync(desktopFile, JSON.stringify({ preferences: { theme: 'dark' }, mcpServers: { other: { command: 'x' } } }));
  const vscodeFile = path.join(clientDir, 'vscode', 'mcp.json');
  fs.mkdirSync(path.dirname(vscodeFile), { recursive: true });
  fs.writeFileSync(vscodeFile, '');
  const cursorFile = path.join(clientDir, 'cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(cursorFile), { recursive: true });
  fs.writeFileSync(cursorFile, '{\n  // my servers\n  "mcpServers": { "a": { "url": "http://x/y" }, },\n}\n');
  const explicit = path.join(home, 'explicit', 'copilot.json');
  results = await Promise.all([
    cli(['install', 'claude-desktop']),
    cli(['install', 'vscode', '--transport', 'http']),
    cli(['install', 'cursor']),
    cli(['install', 'copilot-cli', '--config-file', explicit]),
  ]);
  const [desktop, code, cursor, copilot] = results;
  assert.equal(desktop.code, 0, desktop.stderr);
  const merged = JSON.parse(fs.readFileSync(desktopFile, 'utf8'));
  assert.deepEqual(merged.preferences, { theme: 'dark' });
  assert.deepEqual(merged.mcpServers.other, { command: 'x' });
  assert.equal(merged.mcpServers['bruce-comm'].env.BRUCE_AGENT_ID, 'claude-desktop');
  assert.equal(fs.readdirSync(path.dirname(desktopFile)).filter((f) => f.endsWith('.bak')).length, 1, 'backup written');
  assert.equal(code.code, 0, code.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(vscodeFile, 'utf8')), {
    servers: { 'bruce-comm': { type: 'http', url: `http://127.0.0.1:${UNUSED_PORT}/mcp?agent=vscode-copilot` } },
  });
  assert.equal(cursor.code, 1, 'a JSONC file is not rewritten without --yes');
  assert.match(cursor.stderr, /comments or trailing commas/);
  assert.equal(copilot.code, 0, copilot.stderr);
  const copilotEntry = JSON.parse(fs.readFileSync(explicit, 'utf8')).mcpServers['bruce-comm'];
  assert.equal(copilotEntry.type, 'stdio');

  results = await Promise.all([
    cli(['install', 'vscode', '--transport', 'http']),
    cli(['install', 'vscode', '--transport', 'http', '--agent-id', 'vscode-2']),
    cli(['install', 'cursor', '--yes']),
  ]);
  assert.match(results[0].stdout, /nothing to do/);
  assert.equal(results[1].code, 1);
  assert.match(results[1].stderr, /already has a different "bruce-comm" entry[\s\S]*--yes/);
  assert.equal(results[2].code, 0, results[2].stderr);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(cursorFile, 'utf8')).mcpServers), ['a', 'bruce-comm']);
  const replaced = await cli(['install', 'vscode', '--transport', 'http', '--agent-id', 'vscode-2', '--yes']);
  assert.equal(replaced.code, 0, replaced.stderr);
  assert.match(JSON.parse(fs.readFileSync(vscodeFile, 'utf8')).servers['bruce-comm'].url, /agent=vscode-2$/);
});
