// MCP sessions (SPEC-SESSIONS): one agent connected through several windows. Store sessions opened per MCP
// connection, client info + MCP roots recorded, list_sessions, to_session / to_workspace delivery, reply routing,
// session close -> rerouted work, roots refresh and robustness, heartbeat, binding changes. Tests run in order.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { heartbeatOpenSessions, trackedSessionCount } from '../dist/mcp/server.js';
import { LIMITS } from '../dist/store/types.js';
import { connectInMemory, testContext, waitFor, within } from './helpers.mjs';

const FRONT = 'file:///c%3A/src/shop-frontend';
const BACK = 'file:///c%3A/src/shop-backend';
const SHARED = 'file:///c%3A/src/shared-lib';

let ctx;
let logs;
const clients = [];
/** W1 / W2: two VS Code windows of agent "copilot". S1 (Claude Desktop) / S2 (Claude Code): two sessions of "claude". */
let W1;
let W2;
let S1;
let S2;

async function connect(session, options) {
  const agent = await connectInMemory(ctx, session, options);
  clients.push(agent);
  return agent;
}
const row = (sid) => ctx.store.getSession(sid);

before(async () => {
  ({ ctx, logs } = testContext('mcp-sessions', { port: 7457 }));
  W1 = await connect({ transport: 'stdio' }, { name: 'Visual Studio Code', version: '1.140.0', roots: [FRONT] });
  W2 = await connect({ transport: 'http', sessionId: 'mcp-sess-W2' }, { name: 'Visual Studio Code', version: '1.140.0', roots: [BACK] });
  S1 = await connect({ transport: 'stdio' }, { name: 'claude-ai', version: '0.14.10' });
  S2 = await connect({ transport: 'stdio' }, { name: 'claude-code', version: '2.1.286', roots: ['file:///c%3A/Users/you/notes'] });
});

after(async () => {
  for (const client of clients) await client.close();
  ctx.close();
});

test('each MCP connection opens a store session; client info and MCP roots are recorded automatically', async () => {
  for (const agent of [W1, W2, S1, S2]) assert.match(agent.sid(), /^S-[0-9A-Z]{8}$/);
  assert.notEqual(W1.sid(), W2.sid());
  assert.equal(trackedSessionCount(), 4);
  // stdio sessions ask for roots right after the handshake, http ones ~1 s later (the client's GET stream must be open).
  await waitFor(() => row(W1.sid()).workspaces.length && row(W2.sid()).workspaces.length && row(S2.sid()).workspaces.length, {
    timeout: 5000,
    label: 'roots recorded as workspaces',
  });
  const w1 = row(W1.sid());
  assert.equal(w1.client_name, 'Visual Studio Code');
  assert.equal(w1.client_version, '1.140.0');
  assert.deepEqual(w1.workspaces, ['c:/src/shop-frontend'], 'file:///c%3A/... normalised');
  assert.deepEqual(row(W2.sid()).workspaces, ['c:/src/shop-backend']);
  assert.equal(W1.rootsState.calls, 1);
  assert.equal(W2.rootsState.calls, 1);
  assert.deepEqual(row(S1.sid()).workspaces, [], 'a client without the roots capability is never asked');
  assert.equal(row(S1.sid()).client_name, 'claude-ai');
  assert.equal(row(W2.sid()).transport, 'http');
  assert.equal(w1.transport, 'stdio');
  assert.equal(w1.host_pid, process.pid);
  assert.equal(w1.agent_id, null, 'not identified yet');
});

test('register_agent binds the window, saves session_label and shows the agent\'s other windows', async () => {
  let r = await W1.call('register_agent', {
    agent_id: 'copilot',
    name: 'Copilot',
    platform: 'vscode-copilot',
    instructions: 'Coding agent in VS Code. Send me coding tasks with file paths and acceptance criteria.',
    session_label: 'VS Code - frontend',
  });
  assert.equal(r.isError, false, r.text);
  assert.equal(r.payload.your_session.id, W1.sid());
  assert.equal(r.payload.your_session.label, 'VS Code - frontend');
  assert.equal(row(W1.sid()).agent_id, 'copilot');
  assert.equal(r.payload.agent.connected_sessions, 1);
  r = await W2.call('register_agent', { agent_id: 'copilot' });
  assert.equal(row(W2.sid()).agent_id, 'copilot');
  assert.deepEqual(r.payload.your_other_sessions.map((s) => s.id), [W1.sid()]);
  assert.match(r.payload.session_tip, /open in 2 sessions/);
  await S1.call('register_agent', { agent_id: 'claude', platform: 'claude-desktop', instructions: 'Claude Desktop research assistant. Send research questions.' });
  assert.equal(row(S1.sid()).agent_id, 'claude');
  r = await S2.call('bruce_status', { agent_id: 'claude' });
  assert.match(r.headline, /^You are "claude"/);
  assert.equal(row(S2.sid()).agent_id, 'claude', 'an explicit agent_id binds the store session too');
});

test('list_sessions, list_agents, get_agent and bruce_status expose the windows', async () => {
  const { tools } = await S1.client.listTools();
  const listSessions = tools.find((tool) => tool.name === 'list_sessions');
  assert.equal(listSessions.annotations.readOnlyHint, true);
  assert.match(listSessions.description, /^List the live sessions \(IDE windows \/ app instances\) of agents\. Use a session id with send_task\(to_session\)/);
  const sendTask = tools.find((tool) => tool.name === 'send_task');
  assert.ok(sendTask.inputSchema.properties.to_session && sendTask.inputSchema.properties.to_workspace);
  const register = tools.find((tool) => tool.name === 'register_agent');
  assert.equal(register.inputSchema.properties.session_workspaces.type, 'array');

  let r = await S1.call('list_sessions', { agent_id: 'copilot' });
  assert.equal(r.payload.count, 2);
  for (const s of r.payload.sessions) {
    assert.equal(s.agent, 'copilot');
    assert.equal(s.client, 'Visual Studio Code 1.140.0');
    assert.equal(s.connected, true);
    assert.equal(s.this_is_you, undefined);
  }
  assert.deepEqual(r.payload.sessions.find((s) => s.id === W1.sid()).workspaces, ['c:/src/shop-frontend']);
  assert.equal(r.payload.sessions.find((s) => s.id === W1.sid()).label, 'VS Code - frontend');
  r = await S1.call('list_sessions');
  assert.equal(r.payload.count, 4);
  assert.deepEqual(r.payload.sessions.filter((s) => s.this_is_you).map((s) => s.id), [S1.sid()]);
  assert.equal(r.payload.by_agent.copilot.length, 2);
  r = await S1.call('list_sessions', { agent_id: 'nobody' });
  assert.match(r.headline, /No agent registered with id "nobody"/);

  r = await S1.call('list_agents');
  assert.equal(r.payload.agents.find((a) => a.id === 'copilot').connected_sessions, 2);
  r = await S1.call('get_agent', { agent_id: 'copilot' });
  assert.equal(r.payload.sessions.length, 2);
  assert.match(r.headline, /open in 2 sessions/);
  assert.match(r.payload.how_to_target_a_window, /to_session/);
  r = await W2.call('bruce_status');
  assert.equal(r.payload.your_session.id, W2.sid());
  assert.deepEqual(r.payload.your_other_sessions.map((s) => s.label), ['VS Code - frontend']);
  assert.match(r.headline, /This session: S-/);
  assert.equal(r.payload.agents.open_sessions.connected, 4);
});

test('send_task(to_session) reaches only that window', async () => {
  let r = await S1.call('send_task', { to_agent: 'copilot', to_session: W2.sid().toLowerCase(), title: 'Fix the orders API' });
  assert.equal(r.isError, false, r.text);
  const pinned = r.payload.task.id;
  assert.equal(r.payload.task.to_session, W2.sid());
  assert.equal(r.payload.task.from_session, S1.sid(), 'the sending window is recorded');
  assert.equal(r.payload.task.to_workspace, 'c:/src/shop-backend', 'fallback workspace');
  assert.match(r.headline, /session S-\w+ only/);
  r = await W1.call('get_next_task');
  assert.equal(r.payload.task, undefined, 'the other window of the same agent cannot claim it');
  assert.equal(r.payload._bruce.tasks, 0, '... and its footer does not count it');
  r = await W2.call('get_next_task');
  assert.equal(r.payload.task.id, pinned);
  assert.equal(r.payload.task.assignee_session, W2.sid());
  assert.ok(r.text.includes(`Routing: only session ${W2.sid()} (this window) may take it`));
  await W2.call('complete_task', { task_id: pinned, result: 'Orders API fixed.' });

  r = await S1.call('send_task', { to_agent: 'copilot', to_session: 'S-NOPE0000', title: 'x' });
  assert.match(r.text, /^Error \[unknown_session\]/);
  assert.ok(r.text.includes(W1.sid()) && r.text.includes(W2.sid()), 'the error lists the live sessions');
  r = await S1.call('send_task', { to_agent: '*', to_session: W1.sid(), title: 'x' });
  assert.match(r.text, /need to_agent set to a specific agent/);
});

test('send_task(to_workspace) reaches the window with that folder (name, path or label)', async () => {
  let r = await S1.call('send_task', { to_agent: 'copilot', to_workspace: 'shop-frontend', title: 'Dark mode toggle' });
  const front = r.payload.task.id;
  assert.equal(r.payload.task.to_workspace, 'shop-frontend');
  assert.equal(r.payload.warnings, undefined);
  assert.equal((await W2.call('get_next_task')).payload.task, undefined);
  r = await W1.call('get_next_task');
  assert.equal(r.payload.task.id, front);
  assert.ok(r.text.includes('meant for the window that has workspace "shop-frontend" open'));
  await W1.call('complete_task', { task_id: front, result: 'done' });

  r = await S1.call('send_task', { to_agent: 'copilot', to_workspace: 'C:\\src\\shop-backend\\', title: 'Index the orders table' });
  const backPath = r.payload.task.id;
  assert.equal(r.payload.task.to_workspace, 'c:/src/shop-backend');
  assert.equal((await W1.call('get_next_task')).payload.task, undefined);
  assert.equal((await W2.call('get_next_task')).payload.task.id, backPath);
  await W2.call('complete_task', { task_id: backPath, result: 'done' });

  r = await S1.call('send_task', { to_agent: 'copilot', to_workspace: 'vs code - frontend', title: 'By label' });
  const byLabel = r.payload.task.id;
  assert.equal((await W1.call('get_next_task')).payload.task.id, byLabel);
  await W1.call('complete_task', { task_id: byLabel, result: 'done' });

  r = await S1.call('send_task', { to_agent: 'copilot', to_workspace: 'mobile-app', title: 'Nobody has it open' });
  assert.match(r.payload.warnings.join(' '), /No connected session of "copilot" has workspace "mobile-app" open/);
  await S1.call('cancel_task', { task_id: r.payload.task.id });
});

test('a window that stopped heart-beating while its host runs no longer holds its pinned work: a sibling with its workspace takes it', async () => {
  // A third copilot window hosted by this process, without a live MCP link refreshing its heartbeat.
  const hung = ctx.store.openSession({ transport: 'stdio', agent_id: 'copilot', workspaces: [FRONT], label: 'VS Code - hung' });
  let r = await S1.call('send_task', { to_agent: 'copilot', to_session: hung.id, title: 'For the hung window' });
  assert.equal(r.isError, false, r.text);
  const id = r.payload.task.id;
  assert.equal((await W1.call('get_next_task')).payload.task, undefined, 'bound while that window is connected');
  ctx.store.db.prepare('UPDATE sessions SET heartbeat_at=? WHERE id=?').run(Date.now() - LIMITS.sessionStaleMs - 1_000, hung.id);
  r = await S1.call('get_task', { task_id: id });
  assert.ok(
    r.text.includes(`Routing: meant for session ${hung.id}, which is not connected right now - until it is back, a window with workspace "c:/src/shop-frontend" open may take it.`),
    r.text,
  );
  r = await S1.call('send_task', { to_agent: 'copilot', to_session: hung.id, title: 'x' });
  assert.match(r.text, /^Error \[session_closed\]/, 'send_task refuses a window that is not connected');
  assert.equal((await W2.call('get_next_task')).payload.task, undefined, 'W2 does not have that workspace open');
  r = await W1.call('get_next_task');
  assert.equal(r.payload.task?.id, id, 'W1 has the workspace open');
  assert.equal(r.payload.task.to_session, undefined, 'the fallback claim released the pin');
  await W1.call('complete_task', { task_id: id, result: 'done by a sibling window' });
  ctx.store.closeSession(hung.id, 'test cleanup');
});

test('long-polls are per window: a task pinned to W1 wakes W1 and never satisfies W2', async () => {
  const w2Poll = W2.call('get_next_task', { wait_seconds: 3 });
  const w1Poll = W1.call('get_next_task', { wait_seconds: 10 });
  await waitFor(() => row(W1.sid()).listening && row(W2.sid()).listening, { label: 'both windows listening' });
  const listed = await S2.call('list_sessions', { agent_id: 'copilot' });
  assert.ok(listed.payload.sessions.every((s) => s.listening === true));
  const sentAt = Date.now();
  const sent = await S1.call('send_task', { to_agent: 'copilot', to_session: W1.sid(), title: 'Only for W1' });
  const got1 = await within(w1Poll, 5000, 'W1 wake-up');
  assert.equal(got1.payload.task.id, sent.payload.task.id);
  assert.ok(Date.now() - sentAt < 1500, `W1 woke ${Date.now() - sentAt} ms after the send`);
  const got2 = await within(w2Poll, 6000, 'W2 timeout');
  assert.equal(got2.payload.task, undefined);
  assert.match(got2.headline, /No task or message arrived in 3s/);
  assert.equal(row(W1.sid()).listening, false);
  assert.equal(row(W2.sid()).listening, false);
  assert.equal(ctx.store.getAgent('copilot').listening_until, null);
});

test('reply routing: replies return to the asking window, follow-ups go to the working window, notices stay per window', async () => {
  const [parent] = ctx.store.listTasks({ assignee: 'copilot', status: 'working' });
  let r = await W1.call('send_task', { kind: 'message', to_agent: 'claude', parent_task_id: parent.id, title: 'Which branch?', body: 'main or release?' });
  assert.equal(r.payload.task.to_session, S1.sid(), 'a reply to the sender goes to the session that sent the parent');
  assert.equal(r.payload.task.from_session, W1.sid());
  r = await S2.call('get_next_task');
  assert.ok(!r.payload.messages?.length, 'the other session of "claude" does not get it');
  r = await S1.call('get_next_task');
  assert.match(r.headline, /Delivered 1 message/);
  assert.ok(r.text.includes('main or release?') && r.text.includes('(this window)'));

  r = await S1.call('send_task', { to_agent: 'copilot', parent_task_id: parent.id, title: 'Follow-up: add tests' });
  assert.equal(r.payload.task.to_session, W1.sid(), 'a follow-up to the assignee goes to the window that did the work');
  const followUp = r.payload.task.id;
  assert.equal((await W2.call('get_next_task')).payload.task, undefined);
  assert.equal((await W1.call('get_next_task')).payload.task.id, followUp);
  await W1.call('complete_task', { task_id: followUp, result: 'tests added' });
  await W1.call('complete_task', { task_id: parent.id, result: 'Done on main.' });
  const s1 = await S1.call('list_agents');
  const s2 = await S2.call('list_agents');
  assert.ok(s1.payload._bruce.results_ready >= 1);
  assert.match(s1.last, /result\(s\) ready/);
  assert.equal(s2.payload._bruce.results_ready, 0, 'no results nudge in the other session of the same agent');

  r = await S1.call('send_task', { to_agent: 'copilot', to_workspace: 'shop-backend', title: 'Migrate DB' });
  const question = r.payload.task.id;
  await W2.call('get_next_task');
  await W2.call('request_input', { task_id: question, question: 'Postgres 16 or 17?' });
  assert.equal((await S1.call('bruce_status')).payload._bruce.questions_for_you, 1);
  assert.equal((await S2.call('bruce_status')).payload._bruce.questions_for_you, 0);
  r = await S2.call('reply_to_task', { task_id: question, message: '17' });
  assert.equal(r.payload.task.to_session, W2.sid(), 'the answer resumes in the window that asked');
  assert.equal((await W1.call('get_next_task')).payload.task, undefined);
  r = await W2.call('get_next_task');
  assert.equal(r.payload.task.id, question);
  assert.match(r.headline, /^Resumed task/);
  await W2.call('complete_task', { task_id: question, result: 'migrated' });
});

test('roots/list_changed refreshes workspaces; declared session_workspaces are merged and kept', async () => {
  W2.rootsState.roots = [BACK, SHARED];
  await W2.client.sendRootsListChanged();
  await waitFor(() => row(W2.sid()).workspaces.includes('c:/src/shared-lib'), { label: 'refreshed roots' });
  assert.equal(W2.rootsState.calls, 2);
  let r = await S1.call('send_task', { to_agent: 'copilot', to_workspace: 'shared-lib', title: 'Bump lodash' });
  assert.equal(r.payload.warnings, undefined, 'W2 now has shared-lib open');
  const shared = r.payload.task.id;
  assert.equal((await W1.call('get_next_task')).payload.task, undefined);
  assert.equal((await W2.call('get_next_task')).payload.task.id, shared);
  await W2.call('complete_task', { task_id: shared, result: 'bumped' });

  await W1.call('register_agent', { agent_id: 'copilot', session_workspaces: ['D:\\docs\\handbook'] });
  assert.deepEqual(row(W1.sid()).workspaces, ['d:/docs/handbook', 'c:/src/shop-frontend'], 'declared first, then the roots');
  W1.rootsState.roots = [FRONT, 'file:///c%3A/src/design-system'];
  await W1.client.sendRootsListChanged();
  await waitFor(() => row(W1.sid()).workspaces.length === 3, { label: 'roots merged with declared folders' });
  assert.deepEqual(row(W1.sid()).workspaces, ['d:/docs/handbook', 'c:/src/shop-frontend', 'c:/src/design-system']);
});

test('the process-wide heartbeat refreshes every open session of this process', () => {
  ctx.store.db.prepare('UPDATE sessions SET heartbeat_at = heartbeat_at - 60000 WHERE id = ?').run(W1.sid());
  const before = row(W1.sid()).heartbeat_at;
  assert.equal(heartbeatOpenSessions(), 4);
  assert.ok(row(W1.sid()).heartbeat_at > before);
});

test('a session a sweep closed while its connection is alive (sleep, clock jump) is revived with its binding, label, workspaces and long-poll', async () => {
  const sid = W1.sid();
  const before = row(sid);
  assert.equal(before.label, 'VS Code - frontend');
  const poll = W1.call('get_next_task', { wait_seconds: 10 });
  await waitFor(() => row(sid).listening, { label: 'W1 listening' });
  ctx.store.closeSession(sid, 'no heartbeat'); // what another process's sweep does right after the machine wakes up
  assert.notEqual(row(sid).closed_at, null);
  assert.equal(row(sid).listening, false);

  heartbeatOpenSessions();
  const revived = row(sid);
  assert.equal(revived.closed_at, null, 'the next heartbeat reopens it');
  assert.equal(revived.connected, true);
  assert.equal(revived.agent_id, 'copilot');
  assert.equal(revived.label, 'VS Code - frontend');
  assert.deepEqual(revived.workspaces, before.workspaces);
  assert.equal(revived.listening, true, 'the long-poll in progress is marked again');
  assert.ok(logs.some((l) => l.includes(`session ${sid} was closed while its connection is alive; reopened`)));
  let r = await S1.call('send_task', { to_agent: 'copilot', to_session: sid, title: 'After the sleep' });
  assert.equal(r.isError, false, r.text);
  const got = await within(poll, 5000, 'W1 wake-up after the revival');
  assert.equal(got.payload.task.id, r.payload.task.id);
  assert.equal(ctx.store.requireTask(got.payload.task.id).assignee_session, sid);
  await W1.call('complete_task', { task_id: got.payload.task.id, result: 'done' });

  ctx.store.closeSession(sid, 'no heartbeat');
  r = await W1.call('bruce_status');
  assert.equal(r.payload.your_session.connected, true, 'a tool call revives it too, before the next heartbeat');
  assert.equal(row(sid).agent_id, 'copilot');
  ctx.store.closeSession(sid, 'closed from the dashboard');
  heartbeatOpenSessions();
  assert.notEqual(row(sid).closed_at, null, 'a deliberate close stays closed');
  await W1.call('bruce_status');
  assert.notEqual(row(sid).closed_at, null);
  // Reopen for the following tests (as a new connection of that window would).
  ctx.store.db.prepare("UPDATE sessions SET closed_at=NULL, close_reason=NULL WHERE id=?").run(sid);
});

test('closing a window closes its session: pinned work is rerouted, work in progress re-queued', async () => {
  const updates = [];
  S1.client.setNotificationHandler(ResourceUpdatedNotificationSchema, (n) => updates.push(n.params.uri));
  await S1.client.subscribeResource({ uri: 'bruce://sessions' });

  let r = await S1.call('send_task', { to_agent: 'copilot', to_session: W2.sid(), title: 'Pinned A' });
  const a = r.payload.task.id;
  r = await S1.call('send_task', { to_agent: 'copilot', to_session: W2.sid(), title: 'Pinned B' });
  const b = r.payload.task.id;
  const claimed = (await W2.call('get_next_task')).payload.task.id;
  const queued = claimed === a ? b : a;
  const tracked = trackedSessionCount();

  await W2.close();
  await waitFor(() => row(W2.sid()).closed_at != null, { label: 'W2 session closed' });
  const closed = row(W2.sid());
  assert.equal(closed.close_reason, 'disconnected');
  assert.equal(closed.connected, false);
  assert.equal(trackedSessionCount(), tracked - 1);
  const q = ctx.store.requireTask(queued);
  assert.equal(q.status, 'queued');
  assert.equal(q.to_session, null);
  assert.equal(q.to_workspace, 'c:/src/shop-backend', 'keeps its workspace');
  assert.ok(ctx.store.getEvents(queued).some((e) => e.type === 'rerouted'));
  const w = ctx.store.requireTask(claimed);
  assert.equal(w.status, 'queued', 'the task the closed window was working on is re-queued');
  assert.equal(w.assignee, null);

  r = await S1.call('list_sessions', { agent_id: 'copilot' });
  assert.deepEqual(r.payload.sessions.map((s) => s.id), [W1.sid()]);
  r = await S1.call('list_sessions', { agent_id: 'copilot', include_closed: true });
  assert.ok(r.payload.sessions.some((s) => s.id === W2.sid() && s.connected === false && s.close_reason === 'disconnected'));
  r = await S1.call('send_task', { to_agent: 'copilot', to_session: W2.sid(), title: 'x' });
  assert.match(r.text, /^Error \[session_closed\]/);
  assert.equal((await W1.call('get_next_task')).payload.task, undefined, 'W1 has other folders open');

  const W3 = await connect({ transport: 'stdio', agentId: 'copilot' }, { name: 'Visual Studio Code', version: '1.141.0', roots: [BACK] });
  await waitFor(() => row(W3.sid()).workspaces.length, { label: 'W3 roots' });
  assert.equal(row(W3.sid()).agent_id, 'copilot', 'a pre-bound session opens with its agent');
  const picked = [(await W3.call('get_next_task')).payload.task?.id, (await W3.call('get_next_task')).payload.task?.id];
  assert.deepEqual(picked.sort(), [a, b].sort(), 'a new window on the same folder picks both up');
  await waitFor(() => updates.includes('bruce://sessions'), { label: 'bruce://sessions update' });
});

test('roots robustness: a failed roots/list is logged and retried with the next tool call; a hanging client blocks nothing', async () => {
  const flaky = await connect({ transport: 'http', sessionId: 'mcp-flaky' }, { name: 'flaky-client', version: '1.0', roots: ['file:///c%3A/src/flaky'] });
  await waitFor(() => row(flaky.sid()).workspaces.length, { timeout: 4000, label: 'flaky roots' });
  flaky.rootsState.calls = 0;
  flaky.rootsState.handler = (n) => {
    if (n === 1) throw new Error('not ready yet');
    return { roots: [{ uri: 'file:///c%3A/src/flaky-v2' }] };
  };
  await flaky.client.sendRootsListChanged();
  await waitFor(() => logs.some((l) => /roots\/list for session .* failed \(1\/3\)/.test(l)), { label: 'failure logged' });
  assert.deepEqual(row(flaky.sid()).workspaces, ['c:/src/flaky'], 'previous roots kept');
  assert.equal((await flaky.call('bruce_status')).isError, false);
  await waitFor(() => row(flaky.sid()).workspaces[0] === 'c:/src/flaky-v2', { label: 'retry through the tool call' });
  assert.equal(flaky.rootsState.calls, 2);

  const hang = await connect({ transport: 'stdio' }, { name: 'hanging-client', version: '1.0', roots: ['file:///c%3A/x'] });
  await waitFor(() => row(hang.sid()).workspaces.length, { label: 'hang roots' });
  hang.rootsState.handler = () => new Promise(() => {});
  hang.rootsState.calls = 0;
  await hang.client.sendRootsListChanged();
  await waitFor(() => hang.rootsState.calls >= 1, { label: 'pending roots/list' });
  const started = Date.now();
  assert.equal((await hang.call('bruce_status')).isError, false);
  assert.ok(Date.now() - started < 1000, 'tool calls are never blocked by roots/list');
});

test('binding changes are mirrored into the session row; closing everything releases all sessions', async () => {
  await S2.call('register_agent', { agent_id: 'claude-code.notes', instructions: 'Claude Code in the notes folder. Send note-taking tasks.' });
  assert.equal(row(S2.sid()).agent_id, 'claude-code.notes');
  await S2.call('unregister_agent');
  assert.equal(row(S2.sid()).agent_id, null);
  await S2.call('register_agent', { agent_id: 'claude' });
  assert.equal(row(S2.sid()).agent_id, 'claude');

  for (const client of clients.splice(0)) await client.close();
  await waitFor(() => trackedSessionCount() === 0, { label: 'sessions untracked' });
  assert.equal(ctx.store.listSessions().length, 0);
  await waitFor(() => ctx.notifier.listeners.size === 0, { label: 'notifier listeners released' });
});
