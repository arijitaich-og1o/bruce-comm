// stdio transport through the real launcher (`node bin/bruce-comm.js stdio`): client processes sharing one database,
// cross-process long-poll wake-up, store sessions visible across processes, one agent open in two windows (processes)
// with per-window delivery and reply routing, sessions closed when the client goes away, stdout carrying nothing but
// JSON-RPC, bad identities failing fast.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, test } from 'node:test';
import { BIN, alive, connectStdio, killTree, testContext, waitFor, within } from './helpers.mjs';

let ctx;
let home;
const clients = [];
/** The two client processes of the first test (A sends, B works), reused by the second. */
let a;
let b;

before(() => {
  ({ ctx, home } = testContext('stdio'));
});

after(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'raw', version: '1' } } };

/** Spawn `bruce-comm stdio` with raw pipes; the process is killed when test `t` ends, whatever the outcome. */
function spawnRaw(t, args = [], env = {}) {
  const child = spawn(process.execPath, [BIN, 'stdio', ...args], {
    env: { ...process.env, BRUCE_COMM_HOME: home, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  t.after(() => killTree(child.pid));
  const out = { stdout: '', stderr: '', code: undefined };
  child.stdout.setEncoding('utf8').on('data', (d) => (out.stdout += d));
  child.stderr.setEncoding('utf8').on('data', (d) => (out.stderr += d));
  out.exited = new Promise((resolve) => child.on('exit', (code) => resolve((out.code = code))));
  const lines = () => out.stdout.split('\n').filter(Boolean);
  return { child, out, lines };
}

test('two stdio processes share the queue: cross-process wake-up within ~1 s, sessions visible everywhere', async () => {
  a = await connectStdio({ home, name: 'proc-a-client' });
  clients.push(a);
  b = await connectStdio({ home, agentId: 'proc-b', name: 'proc-b-client', roots: ['file:///c%3A/src/proc-b-repo'] });
  clients.push(b);
  assert.equal((await a.client.listTools()).tools.length, 33);
  let r = await a.call('register_agent', { agent_id: 'proc-a', instructions: 'Process A test agent. Sends tasks.' });
  assert.equal(r.isError, false, r.text);
  r = await b.call('register_agent', { agent_id: 'proc-b', instructions: 'Process B test agent. Does tasks.' });
  assert.equal(r.isError, false, r.text);
  assert.match((await b.call('bruce_status')).headline, /^You are "proc-b"/, 'pre-bound with --agent-id');

  const sessionOfB = await waitFor(() => ctx.store.listSessions({ agent_id: 'proc-b' })[0], { label: 'B session in the shared store' });
  assert.equal(sessionOfB.transport, 'stdio');
  assert.equal(sessionOfB.client_name, 'proc-b-client');
  assert.equal(sessionOfB.host_pid, b.pid, 'hosted by the B server process');
  await waitFor(() => ctx.store.getSession(sessionOfB.id).workspaces.length, { label: 'B roots recorded' });
  assert.deepEqual(ctx.store.getSession(sessionOfB.id).workspaces, ['c:/src/proc-b-repo'], 'MCP roots auto-detected over stdio');
  r = await a.call('list_sessions', { agent_id: 'proc-b' });
  assert.deepEqual(r.payload.sessions.map((s) => s.id), [sessionOfB.id], 'A (another process) sees B\'s session');

  const progress = [];
  const waiting = b.call('get_next_task', { wait_seconds: 30 }, { onprogress: (p) => progress.push(p), resetTimeoutOnProgress: true });
  await waitFor(() => ctx.store.getSession(sessionOfB.id)?.listening, { label: 'B listening' });
  const sentAt = Date.now();
  r = await a.call('send_task', { to_agent: 'proc-b', title: 'Cross-process task', body: 'hello from another process' });
  const taskId = r.payload.task.id;
  const got = await within(waiting, 5000, 'cross-process wake-up');
  const wakeMs = Date.now() - sentAt;
  assert.equal(got.payload.task.id, taskId);
  assert.ok(wakeMs < 2000, `B (another process) woke ${wakeMs} ms after the send`);
  assert.ok(progress.length >= 1);
  r = await b.call('complete_task', { task_id: taskId, result: 'done across processes' });
  assert.equal(r.isError, false);
  r = await a.call('wait_for_result', { task_ids: [taskId], wait_seconds: 5 });
  assert.ok(r.text.includes('done across processes'));
  assert.deepEqual(a.errors, [], 'no protocol errors on the client side');
});

test('one agent in two windows (two processes): list_sessions shows both, to_workspace / to_session wake only the right process, replies return', async () => {
  const w1 = await connectStdio({ home, agentId: 'vscode-copilot', name: 'Visual Studio Code', roots: ['file:///c%3A/src/shop-frontend'] });
  clients.push(w1);
  const w2 = await connectStdio({ home, agentId: 'vscode-copilot', name: 'Visual Studio Code', roots: ['file:///c%3A/src/shop-backend'] });
  clients.push(w2);
  let r = await w1.call('register_agent', { agent_id: 'vscode-copilot', instructions: 'VS Code Copilot. Send coding tasks.', session_label: 'VS Code - frontend' });
  assert.equal(r.isError, false, r.text);
  r = await w2.call('register_agent', { agent_id: 'vscode-copilot', session_label: 'VS Code - backend' });
  assert.equal(r.isError, false, r.text);
  const [s1, s2] = await waitFor(() => {
    const live = ctx.store.listSessions({ agent_id: 'vscode-copilot' });
    const byPid = (pid) => live.find((s) => s.host_pid === pid && s.workspaces.length);
    return byPid(w1.pid) && byPid(w2.pid) ? [byPid(w1.pid), byPid(w2.pid)] : null;
  }, { label: 'both windows registered with their roots' });

  r = await a.call('list_sessions', { agent_id: 'vscode-copilot' });
  const rows = Object.fromEntries(r.payload.sessions.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(rows).sort(), [s1.id, s2.id].sort(), 'another process lists both windows of the agent');
  assert.deepEqual([rows[s1.id].label, rows[s1.id].workspaces], ['VS Code - frontend', ['c:/src/shop-frontend']]);
  assert.deepEqual([rows[s2.id].label, rows[s2.id].workspaces], ['VS Code - backend', ['c:/src/shop-backend']]);

  // Both windows long-poll; each task must wake the window it is meant for, and only that one.
  const settled = new Set();
  const poll1 = w1.call('get_next_task', { wait_seconds: 30 }).finally(() => settled.add('w1'));
  const poll2 = w2.call('get_next_task', { wait_seconds: 30 }).finally(() => settled.add('w2'));
  await waitFor(() => ctx.store.getSession(s1.id).listening && ctx.store.getSession(s2.id).listening, { label: 'both windows listening' });
  const backend = (await a.call('send_task', { to_agent: 'vscode-copilot', to_workspace: 'shop-backend', title: 'Index the orders table' })).payload.task.id;
  const got2 = await within(poll2, 5000, 'backend window wake-up');
  assert.equal(got2.payload.task.id, backend);
  assert.equal(ctx.store.requireTask(backend).assignee_session, s2.id);
  assert.equal(settled.has('w1'), false, 'the frontend window is still waiting');
  const front = (await a.call('send_task', { to_agent: 'vscode-copilot', to_session: s1.id, title: 'Fix the navbar' })).payload.task.id;
  const got1 = await within(poll1, 5000, 'frontend window wake-up');
  assert.equal(got1.payload.task.id, front);
  assert.equal(ctx.store.requireTask(front).assignee_session, s1.id);

  // A reply from the backend window goes back to the process (session) that sent the task.
  const sessionOfA = ctx.store.listSessions({ agent_id: 'proc-a' }).find((s) => s.host_pid === a.pid);
  assert.equal(ctx.store.requireTask(backend).from_session, sessionOfA.id, 'the sending window is recorded');
  r = await w2.call('send_task', { kind: 'message', to_agent: 'proc-a', parent_task_id: backend, title: 'Indexed, migration is in PR 7' });
  assert.equal(r.payload.task.to_session, sessionOfA.id, 'the reply is pinned to the process that asked');
  r = await a.call('get_next_task');
  assert.match(r.headline, /Delivered 1 message/);
  assert.ok(r.text.includes('Indexed, migration is in PR 7'));
  for (const [window, id] of [[w1, front], [w2, backend]]) {
    assert.equal((await window.call('complete_task', { task_id: id, result: 'done' })).isError, false);
  }
});

test('the session closes (and pinned work is rerouted) when the stdio client goes away; the process exits', async () => {
  const sessionOfB = ctx.store.listSessions({ agent_id: 'proc-b' })[0];
  const pinned = ctx.store.send('human', { to_agent: 'proc-b', to_session: sessionOfB.id, title: 'pinned to the B window' }).tasks[0];
  const pid = b.pid;
  await b.close();
  clients.splice(clients.indexOf(b), 1);
  await waitFor(() => !alive(pid), { timeout: 5000, label: 'B server process exit' });
  const closed = ctx.store.getSession(sessionOfB.id);
  assert.notEqual(closed.closed_at, null, 'closed by the exiting process, not left for the sweeper');
  assert.equal(closed.close_reason, 'disconnected');
  const task = ctx.store.requireTask(pinned.id);
  assert.equal(task.to_session, null);
  assert.ok(ctx.store.getEvents(pinned.id).some((e) => e.type === 'rerouted'));
  assert.equal(ctx.store.listSessions({ agent_id: 'proc-b' }).length, 0);
  assert.match(b.stderr(), /stdio MCP session ready as "proc-b"/, 'diagnostics go to stderr');
});

test('stdout carries only JSON-RPC (identity from BRUCE_AGENT_ID); EOF on stdin ends the process with code 0; no sqlite warning', async (t) => {
  const { child, out, lines } = spawnRaw(t, [], { BRUCE_AGENT_ID: 'proc-a' });
  // Generous: process start-up time is not what this test measures (a loaded Windows machine can take seconds).
  const expectLines = (count, label) =>
    waitFor(() => lines().length >= count, { timeout: 20_000, label }).catch((err) => {
      throw new Error(`${err.message}\nchild stdout: ${out.stdout}\nchild stderr: ${out.stderr}`);
    });
  child.stdin.write(`${JSON.stringify(INIT)}\n`);
  await expectLines(1, 'initialize response');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'bruce_status', arguments: {} } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'ping' })}\n`);
  await expectLines(3, 'tool + ping responses');
  child.stdin.end();
  const code = await within(out.exited, 5000, 'exit after stdin EOF');
  assert.equal(code, 0);
  const messages = lines().map((line) => JSON.parse(line));
  assert.ok(messages.every((m) => m.jsonrpc === '2.0'), 'every stdout line is a JSON-RPC message');
  assert.deepEqual(messages.map((m) => m.id).sort(), [1, 2, 3], 'one response per request (order may differ)');
  assert.match(messages.find((m) => m.id === 2).result.content[0].text, /^You are "proc-a"/);
  assert.doesNotMatch(out.stderr, /ExperimentalWarning/);
  assert.match(out.stderr, /stdio MCP session ready/);
});

test('a client that closes our stderr does not crash the server: diagnostics are best effort (EPIPE tolerated)', async (t) => {
  const { child, out, lines } = spawnRaw(t);
  const expectLines = (count, label) =>
    waitFor(() => lines().length >= count, { timeout: 20_000, label }).catch((err) => {
      throw new Error(`${err.message}\nchild stdout: ${out.stdout}\nchild stderr: ${out.stderr}\nexit: ${out.code}`);
    });
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  send(INIT);
  await expectLines(1, 'initialize response');
  await waitFor(() => /stdio MCP session ready/.test(out.stderr), { timeout: 20_000, label: 'ready line on stderr' });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  child.stderr.destroy(); // the client's log forwarder went away; stdin / stdout stay open
  // register_agent binds the session, which writes a diagnostic line to the now broken stderr.
  send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'register_agent', arguments: { agent_id: 'stderr-less', instructions: 'Test agent whose client closed stderr.' } } });
  await expectLines(2, 'register_agent response');
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'bruce_status', arguments: {} } });
  await expectLines(3, 'bruce_status response after the broken stderr');
  assert.equal(out.code, undefined, 'the server is still running');
  const status = lines().map((line) => JSON.parse(line)).find((m) => m.id === 3);
  assert.match(status.result.content[0].text, /^You are "stderr-less"/);
  child.stdin.end();
  assert.equal(await within(out.exited, 5000, 'exit after stdin EOF'), 0);
});

test('BRUCE_COMM_RUNNER_TASK marks a one-shot runner session: work-loop-free instructions, get_next_task refused', async () => {
  const cli = await connectStdio({ home, agentId: 'proc-a', name: 'headless-cli', env: { BRUCE_COMM_RUNNER_TASK: 't-envrunner1' } });
  clients.push(cli);
  assert.match(cli.client.getInstructions(), /one-shot session started by the Bruce Comm runner for task T-ENVRUNNER1/);
  const r = await cli.call('get_next_task');
  assert.match(r.text, /^Error \[not_allowed\]: This is a one-shot runner session: report on task T-ENVRUNNER1 and stop\./);
  assert.match(cli.stderr(), /stdio MCP session ready as "proc-a" for runner task T-ENVRUNNER1/);
});

test('--agent-id pre-binds the stdio session: a call naming another agent acts for that call only, the session keeps its identity', async () => {
  ctx.store.registerAgent({ id: 'chat-window', instructions: 'The user\'s interactive chat window.' });
  ctx.store.registerAgent({ id: 'chat-runner', instructions: 'Runner agent that drives a chat window.' });
  const task = ctx.store.send('human', { to_agent: 'chat-runner', title: 'unattended chat task' }).tasks[0];
  assert.equal(ctx.store.claimNext('chat-runner').task.id, task.id, 'the runner claimed it');
  const win = await connectStdio({ home, agentId: 'chat-window', name: 'chat-window-client' });
  clients.push(win);
  const r = await win.call('complete_task', { agent_id: 'chat-runner', task_id: task.id, result: 'done in the chat window' });
  assert.equal(r.isError, false, r.text);
  assert.equal(ctx.store.requireTask(task.id).status, 'completed', 'the call acted as chat-runner');
  assert.equal(r.payload._bruce.you, 'chat-window', 'the footer describes the window\'s own agent');
  assert.match((await win.call('bruce_status')).headline, /^You are "chat-window"/, 'not re-bound to chat-runner');
  assert.equal(ctx.store.listSessions({ agent_id: 'chat-window' }).length, 1, 'the session row keeps its agent');
  assert.equal(ctx.store.listSessions({ agent_id: 'chat-runner' }).length, 0);
});

test('a reserved or malformed --agent-id fails fast: exit 1, clear stderr, empty stdout', async (t) => {
  for (const id of ['human', 'Bad Id!']) {
    const { out } = spawnRaw(t, ['--agent-id', id]);
    const code = await within(out.exited, 20_000, `stdio --agent-id ${id}`);
    assert.equal(code, 1, id);
    assert.equal(out.stdout, '', id);
    assert.match(out.stderr, /^bruce-comm: .*(reserved|Invalid agent id)/m, id);
  }
});
