// BruceStore: routing, priorities, leases / dead-letter, approval gate, limits, idempotency, input round trip,
// sessions (pins bind only while their window is connected) and reply routing, input hardening. In-memory database with a controllable clock - no I/O, no sleeps - except the last test,
// where worker processes share one database file and race for the same tasks.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { openDatabase, transaction } from '../dist/db.js';
import { BruceStore, normalizeWorkspace, sessionRoutingKeys } from '../dist/store/store.js';
import { LIMITS } from '../dist/store/types.js';
import { deadPid, fixture, killTree, tempDir, testContext, waitFor, within } from './helpers.mjs';

/** A store on a fresh in-memory database whose clock only moves with tick(). */
function makeStore(t) {
  const clock = { now: 1_700_000_000_000 };
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const store = new BruceStore(db, { now: () => clock.now });
  return { store, clock, tick: (ms) => (clock.now += ms) };
}

const register = (store, id, extra = {}) => store.registerAgent({ id, instructions: `Instructions of ${id}.`, ...extra }).agent;
const sendOne = (store, from, input, options) => store.send(from, input, options).tasks[0];
const events = (store, id) => store.getEvents(id).map((e) => e.type);

test('agents: ids are validated and normalised, instructions required once, profiles patch', (t) => {
  const { store } = makeStore(t);
  assert.throws(() => store.registerAgent({ id: 'agent-a' }), { code: 'invalid_argument', message: /instructions is required/ });
  for (const id of ['human', 'system', '*', 'Bad Id!', 'x']) {
    assert.throws(() => store.registerAgent({ id, instructions: 'x' }), { code: 'invalid_agent_id' }, id);
  }
  const { agent, created } = store.registerAgent({
    id: '  Agent-A ',
    instructions: 'Send me research questions.',
    skills: [{ id: 'Research', tags: ['Web'] }],
  });
  assert.equal(created, true);
  assert.equal(agent.id, 'agent-a');
  assert.deepEqual(agent.skills.map((s) => [s.id, s.tags]), [['research', ['web']]]);
  assert.equal(agent.accept_from[0], '*');
  assert.equal(agent.max_concurrent_tasks, 3);

  const again = store.registerAgent({ id: 'agent-a', status: 'busy', status_message: 'testing' });
  assert.equal(again.created, false);
  assert.equal(again.agent.status, 'busy');
  assert.equal(again.agent.instructions, 'Send me research questions.', 'patch semantics keep the other fields');
  assert.throws(() => store.updateAgent('agent-a', { skills: [{ id: 'a' }, { id: 'A' }] }), { message: /Duplicate skill id/ });
  assert.throws(() => store.updateAgent('ghost', { status: 'away' }), { code: 'unknown_agent' });
  assert.equal(store.getAgent('AGENT-A').id, 'agent-a', 'lookups are case-insensitive');
});

test('routing: direct, skill (tags, case-insensitive), open "*", broadcast, accept_from, messages delivered once', (t) => {
  const { store } = makeStore(t);
  register(store, 'claude-desktop', { skills: [{ id: 'research', tags: ['web'] }] });
  register(store, 'copilot', { skills: [{ id: 'code' }], accept_from: ['claude-desktop'] });
  register(store, 'rogue');

  assert.throws(() => store.send('rogue', { to_agent: 'copilot', title: 'hi' }), { code: 'not_allowed', message: /does not accept/ });
  assert.throws(() => store.send('rogue', { to_agent: 'ghost', title: 'x' }), { code: 'unknown_agent' });
  assert.throws(() => store.send('nobody', { to_agent: 'copilot', title: 'x' }), { code: 'unknown_agent' });
  assert.throws(() => store.send('rogue', { to_agent: 'copilot', to_skill: 'code', title: 'x' }), { code: 'invalid_argument', message: /exactly one recipient/ });
  assert.throws(() => store.send('rogue', { title: 'x' }), { code: 'invalid_argument' });
  assert.throws(() => store.send('rogue', { to_agent: 'claude-desktop', title: '   ' }), { code: 'invalid_argument', message: /title/ });

  const direct = sendOne(store, 'claude-desktop', { to_agent: 'copilot', title: 'direct' });
  assert.match(direct.id, /^T-[0-9A-Z]{10}$/);
  assert.equal(store.getTask(direct.id.toLowerCase()).id, direct.id, 'task ids are case-insensitive');
  assert.equal(store.claimNext('rogue').task, null, 'only the addressee may claim a direct task');
  assert.equal(store.claimNext('copilot').task.id, direct.id);

  const skill = sendOne(store, 'copilot', { to_skill: ' WEB ', title: 'search it' });
  assert.equal(skill.to_skill, 'web');
  assert.equal(store.claimNext('copilot').task, null, 'the sender never claims its own skill-routed task');
  assert.equal(store.claimNext('rogue').task, null, 'an agent without the skill cannot claim it');
  assert.equal(store.claimNext('claude-desktop').task.id, skill.id, 'a skill tag routes the task');

  const refused = store.send('rogue', { to_skill: 'code', title: 'rogue wants code' });
  assert.match(refused.warnings.join(' '), /do not accept tasks from "rogue"/);
  assert.equal(store.claimNext('copilot').task, null, 'accept_from also filters skill-routed work');
  const nobody = store.send('rogue', { to_skill: 'cooking', title: 'x' });
  assert.match(nobody.warnings.join(' '), /No registered agent currently offers skill "cooking"/);

  const open = sendOne(store, 'claude-desktop', { to_agent: '*', title: 'anyone' });
  assert.equal(store.claimNext('claude-desktop').task, null, 'not its own open task');
  assert.equal(store.claimNext('rogue').task.id, open.id);

  const fromDesktop = store.send('claude-desktop', { kind: 'message', broadcast: true, title: 'hello all' });
  assert.deepEqual(fromDesktop.tasks.map((m) => m.to_agent).sort(), ['copilot', 'rogue']);
  assert.ok(fromDesktop.tasks.every((m) => /^M-/.test(m.id) && m.broadcast_id === fromDesktop.tasks[0].broadcast_id));
  const fromRogue = store.send('rogue', { kind: 'message', broadcast: true, title: 'from rogue' });
  assert.deepEqual(fromRogue.tasks.map((m) => m.to_agent), ['claude-desktop'], 'broadcast skips agents that refuse the sender');

  const delivered = store.takeMessages('copilot');
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].status, 'completed');
  assert.equal(delivered[0].status_message, 'delivered');
  assert.deepEqual(events(store, delivered[0].id), ['created', 'delivered']);
  assert.equal(store.takeMessages('copilot').length, 0, 'delivered once');
  assert.equal(store.claimNext('claude-desktop').task, null, 'messages are never claimed as tasks');
});

test('priorities: highest first, then oldest; values are clamped to 0..9', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker', { max_concurrent_tasks: 10 });
  const low = sendOne(store, 'sender', { to_agent: 'worker', title: 'low', priority: 1 });
  tick(1);
  const normal = sendOne(store, 'sender', { to_agent: 'worker', title: 'normal' });
  tick(1);
  const high = sendOne(store, 'sender', { to_agent: 'worker', title: 'high', priority: 9 });
  tick(1);
  const high2 = sendOne(store, 'sender', { to_agent: 'worker', title: 'high, later', priority: 9 });
  assert.equal(normal.priority, LIMITS.defaultPriority);
  const order = [1, 2, 3, 4].map(() => store.claimNext('worker').task.id);
  assert.deepEqual(order, [high.id, high2.id, normal.id, low.id]);
  assert.equal(sendOne(store, 'sender', { to_agent: 'worker', title: 'x', priority: 42 }).priority, 9);
  assert.equal(sendOne(store, 'sender', { to_agent: 'worker', title: 'y', priority: -3 }).priority, 0);
});

test('leases: progress renews, expiry re-queues, the last attempt is dead-lettered', (t) => {
  const { store, clock, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker');
  const task = sendOne(store, 'sender', { to_agent: 'worker', title: 'lease', lease_seconds: 60, max_attempts: 2 });
  let claimed = store.claimNext('worker').task;
  assert.equal(claimed.attempts, 1);
  assert.equal(claimed.lease_expires_at, clock.now + 60_000);
  assert.equal(store.pendingCounts('worker').working, 1);

  tick(30_000);
  const progressed = store.progress('worker', task.id, 'still going', 40);
  assert.equal(progressed.progress, 40);
  assert.equal(progressed.lease_expires_at, clock.now + 60_000, 'progress renews the lease');
  assert.throws(() => store.progress('sender', task.id, 'x'), { code: 'not_assignee' });
  tick(59_000);
  assert.deepEqual(store.sweep(), { requeued: 0, dead_lettered: 0, expired: 0 });
  tick(2_000);
  assert.deepEqual(store.sweep(), { requeued: 1, dead_lettered: 0, expired: 0 });
  let current = store.requireTask(task.id);
  assert.equal(current.status, 'queued');
  assert.equal(current.assignee, null);
  assert.ok(events(store, task.id).includes('lease_expired'));

  claimed = store.claimNext('worker').task;
  assert.equal(claimed.attempts, 2);
  tick(61_000);
  assert.deepEqual(store.sweep(), { requeued: 0, dead_lettered: 1, expired: 0 });
  current = store.requireTask(task.id);
  assert.equal(current.status, 'failed');
  assert.match(current.error, /Lease expired on attempt 2 of 2 without completion; giving up/);
  assert.throws(() => store.progress('worker', task.id), { code: 'invalid_state' });
  assert.equal(sendOne(store, 'sender', { to_agent: 'worker', title: 'short', lease_seconds: 1 }).lease_seconds, LIMITS.minLeaseSeconds);
});

test('failures: retry re-queues while attempts remain, release does not use an attempt, reject is final', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker', { max_concurrent_tasks: 10 });
  const flaky = sendOne(store, 'sender', { to_agent: 'worker', title: 'flaky', max_attempts: 2 });
  store.claimNext('worker');
  let after = store.fail('worker', flaky.id, 'network down', true);
  assert.equal(after.status, 'queued');
  assert.equal(after.assignee, null);
  assert.equal(after.error, 'network down');
  assert.match(after.status_message, /Retrying after failure \(attempt 1 of 2\)/);
  assert.equal(store.claimNext('worker').task.attempts, 2);
  after = store.fail('worker', flaky.id, 'still down', true);
  assert.equal(after.status, 'failed', 'no attempts left');
  assert.deepEqual(events(store, flaky.id), ['created', 'claimed', 'retrying', 'claimed', 'failed']);

  const handBack = sendOne(store, 'sender', { to_agent: 'worker', title: 'hand back' });
  assert.equal(store.claimNext('worker').task.attempts, 1);
  after = store.release('worker', handBack.id, 'shutting down');
  assert.equal(after.status, 'queued');
  assert.equal(after.attempts, 0);
  assert.equal(store.claimNext('worker').task.attempts, 1, 'reclaimed as attempt 1 again');
  assert.throws(() => store.complete('sender', handBack.id, 'hijack'), { code: 'not_assignee' });

  const unsafe = sendOne(store, 'sender', { to_agent: 'worker', title: 'unsafe' });
  store.claimNext('worker');
  after = store.reject('worker', unsafe.id, 'out of scope');
  assert.equal(after.status, 'rejected');
  assert.equal(after.error, 'out of scope');
  assert.throws(() => store.cancel('worker', handBack.id), { code: 'not_allowed', message: /Only the sender/ });
  assert.equal(store.cancel('sender', handBack.id, 'not needed').status, 'canceled');
  assert.throws(() => store.cancel('sender', handBack.id), { code: 'invalid_state' });
  assert.throws(() => store.progress('worker', handBack.id), { code: 'invalid_state', hint: /stop working/ });
});

test('time-based delivery: expires_in_seconds expires unclaimed work, delay_seconds holds it back', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker');
  const expiring = sendOne(store, 'sender', { to_agent: 'worker', title: 'expires', expires_in_seconds: 10 });
  tick(11_000);
  assert.equal(store.sweep().expired, 1);
  assert.equal(store.requireTask(expiring.id).status, 'expired');

  const delayed = sendOne(store, 'sender', { to_agent: 'worker', title: 'later', delay_seconds: 30 });
  assert.equal(store.claimNext('worker').task, null);
  assert.equal(store.pendingCounts('worker').tasks, 0);
  tick(31_000);
  assert.equal(store.pendingCounts('worker').tasks, 1);
  assert.equal(store.claimNext('worker').task.id, delayed.id);
});

test('approval gate: held tasks wait for the human; agents can turn it on but never off', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'careful', { require_approval: true });
  assert.throws(() => store.registerAgent({ id: 'careful', require_approval: false }), { code: 'not_allowed', message: /Only the human/ });

  const held = store.send('sender', { to_agent: 'careful', title: 'needs ok' });
  assert.equal(held.tasks[0].status, 'awaiting_approval');
  assert.match(held.warnings.join(' '), /Held until the human approves it/);
  assert.equal(store.claimNext('careful').task, null);
  assert.equal(store.pendingCounts('careful').awaiting_approval, 1);
  const approved = store.approve(held.tasks[0].id, 'fine');
  assert.equal(approved.status, 'queued');
  assert.equal(approved.approved_by, 'human');
  assert.equal(store.claimNext('careful').task.id, approved.id);
  assert.throws(() => store.approve(approved.id), { code: 'invalid_state' });

  assert.equal(sendOne(store, 'human', { to_agent: 'careful', title: 'from the human' }).status, 'queued', 'the human is never held');
  const denied = store.deny(sendOne(store, 'sender', { to_agent: 'careful', title: 'deny me' }).id, 'not now');
  assert.equal(denied.status, 'rejected');
  assert.equal(denied.error, 'not now');

  store.updateAgent('careful', { require_approval: false }, { asHuman: true });
  assert.equal(store.requireAgent('careful').require_approval, false, 'the human can turn it off');
  register(store, 'worker');
  const queued = sendOne(store, 'sender', { to_agent: 'worker', title: 'queued before approval was turned on' });
  store.updateAgent('worker', { require_approval: true });
  assert.equal(store.requireTask(queued.id).status, 'awaiting_approval', 'turning approval on holds queued agent work');
  const explicit = sendOne(store, 'worker', { to_agent: 'sender', title: 'sender asks for approval', requires_approval: true });
  assert.equal(explicit.status, 'awaiting_approval', 'requires_approval=true holds even for recipients without the gate');
});

test('limits: delegation depth, per-recipient rate, queue size, broadcast size, text sizes', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker');

  let parent = sendOne(store, 'sender', { to_agent: 'worker', title: 'depth 0' });
  for (let depth = 1; depth <= LIMITS.maxDepth; depth++) {
    parent = sendOne(store, 'sender', { to_agent: 'worker', title: `depth ${depth}`, parent_task_id: parent.id });
  }
  assert.equal(parent.depth, LIMITS.maxDepth);
  assert.equal(parent.thread_id, store.requireTask(parent.parent_task_id).thread_id, 'sub-tasks join the parent thread');
  assert.throws(() => store.send('sender', { to_agent: 'worker', title: 'too deep', parent_task_id: parent.id }), { code: 'too_deep' });

  tick(LIMITS.rateWindowMs + 1);
  for (let i = 0; i < LIMITS.rateLimitPerRecipient; i++) store.send('sender', { to_agent: 'worker', title: `burst ${i}` });
  assert.throws(() => store.send('sender', { to_agent: 'worker', title: 'one too many' }), { code: 'rate_limited' });
  assert.equal(sendOne(store, 'human', { to_agent: 'worker', title: 'the human is exempt' }).status, 'queued');
  tick(LIMITS.rateWindowMs + 1);
  assert.equal(sendOne(store, 'sender', { to_agent: 'worker', title: 'window passed' }).status, 'queued');

  register(store, 'flood');
  register(store, 'target');
  for (let i = 0; i < LIMITS.maxQueuedPerAgent; i++) {
    if (i && i % LIMITS.rateLimitPerRecipient === 0) tick(LIMITS.rateWindowMs + 1);
    store.send('flood', { to_agent: 'target', title: `item ${i}` });
  }
  tick(LIMITS.rateWindowMs + 1);
  assert.throws(() => store.send('flood', { to_agent: 'target', title: 'overflow' }), { code: 'queue_full' });

  for (let i = 0; i <= LIMITS.maxBroadcastRecipients; i++) register(store, `extra-${i}`);
  assert.throws(() => store.send('sender', { broadcast: true, kind: 'message', title: 'everyone' }), { code: 'too_many_recipients' });

  assert.throws(() => store.send('sender', { to_agent: 'worker', title: 'x'.repeat(LIMITS.titleMax + 1) }), { code: 'invalid_argument' });
  assert.throws(() => store.send('sender', { to_agent: 'worker', title: 'big', body: 'x'.repeat(LIMITS.bodyMax + 1) }), { code: 'invalid_argument' });
  assert.throws(() => store.send('sender', { to_agent: 'worker', title: 'big', input: { blob: 'x'.repeat(LIMITS.jsonMax) } }), { code: 'invalid_argument' });
});

test('idempotency: a repeated key returns the original task(s) instead of queueing duplicates', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'other');
  register(store, 'worker');
  const first = store.send('sender', { to_agent: 'worker', title: 'original', idempotency_key: 'k-1' });
  const again = store.send('sender', { to_agent: 'worker', title: 'retried send', idempotency_key: 'k-1' });
  assert.equal(first.deduplicated, false);
  assert.equal(again.deduplicated, true);
  assert.equal(again.tasks[0].id, first.tasks[0].id);
  assert.equal(again.tasks[0].title, 'original');
  store.cancel('sender', first.tasks[0].id);
  assert.equal(store.send('sender', { to_agent: 'worker', title: 'x', idempotency_key: 'k-1' }).tasks[0].status, 'canceled');
  assert.notEqual(sendOne(store, 'other', { to_agent: 'worker', title: 'x', idempotency_key: 'k-1' }).id, first.tasks[0].id, 'keys are per sender');
  assert.equal(store.listTasks({ to_agent: 'worker' }).length, 2);

  const broadcast = store.send('sender', { broadcast: true, kind: 'message', title: 'hi', idempotency_key: 'b-1' });
  assert.equal(broadcast.tasks.length, 2);
  assert.deepEqual(broadcast.tasks.map((m) => m.idempotency_key), ['b-1', 'b-1'], 'every copy keeps the key as given');
  const repeat = store.send('sender', { broadcast: true, kind: 'message', title: 'hi', idempotency_key: 'b-1' });
  assert.equal(repeat.deduplicated, true);
  assert.deepEqual(repeat.tasks.map((m) => m.id).sort(), broadcast.tasks.map((m) => m.id).sort());
});

test('input round trip: question pauses the task, the answer returns it to the same assignee without using an attempt', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker');
  register(store, 'stranger');
  const task = sendOne(store, 'sender', { to_agent: 'worker', title: 'needs info' });
  store.claimNext('worker');
  const paused = store.requestInput('worker', task.id, 'Which file?');
  assert.equal(paused.status, 'input_required');
  assert.equal(paused.lease_expires_at, null);
  assert.equal(paused.status_message, 'Which file?');
  assert.equal(store.pendingCounts('sender').questions_for_you, 1);
  assert.equal(store.pendingCounts('worker').waiting_for_answer, 1);
  assert.throws(() => store.provideInput('stranger', task.id, 'x'), { code: 'not_allowed', message: /Only the sender/ });

  tick(1);
  const urgent = sendOne(store, 'sender', { to_agent: 'worker', title: 'urgent', priority: 9 });
  const resumed = store.provideInput('sender', task.id, 'src/a.ts', { file: 'src/a.ts' });
  assert.equal(resumed.status, 'queued');
  assert.equal(resumed.assignee, 'worker', 'reserved for the same assignee');
  assert.throws(() => store.provideInput('sender', task.id, 'again'), { code: 'invalid_state' });
  const reclaimed = store.claimNext('worker').task;
  assert.equal(reclaimed.id, task.id, 'a reserved task is claimed before higher-priority new work');
  assert.equal(reclaimed.attempts, 1, 'answering a question does not use up a delivery attempt');
  const answer = store.getEvents(task.id).find((e) => e.type === 'input_provided');
  assert.equal(answer.message, 'src/a.ts');
  assert.deepEqual(answer.data, { file: 'src/a.ts' });

  const done = store.complete('worker', task.id, 'done', { files: 1 });
  assert.equal(done.status, 'completed');
  assert.deepEqual(done.result_data, { files: 1 });
  assert.equal(store.pendingCounts('sender').results_ready, 1);
  store.markResultsSeen('sender', [task.id.toLowerCase()]);
  assert.equal(store.pendingCounts('sender').results_ready, 0);

  store.claimNext('worker');
  store.requestInput('worker', urgent.id, 'Really?');
  assert.equal(store.provideInput('human', urgent.id, 'yes').status, 'queued', 'the human may answer any question');
  const note = store.addNote('stranger', urgent.id, 'FYI');
  assert.equal(note.type, 'note');
});

test('unregister: direct work is canceled, held skill work re-queued, sessions unbound', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'leaver', { skills: [{ id: 'code' }] });
  register(store, 'other', { skills: [{ id: 'code' }] });
  const direct = sendOne(store, 'sender', { to_agent: 'leaver', title: 'only you' });
  const skill = sendOne(store, 'sender', { to_skill: 'code', title: 'anyone who codes' });
  const session = store.openSession({ transport: 'stdio', agent_id: 'leaver' });
  const claimed = [store.claimNext('leaver', session.id).task.id, store.claimNext('leaver', session.id).task.id];
  assert.deepEqual(claimed.sort(), [direct.id, skill.id].sort());
  assert.deepEqual(store.unregisterAgent('leaver'), { removed: true, requeued: 1, canceled: 1 });
  assert.equal(store.requireTask(direct.id).status, 'canceled');
  assert.equal(store.requireTask(skill.id).status, 'queued');
  assert.equal(store.getSession(session.id).agent_id, null);
  assert.equal(store.claimNext('other').task.id, skill.id);
  assert.deepEqual(store.unregisterAgent('leaver'), { removed: false, requeued: 0, canceled: 0 });
});

test('presence: listening > active > connected > idle > offline', (t) => {
  const { store, clock, tick } = makeStore(t);
  register(store, 'agent-a');
  const presence = () => store.presence(store.requireAgent('agent-a'));
  assert.equal(presence(), 'active');
  tick(3 * 60_000);
  assert.equal(presence(), 'idle');
  const session = store.openSession({ transport: 'stdio', agent_id: 'agent-a' });
  assert.equal(presence(), 'connected', 'an open session keeps an agent reachable');
  store.touchAgent('agent-a', clock.now + 10_000);
  assert.equal(presence(), 'listening');
  tick(11_000);
  assert.equal(presence(), 'active');
  tick(3 * 60_000);
  store.heartbeatSessions([session.id]);
  assert.equal(presence(), 'connected');
  store.closeSession(session.id, 'bye');
  assert.equal(presence(), 'idle');
  tick(31 * 60_000);
  assert.equal(presence(), 'offline');
  assert.equal(store.listAgents({ include_offline: false }).length, 0);
  assert.equal(store.stats().agents.offline, 1);
});

test('workspace normalisation: root URIs, backslashes, trailing slashes and case compare equal', () => {
  assert.equal(normalizeWorkspace('file:///c%3A/Users/you/Bruce%20Comm'), 'c:/users/you/bruce comm');
  assert.equal(normalizeWorkspace('C:\\Users\\you\\Bruce Comm\\'), 'c:/users/you/bruce comm');
  assert.equal(normalizeWorkspace('file://localhost/C:/src/app/'), 'c:/src/app');
  assert.equal(normalizeWorkspace('/home/me/repo/'), '/home/me/repo');
  assert.equal(normalizeWorkspace('Shop-Frontend'), 'shop-frontend');
  assert.equal(normalizeWorkspace('   '), null);
  assert.deepEqual(sessionRoutingKeys({ workspaces: ['c:/src/shop-frontend'], label: 'VS Code - Front' }), [
    'c:/src/shop-frontend',
    'shop-frontend',
    'vs code - front',
  ]);
});

test('sessions: to_session / to_workspace pin work to one window; closing a window reroutes its work', (t) => {
  const { store } = makeStore(t);
  register(store, 'vscode-copilot', { max_concurrent_tasks: 10 });
  register(store, 'claude-desktop');
  const w1 = store.openSession({
    transport: 'stdio',
    agent_id: 'vscode-copilot',
    client_name: 'Visual Studio Code',
    client_version: '1.140.0',
    workspaces: ['file:///c%3A/Users/you/Bruce%20Comm'],
  });
  const w2 = store.openSession({ transport: 'stdio', agent_id: 'vscode-copilot', client_name: 'Visual Studio Code', workspaces: ['C:\\work\\frontend\\'] });
  assert.match(w1.id, /^S-[0-9A-Z]{8}$/);
  assert.deepEqual(w1.workspaces, ['c:/users/you/bruce comm']);
  assert.equal(w1.host_pid, process.pid);
  assert.equal(w1.connected, true);
  assert.equal(store.listSessions({ agent_id: 'VSCODE-COPILOT' }).length, 2);
  assert.equal(store.requireAgent('vscode-copilot').connected_sessions, 2);
  assert.deepEqual(store.stats().sessions, { connected: 2, listening: 0 });

  const pinned = sendOne(store, 'claude-desktop', { to_agent: 'vscode-copilot', to_session: w2.id.toLowerCase(), title: 'fix frontend' });
  assert.equal(pinned.to_session, w2.id);
  assert.equal(pinned.to_workspace, 'c:/work/frontend', 'fallback workspace recorded');
  assert.equal(store.claimNext('vscode-copilot', w1.id).task, null);
  assert.equal(store.claimNext('vscode-copilot').task, null, 'no session = no access to pinned work');
  assert.equal(store.pendingCounts('vscode-copilot', w1.id).tasks, 0);
  assert.equal(store.pendingCounts('vscode-copilot', w2.id).tasks, 1);

  const byFolder = sendOne(store, 'claude-desktop', { to_agent: 'vscode-copilot', to_workspace: 'Bruce Comm', title: 'update readme' });
  assert.equal(byFolder.to_workspace, 'bruce comm');
  assert.equal(store.claimNext('vscode-copilot', w2.id).task.id, pinned.id);
  assert.equal(store.claimNext('vscode-copilot', w2.id).task, null, 'w2 does not have "Bruce Comm" open');
  const claimed = store.claimNext('vscode-copilot', w1.id).task;
  assert.equal(claimed.id, byFolder.id);
  assert.equal(claimed.assignee_session, w1.id);

  store.requestInput('vscode-copilot', byFolder.id, 'which section?');
  assert.equal(store.provideInput('claude-desktop', byFolder.id, 'install').to_session, w1.id, 'the answer goes back to the asking window');
  assert.equal(store.claimNext('vscode-copilot', w2.id).task, null);
  assert.equal(store.claimNext('vscode-copilot', w1.id).task.id, byFolder.id);

  const labelled = store.openSession({ transport: 'http', agent_id: 'vscode-copilot', label: 'VS Code - Docs' });
  const byLabel = sendOne(store, 'claude-desktop', { to_agent: 'vscode-copilot', to_workspace: 'vs code - docs', title: 'by label' });
  assert.equal(store.claimNext('vscode-copilot', labelled.id).task.id, byLabel.id);
  const nowhere = store.send('claude-desktop', { to_agent: 'vscode-copilot', to_workspace: 'mobile-app', title: 'nobody has it' });
  assert.match(nowhere.warnings.join(' '), /No connected session of "vscode-copilot" has workspace "mobile-app" open/);

  const second = sendOne(store, 'claude-desktop', { to_agent: 'vscode-copilot', to_session: w2.id, title: 'second' });
  store.closeSession(w2.id, 'window closed');
  const closed = store.getSession(w2.id);
  assert.equal(closed.connected, false);
  assert.equal(closed.close_reason, 'window closed');
  const rerouted = store.requireTask(second.id);
  assert.equal(rerouted.to_session, null);
  assert.equal(rerouted.to_workspace, 'c:/work/frontend');
  assert.ok(events(store, second.id).includes('rerouted'));
  const requeued = store.requireTask(pinned.id);
  assert.equal(requeued.status, 'queued', 'work in progress in the closed window is re-queued');
  assert.equal(requeued.assignee, null);

  assert.throws(() => store.send('claude-desktop', { to_agent: 'vscode-copilot', to_session: w2.id, title: 'x' }), { code: 'session_closed' });
  assert.throws(() => store.send('claude-desktop', { to_agent: 'vscode-copilot', to_session: 'S-NOPE0000', title: 'x' }), (err) => {
    assert.equal(err.code, 'unknown_session');
    assert.match(err.hint, new RegExp(`Connected sessions of "vscode-copilot": .*${w1.id}`));
    return true;
  });
  assert.throws(() => store.send('vscode-copilot', { to_agent: 'claude-desktop', to_session: w1.id, title: 'x' }), { code: 'unknown_session' });
  assert.throws(() => store.send('claude-desktop', { to_agent: '*', to_session: w1.id, title: 'x' }), { code: 'invalid_argument' });
  assert.throws(() => store.send('claude-desktop', { to_skill: 'code', to_workspace: 'x', title: 'x' }), { code: 'invalid_argument' });

  const reopened = store.openSession({ transport: 'http', agent_id: 'vscode-copilot', workspaces: ['c:/work/frontend'] });
  const picked = [store.claimNext('vscode-copilot', reopened.id).task.id, store.claimNext('vscode-copilot', reopened.id).task.id];
  assert.deepEqual(picked.sort(), [pinned.id, second.id].sort(), 'a new window on the same folder picks the rerouted work up');
});

test('sessions: the sweeper closes sessions whose host process is gone; a running host only once it is silent for hours', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'ghost');
  const dead = store.openSession({ transport: 'runner', agent_id: 'ghost', host_pid: deadPid(), workspaces: ['C:\\w\\ghost'] });
  const live = store.openSession({ transport: 'runner', agent_id: 'ghost', host_pid: process.pid, workspaces: ['C:\\w\\ghost'] });
  const a = sendOne(store, 'human', { to_agent: 'ghost', title: 'A', lease_seconds: 3600 });
  const b = sendOne(store, 'human', { to_agent: 'ghost', title: 'B', lease_seconds: 3600 });
  assert.equal(store.claimNext('ghost', dead.id).task.id, a.id);
  assert.equal(store.claimNext('ghost', live.id).task.id, b.id);

  tick(30_000);
  store.sweep();
  assert.equal(store.getSession(dead.id).closed_at, null, 'a fresh heartbeat protects even a dead PID');
  tick(16_000);
  store.sweep();
  assert.equal(store.getSession(dead.id).close_reason, 'host process exited');
  assert.equal(store.requireTask(a.id).status, 'queued');
  assert.equal(store.getSession(live.id).closed_at, null);
  assert.equal(store.requireTask(b.id).status, 'working');
  store.heartbeatSessions([live.id]);
  tick(LIMITS.sessionStaleMs + 1_000);
  store.sweep();
  assert.equal(store.getSession(live.id).closed_at, null, 'a stale heartbeat alone does not close a session whose host runs');
  assert.equal(store.requireTask(b.id).status, 'working');
  assert.equal(store.listSessions().length, 0, 'it is not listed as connected meanwhile');
  tick(LIMITS.sessionHungMs);
  store.sweep();
  assert.equal(store.getSession(live.id).close_reason, 'no heartbeat', 'a host silent for hours is hung');
  assert.equal(store.requireTask(b.id).status, 'queued');
  assert.equal(store.listSessions({ include_closed: true }).length, 2);
});

test('reply routing: replies reach the window that asked, follow-ups the window that worked, notices stay per session', (t) => {
  const { store } = makeStore(t);
  register(store, 'claude-desktop');
  register(store, 'vscode-copilot');
  const desk1 = store.openSession({ transport: 'stdio', agent_id: 'claude-desktop', label: 'research chat' });
  const desk2 = store.openSession({ transport: 'stdio', agent_id: 'claude-desktop', label: 'other chat' });
  const vs1 = store.openSession({ transport: 'stdio', agent_id: 'vscode-copilot', workspaces: ['c:/repo/x'] });
  const vs2 = store.openSession({ transport: 'stdio', agent_id: 'vscode-copilot', workspaces: ['c:/repo/y'] });

  const task = sendOne(store, 'claude-desktop', { to_agent: 'vscode-copilot', title: 'do X' }, { sessionId: desk1.id });
  assert.equal(task.from_session, desk1.id);
  assert.equal(store.claimNext('vscode-copilot', vs2.id).task.assignee_session, vs2.id);

  const reply = sendOne(store, 'vscode-copilot', { to_agent: 'claude-desktop', kind: 'message', title: 're: X', parent_task_id: task.id }, { sessionId: vs2.id });
  assert.equal(reply.to_session, desk1.id, 'reply to the sender -> the session that sent the parent');
  assert.equal(store.takeMessages('claude-desktop', 10, desk2.id).length, 0);
  assert.equal(store.takeMessages('claude-desktop', 10, desk1.id).length, 1);

  const followUp = sendOne(store, 'claude-desktop', { to_agent: 'vscode-copilot', title: 'follow-up', parent_task_id: task.id }, { sessionId: desk1.id });
  assert.equal(followUp.to_session, vs2.id, 'follow-up with the assignee -> the session that worked on the parent');
  assert.equal(followUp.to_workspace, 'c:/repo/y');
  assert.equal(store.claimNext('vscode-copilot', vs1.id).task, null);

  store.requestInput('vscode-copilot', task.id, 'branch?');
  assert.equal(store.pendingCounts('claude-desktop', desk1.id).questions_for_you, 1);
  assert.equal(store.pendingCounts('claude-desktop', desk2.id).questions_for_you, 0, 'only the sending window is asked');
  store.provideInput('claude-desktop', task.id, 'main');
  store.claimNext('vscode-copilot', vs2.id);
  store.complete('vscode-copilot', task.id, 'done');
  assert.equal(store.pendingCounts('claude-desktop', desk1.id).results_ready, 1);
  assert.equal(store.pendingCounts('claude-desktop', desk2.id).results_ready, 0);
  store.closeSession(desk1.id, 'chat closed');
  assert.equal(store.pendingCounts('claude-desktop', desk2.id).results_ready, 1, 'once the sending window is gone, every window sees it');

  store.closeSession(vs2.id, 'window closed');
  const late = store.send('claude-desktop', { to_agent: 'vscode-copilot', title: 'after close', parent_task_id: task.id }, { sessionId: desk2.id });
  assert.equal(late.tasks[0].to_session, null, 'the assignee window is gone ...');
  assert.equal(late.tasks[0].to_workspace, 'c:/repo/y', '... so its workspace is the fallback');
  assert.match(late.warnings.join(' '), /has closed and no connected session has its workspace "c:\/repo\/y" open/, 'the sender is told');
});

test('reply routing to a closed label-only window: the sender is warned and can redirect with to_session', (t) => {
  const { store } = makeStore(t);
  register(store, 'claude-desktop');
  register(store, 'copilot');
  const chat = store.openSession({ transport: 'stdio', agent_id: 'claude-desktop', label: 'Research chat' });
  const vs = store.openSession({ transport: 'stdio', agent_id: 'copilot' });
  const parent = sendOne(store, 'claude-desktop', { to_agent: 'copilot', title: 'do X' }, { sessionId: chat.id });
  store.claimNext('copilot', vs.id);
  store.closeSession(chat.id, 'app restarted');
  const fresh = store.openSession({ transport: 'stdio', agent_id: 'claude-desktop' });

  const reply = store.send('copilot', { to_agent: 'claude-desktop', kind: 'message', title: 're: X', parent_task_id: parent.id }, { sessionId: vs.id });
  assert.deepEqual([reply.tasks[0].to_session, reply.tasks[0].to_workspace], [null, 'research chat'], 'falls back to the closed window\'s label');
  assert.match(reply.warnings.join(' '), /involved in T-\w+ has closed .* "research chat" open; this waits until one does\. To reach another session now, add to_session/);
  assert.equal(store.takeMessages('claude-desktop', 10, fresh.id).length, 0);

  const redirected = store.send('copilot', { to_agent: 'claude-desktop', kind: 'message', title: 're: X', parent_task_id: parent.id, to_session: fresh.id }, { sessionId: vs.id });
  assert.deepEqual(redirected.warnings, []);
  assert.equal(redirected.tasks[0].depth, 1, 'parent_task_id still counts for loop protection');
  assert.equal(store.takeMessages('claude-desktop', 10, fresh.id)[0].id, redirected.tasks[0].id);
});

// ---------------------------------------------------------------- regressions (adversarial review)

test('approval gate: only the human can remove an agent that requires approval (no unregister + re-register bypass)', (t) => {
  const { store } = makeStore(t);
  register(store, 'evil');
  register(store, 'worker', { require_approval: true });
  const held = sendOne(store, 'evil', { to_agent: 'worker', title: 'needs ok' });
  assert.throws(() => store.unregisterAgent('worker'), { code: 'not_allowed', message: /Only the human can remove "worker"/ });
  assert.equal(store.requireAgent('worker').require_approval, true, 'the profile and its gate survive');
  assert.equal(store.requireTask(held.id).status, 'awaiting_approval', 'its held work is untouched');
  assert.equal(sendOne(store, 'evil', { to_agent: 'worker', title: 'again' }).status, 'awaiting_approval');
  assert.deepEqual(store.unregisterAgent('worker', { asHuman: true }), { removed: true, requeued: 0, canceled: 2 });
});

test('sessions: after a sleep / clock jump, sessions of a running host stay open; a host reopens one closed for a missing heartbeat', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'worker');
  const window = store.openSession({ transport: 'stdio', agent_id: 'worker' }); // hosted by this (running) process
  const job = sendOne(store, 'human', { to_agent: 'worker', title: 'long job', lease_seconds: 3600 });
  assert.equal(store.claimNext('worker', window.id).task.id, job.id);

  tick(3 * 60_000); // the laptop slept 3 minutes: on wake a sweep runs before the host's next heartbeat
  store.sweep();
  assert.equal(store.getSession(window.id).closed_at, null, 'not closed while its host process runs');
  assert.equal(store.requireTask(job.id).status, 'working', 'work in progress is not re-queued');
  store.heartbeatSessions([window.id]);
  assert.equal(store.getSession(window.id).connected, true);
  assert.equal(store.complete('worker', job.id, 'done').status, 'completed', 'the worker still reports its result');

  // A host silent for hours is closed after all - and reopens its session when it comes back, re-routing nothing.
  const second = sendOne(store, 'human', { to_agent: 'worker', title: 'second', lease_seconds: LIMITS.maxLeaseSeconds });
  store.claimNext('worker', window.id);
  tick(LIMITS.sessionHungMs + 1_000);
  store.sweep();
  assert.equal(store.getSession(window.id).close_reason, 'no heartbeat');
  assert.equal(store.requireTask(second.id).status, 'queued');
  store.heartbeatSessions([window.id]);
  const revived = store.getSession(window.id);
  assert.deepEqual([revived.closed_at, revived.close_reason, revived.connected, revived.agent_id], [null, null, true, 'worker']);
  assert.equal(store.requireAgent('worker').connected_sessions, 1);
  assert.equal(store.listSessions({ agent_id: 'worker' }).length, 1);
  assert.deepEqual([store.requireTask(second.id).status, store.requireTask(second.id).assignee], ['queued', null], 'nothing re-routed back');
  assert.equal(store.send('human', { to_agent: 'worker', to_session: window.id, title: 'reachable again' }).tasks[0].to_session, window.id);

  // A tool call through the session (touchSession) revives it too; any other close reason is final.
  store.closeSession(window.id, 'no heartbeat');
  store.touchSession(window.id);
  assert.equal(store.getSession(window.id).closed_at, null);
  store.closeSession(window.id, 'closed from the dashboard');
  store.heartbeatSessions([window.id]);
  store.touchSession(window.id);
  assert.equal(store.getSession(window.id).close_reason, 'closed from the dashboard');
});

test('approval gate: work only gated agents could take is held for the human, never stranded in the queue', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'reviewer', { require_approval: true, skills: [{ id: 'code-review' }] });

  // Skill-routed / open work whose only possible takers require approval.
  const bySkill = store.send('sender', { to_skill: 'code-review', title: 'review my PR' });
  assert.equal(bySkill.tasks[0].status, 'awaiting_approval');
  assert.match(bySkill.warnings.join(' '), /Held until the human approves it/);
  assert.equal(sendOne(store, 'sender', { to_agent: '*', title: 'anyone' }).status, 'awaiting_approval', 'every other agent is gated');
  store.approve(bySkill.tasks[0].id);
  assert.equal(store.claimNext('reviewer').task.id, bySkill.tasks[0].id);
  register(store, 'helper', { skills: [{ id: 'code-review' }] });
  assert.equal(sendOne(store, 'sender', { to_skill: 'code-review', title: 'x' }).status, 'queued', 'not held when an ungated agent can take it');

  // A queued task nobody approved (it was queued before its taker turned the gate on): the human can still approve it.
  register(store, 'late', { skills: [{ id: 'docs' }] });
  const docs = sendOne(store, 'sender', { to_skill: 'docs', title: 'write docs' });
  store.updateAgent('late', { require_approval: true });
  assert.equal(store.claimNext('late').task, null);
  assert.equal(store.approve(docs.id).approved_by, 'human');
  assert.equal(store.claimNext('late').task.id, docs.id);
  const fromHuman = sendOne(store, 'human', { to_agent: 'helper', title: 'no approval needed' });
  assert.throws(() => store.approve(fromHuman.id), { code: 'invalid_state' });

  // Direct work in progress when the gate is turned on comes back HELD on every path back to the queue.
  register(store, 'worker', { max_concurrent_tasks: 10 });
  const ids = ['released', 'retried', 'lease ran out', 'answered'].map((title) => sendOne(store, 'sender', { to_agent: 'worker', title, lease_seconds: 60 }).id);
  for (let i = 0; i < ids.length; i++) assert.ok(store.claimNext('worker').task);
  store.updateAgent('worker', { require_approval: true });
  store.release('worker', ids[0]);
  store.fail('worker', ids[1], 'flaky', true);
  store.requestInput('worker', ids[3], 'which one?');
  tick(61_000);
  store.sweep();
  store.provideInput('sender', ids[3], 'that one');
  assert.deepEqual(ids.map((id) => store.requireTask(id).status), Array(4).fill('awaiting_approval'));
  assert.equal(store.pendingCounts('worker').awaiting_approval, 4);
  assert.equal(store.claimNext('worker').task, null);
  for (const id of ids) store.approve(id);
  assert.deepEqual(ids.map(() => store.claimNext('worker').task?.id).sort(), [...ids].sort());
});

test('claims: items the agent may not receive (blocked sender, unapproved) never starve deliverable work queued behind them', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'spammer');
  register(store, 'boss');
  register(store, 'worker');
  for (let i = 0; i < 55; i++) store.send('spammer', { to_agent: 'worker', title: `spam ${i}` });
  tick(LIMITS.rateWindowMs + 1);
  for (let i = 0; i < 45; i++) store.send('spammer', { to_agent: 'worker', kind: 'message', title: `spam note ${i}` });
  store.updateAgent('worker', { accept_from: ['boss'] }, { asHuman: true });
  tick(1);
  const real = sendOne(store, 'boss', { to_agent: 'worker', title: 'real work' });
  const note = sendOne(store, 'boss', { to_agent: 'worker', kind: 'message', title: 'real note' });
  const counts = store.pendingCounts('worker');
  assert.deepEqual([counts.tasks, counts.messages], [1, 1], 'only deliverable items are counted');
  assert.equal(store.claimNext('worker').task.id, real.id);
  assert.deepEqual(store.takeMessages('worker').map((m) => m.id), [note.id]);

  // An agent requiring approval behind 55 unapproved open tasks (an ungated agent could take those).
  register(store, 'gate', { require_approval: true });
  register(store, 'free');
  for (let i = 0; i < 55; i++) store.send('spammer', { to_agent: '*', title: `open ${i}` });
  tick(1);
  const approved = sendOne(store, 'human', { to_agent: 'gate', title: 'from the human' });
  assert.equal(store.pendingCounts('gate').tasks, 1);
  assert.equal(store.claimNext('gate').task.id, approved.id);
});

test('time-based delivery: expires_in_seconds only expires unclaimed work; a claimed task that comes back is kept', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker');
  const asked = sendOne(store, 'sender', { to_agent: 'worker', title: 'question', expires_in_seconds: 300 });
  const retried = sendOne(store, 'sender', { to_agent: 'worker', title: 'retry', expires_in_seconds: 300 });
  tick(10_000);
  store.claimNext('worker');
  store.claimNext('worker');
  store.requestInput('worker', asked.id, 'which file?');
  tick(450_000); // past the deadline
  store.provideInput('sender', asked.id, 'src/a.ts');
  store.fail('worker', retried.id, 'flaky', true);
  assert.equal(store.sweep().expired, 0);
  assert.equal(store.pendingCounts('worker').tasks, 2);
  assert.deepEqual([store.claimNext('worker').task.id, store.claimNext('worker').task.id].sort(), [asked.id, retried.id].sort());
});

test('sessions: a task pinned to a session stays claimable there after the window relabels itself or changes folders', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'claude', { max_concurrent_tasks: 10 });
  const research = store.openSession({ transport: 'stdio', agent_id: 'claude', label: 'Research' });
  const other = store.openSession({ transport: 'stdio', agent_id: 'claude', label: 'Research' });
  const paper = sendOne(store, 'sender', { to_agent: 'claude', to_session: research.id, title: 'paper' });
  assert.equal(paper.to_workspace, 'research', 'fallback recorded');
  store.updateSession(research.id, { label: 'Research - paper review' });
  assert.equal(store.claimNext('claude', other.id).task, null, 'the pin still excludes other windows, even ones matching the fallback');
  assert.equal(store.pendingCounts('claude', research.id).tasks, 1);
  assert.equal(store.claimNext('claude', research.id).task.id, paper.id);

  const shop = store.openSession({ transport: 'stdio', agent_id: 'claude', workspaces: ['C:\\src\\shop'] });
  const fix = sendOne(store, 'sender', { to_agent: 'claude', to_session: shop.id, title: 'fix' });
  store.updateSession(shop.id, { workspaces: ['C:\\src\\shop-v2'] });
  assert.equal(store.claimNext('claude', shop.id).task.id, fix.id);

  // Once the pinned session closes, the fallback workspace applies.
  const later = sendOne(store, 'sender', { to_agent: 'claude', to_session: shop.id, title: 'later' });
  store.closeSession(shop.id, 'window closed');
  assert.equal(store.claimNext('claude', other.id).task, null);
  const v2 = store.openSession({ transport: 'stdio', agent_id: 'claude', workspaces: ['c:/src/shop-v2'] });
  assert.equal(store.claimNext('claude', v2.id).task.id, later.id);
});

test('sessions: send(to_session) sees a session its own sweep just closed; the sweeper un-pins work left on a closed session', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'copilot');
  const killed = store.openSession({ transport: 'stdio', agent_id: 'copilot', host_pid: deadPid(), label: 'frontend' });
  const other = store.openSession({ transport: 'stdio', agent_id: 'copilot', label: 'frontend' });
  tick(60_000); // the killed window's heartbeat is overdue (dead host) but not yet stale
  store.heartbeatSessions([other.id]);
  assert.equal(store.getSession(killed.id).connected, true, 'a snapshot still looks connected');
  assert.throws(() => store.send('sender', { to_agent: 'copilot', to_session: killed.id, title: 'x' }), { code: 'session_closed' });
  assert.equal(store.getSession(killed.id).close_reason, 'host process exited');
  assert.equal(store.listTasks({ to_agent: 'copilot' }).length, 0, 'nothing was pinned to the closed session');

  // Safety net: work still pinned to a closed session (e.g. the close committed elsewhere right after a send).
  const stuck = sendOne(store, 'sender', { to_agent: 'copilot', to_session: other.id, title: 'stuck' });
  store.db.prepare('UPDATE tasks SET to_session=? WHERE id=?').run(killed.id, stuck.id);
  tick(1_000);
  store.sweep();
  assert.equal(store.requireTask(stuck.id).to_session, null);
  assert.ok(events(store, stuck.id).includes('rerouted'));
  assert.equal(store.claimNext('copilot', other.id).task.id, stuck.id);
});

test('input round trip: the resume pin to the asking window ends with the reservation; a pin the sender set stays', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'aa', { skills: [{ id: 'translate' }] });
  register(store, 'bb', { skills: [{ id: 'translate' }] });
  const sa = store.openSession({ transport: 'stdio', agent_id: 'aa' });
  const sb = store.openSession({ transport: 'stdio', agent_id: 'bb' });
  const resumed = (title) => {
    const task = sendOne(store, 'sender', { to_skill: 'translate', title, lease_seconds: 60 });
    assert.equal(store.claimNext('aa', sa.id).task.id, task.id);
    store.requestInput('aa', task.id, 'which language?');
    const back = store.provideInput('sender', task.id, 'German');
    assert.deepEqual([back.to_session, back.resume_session], [sa.id, sa.id], 'the answer goes back to the asking window');
    assert.equal(store.claimNext('bb', sb.id).task, null, 'reserved for that window meanwhile');
    return task.id;
  };

  const released = resumed('released');
  const claimed = store.claimNext('aa', sa.id).task;
  assert.deepEqual([claimed.id, claimed.to_session, claimed.resume_session], [released, null, null], 'the claim ends the reservation');
  store.release('aa', released, 'shutting down, someone else please take it');
  assert.equal(store.claimNext('bb', sb.id).task.id, released);
  store.complete('bb', released, 'done');

  const leased = resumed('lease ran out');
  store.claimNext('aa', sa.id);
  tick(61_000);
  store.sweep();
  assert.equal(store.claimNext('bb', sb.id).task.id, leased);
  store.complete('bb', leased, 'done');

  const retired = resumed('assignee unregistered');
  store.unregisterAgent('aa');
  const requeued = store.requireTask(retired);
  assert.deepEqual([requeued.status, requeued.assignee, requeued.to_session, requeued.resume_session], ['queued', null, null, null]);
  assert.equal(store.claimNext('bb', sb.id).task.id, retired);

  // Direct work: the resume pin must not lock the agent's other windows out after a retry...
  register(store, 'copilot');
  const w1 = store.openSession({ transport: 'stdio', agent_id: 'copilot' });
  const w2 = store.openSession({ transport: 'stdio', agent_id: 'copilot' });
  const direct = sendOne(store, 'sender', { to_agent: 'copilot', title: 'direct' });
  store.claimNext('copilot', w1.id);
  store.requestInput('copilot', direct.id, '?');
  store.provideInput('sender', direct.id, '!');
  store.claimNext('copilot', w1.id);
  store.fail('copilot', direct.id, 'flaky', true);
  assert.equal(store.claimNext('copilot', w2.id).task.id, direct.id);
  store.complete('copilot', direct.id, 'done');
  // ...but a pin the sender chose survives the round trip.
  const pinned = sendOne(store, 'sender', { to_agent: 'copilot', to_session: w1.id, title: 'pinned' });
  store.claimNext('copilot', w1.id);
  store.requestInput('copilot', pinned.id, '?');
  assert.equal(store.provideInput('sender', pinned.id, '!').resume_session, null);
  store.claimNext('copilot', w1.id);
  store.release('copilot', pinned.id);
  assert.equal(store.requireTask(pinned.id).to_session, w1.id);
  assert.equal(store.claimNext('copilot', w2.id).task, null);
});

test('dead-letter: a task whose worker session keeps closing (or whose assignee unregisters) fails after max_attempts', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'worker');
  const poison = sendOne(store, 'sender', { to_agent: 'worker', title: 'crashes its host', max_attempts: 2 });
  let window = store.openSession({ transport: 'stdio', agent_id: 'worker' });
  store.claimNext('worker', window.id);
  store.closeSession(window.id, 'host process exited');
  assert.equal(store.requireTask(poison.id).status, 'queued', 'attempt 1 of 2: re-queued');
  window = store.openSession({ transport: 'stdio', agent_id: 'worker' });
  assert.equal(store.claimNext('worker', window.id).task.attempts, 2);
  store.closeSession(window.id, 'host process exited');
  const failed = store.requireTask(poison.id);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /closed \(host process exited\) during attempt 2 of 2 without completion; giving up/);
  assert.equal(store.claimNext('worker', store.openSession({ transport: 'stdio', agent_id: 'worker' }).id).task, null);

  register(store, 'leaver', { skills: [{ id: 'job' }] });
  const job = sendOne(store, 'sender', { to_skill: 'job', title: 'job', max_attempts: 1 });
  store.claimNext('leaver');
  assert.deepEqual(store.unregisterAgent('leaver'), { removed: true, requeued: 0, canceled: 0 });
  assert.equal(store.requireTask(job.id).status, 'failed');
  assert.match(store.requireTask(job.id).error, /unregistered during attempt 1 of 1; giving up/);
});

test('idempotency: keys never match by prefix, and broadcast retries with non-BMP keys dedupe', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'alice');
  register(store, 'bob');
  const staging = sendOne(store, 'sender', { to_agent: 'alice', title: 'deploy staging', idempotency_key: 'deploy@staging' });
  const deploy = store.send('sender', { to_agent: 'bob', title: 'deploy', idempotency_key: 'deploy' });
  assert.equal(deploy.deduplicated, false, '"deploy" is not a retry of "deploy@staging"');
  assert.notEqual(deploy.tasks[0].id, staging.id);
  assert.equal(deploy.tasks[0].to_agent, 'bob');

  store.send('sender', { kind: 'message', broadcast: true, title: 'hello all', idempotency_key: 'k' });
  const direct = store.send('sender', { to_agent: 'bob', title: 'direct', idempotency_key: 'k@alice' });
  assert.deepEqual([direct.deduplicated, direct.tasks[0].title], [false, 'direct']);

  const rocket = store.send('sender', { kind: 'message', broadcast: true, title: 'release', idempotency_key: 'release-🚀' });
  assert.equal(rocket.tasks.length, 2);
  const retry = store.send('sender', { kind: 'message', broadcast: true, title: 'release', idempotency_key: 'release-🚀' });
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.tasks.map((m) => m.id).sort(), rocket.tasks.map((m) => m.id).sort());
});

test('migration 4: broadcast keys stored as "<key>@<recipient>" become the plain key, so retries after an upgrade still dedupe', (t) => {
  const file = path.join(tempDir('migrate'), 'bruce.db');
  const old = openDatabase(file);
  const before = new BruceStore(old);
  register(before, 'sender');
  register(before, 'alice');
  register(before, 'bob');
  const sent = before.send('sender', { kind: 'message', broadcast: true, title: 'hi', idempotency_key: 'b-1' });
  sendOne(before, 'sender', { to_agent: 'bob', title: 'direct', idempotency_key: 'x@bob' });
  // Turn it back into a version 3 database with the old key scheme.
  old.exec(`DROP INDEX tasks_idempotency;
    UPDATE tasks SET idempotency_key = idempotency_key || '@' || to_agent WHERE broadcast_id IS NOT NULL;
    CREATE UNIQUE INDEX tasks_idempotency ON tasks(from_agent, idempotency_key) WHERE idempotency_key IS NOT NULL;
    ALTER TABLE tasks DROP COLUMN resume_session;
    PRAGMA user_version = 3;`);
  old.close();
  const db = openDatabase(file);
  t.after(() => db.close());
  const store = new BruceStore(db);
  const keys = store.listTasks({ from_agent: 'sender', newest_first: false }).map((x) => x.idempotency_key);
  assert.deepEqual(keys.sort(), ['b-1', 'b-1', 'x@bob'], 'only broadcast copies lose their "@<recipient>" suffix');
  const retry = store.send('sender', { kind: 'message', broadcast: true, title: 'hi', idempotency_key: 'b-1' });
  assert.equal(retry.deduplicated, true);
  assert.deepEqual(retry.tasks.map((m) => m.id).sort(), sent.tasks.map((m) => m.id).sort());
});

test('messages: returnMessages puts messages the agent never saw back in the queue', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  register(store, 'reader');
  register(store, 'other');
  const a = sendOne(store, 'sender', { to_agent: 'reader', kind: 'message', title: 'a' });
  const b = sendOne(store, 'sender', { to_agent: 'reader', kind: 'message', title: 'b', expires_in_seconds: 60 });
  assert.equal(store.takeMessages('reader').length, 2);
  assert.equal(store.returnMessages('other', [a.id]), 0, 'only the recipient can hand a message back');
  assert.equal(store.returnMessages('reader', [a.id.toLowerCase(), b.id, 'M-NOPE000000']), 2);
  const back = store.requireTask(a.id);
  assert.deepEqual([back.status, back.assignee, back.attempts, back.claimed_at, back.completed_at], ['queued', null, 0, null, null]);
  assert.equal(store.pendingCounts('reader').messages, 2);
  assert.equal(store.returnMessages('reader', [a.id]), 0, 'only delivered messages go back');
  assert.deepEqual(store.takeMessages('reader').map((m) => m.id).sort(), [a.id, b.id].sort());
  assert.deepEqual(events(store, a.id), ['created', 'delivered', 'released', 'delivered']);
});

test('sessions: a pin binds only while its window is connected; a stale window whose host still runs lends its work to siblings until it is back', (t) => {
  const { store, tick } = makeStore(t);
  register(store, 'sender');
  register(store, 'copilot', { max_concurrent_tasks: 10 });
  // Every window is hosted by this (running) process: the sweeper keeps a stale one open for hours (hung host, PID reuse).
  const hung = store.openSession({ transport: 'stdio', agent_id: 'copilot', workspaces: ['C:\\src\\shop'] });
  const sibling = store.openSession({ transport: 'stdio', agent_id: 'copilot', workspaces: ['c:/src/shop'] });
  const elsewhere = store.openSession({ transport: 'stdio', agent_id: 'copilot', workspaces: ['c:/src/other'] });
  const counts = (session) => {
    const c = store.pendingCounts('copilot', session.id);
    return [c.tasks, c.messages];
  };
  const first = sendOne(store, 'sender', { to_agent: 'copilot', to_session: hung.id, title: 'first' });
  tick(1);
  const second = sendOne(store, 'sender', { to_agent: 'copilot', to_session: hung.id, title: 'second' });
  const note = sendOne(store, 'sender', { to_agent: 'copilot', to_session: hung.id, kind: 'message', title: 'note' });
  assert.equal(first.to_workspace, 'c:/src/shop', 'fallback workspace recorded');

  // Connected (heartbeat within sessionStaleMs): only the pinned window may take them.
  tick(LIMITS.sessionStaleMs - 1_000);
  store.heartbeatSessions([sibling.id, elsewhere.id]);
  store.sweep();
  assert.equal(store.getSession(hung.id).connected, true);
  assert.deepEqual(counts(sibling), [0, 0], 'a sibling sees nothing pinned to a connected window');
  assert.equal(store.claimNext('copilot', sibling.id).task, null);
  assert.deepEqual(store.takeMessages('copilot', 10, sibling.id), []);

  // Stale while its host runs: the sweeper keeps the row open, but the pin no longer binds.
  tick(2_000);
  store.heartbeatSessions([sibling.id, elsewhere.id]);
  store.sweep();
  assert.deepEqual([store.getSession(hung.id).closed_at, store.getSession(hung.id).connected], [null, false]);
  assert.equal(store.requireTask(second.id).to_session, hung.id, 'the pin itself is kept for when the window is back');
  assert.deepEqual(counts(elsewhere), [0, 0], 'the fallback keeps the workspace recorded at send time');
  assert.equal(store.claimNext('copilot', elsewhere.id).task, null);
  assert.deepEqual(counts(sibling), [2, 1], 'a sibling with that workspace may take them');
  assert.deepEqual(counts(hung), [2, 1], 'the pinned window itself still may (a call through it proves it is alive)');
  assert.throws(() => store.send('sender', { to_agent: 'copilot', to_session: hung.id, title: 'x' }), { code: 'session_closed' });
  const taken = store.claimNext('copilot', sibling.id).task;
  assert.equal(taken.id, first.id);
  assert.deepEqual([taken.assignee_session, taken.to_session], [sibling.id, null], 'a fallback claim releases the pin');
  assert.deepEqual(events(store, first.id), ['created', 'rerouted', 'claimed']);
  assert.deepEqual(store.takeMessages('copilot', 10, sibling.id).map((m) => m.id), [note.id]);

  // The window is back (its host heart-beats again): the pin binds again.
  store.heartbeatSessions([hung.id]);
  assert.deepEqual(counts(sibling), [0, 0]);
  assert.equal(store.claimNext('copilot', sibling.id).task, null, 'bound to the revived window again');
  tick(LIMITS.sessionStaleMs + 1_000);
  store.heartbeatSessions([sibling.id, elsewhere.id]);
  assert.deepEqual(counts(sibling), [1, 0], 'stale again: available to the sibling again');
  store.touchSession(hung.id); // a tool call through the window revives the pin too
  assert.deepEqual(counts(sibling), [0, 0]);
  assert.equal(store.claimNext('copilot', hung.id).task.id, second.id);

  // Resume pins follow the same rule: the answer waits for the asking window only while it is connected.
  store.requestInput('copilot', first.id, 'which branch?');
  const answered = store.provideInput('sender', first.id, 'main');
  assert.deepEqual([answered.to_session, answered.resume_session], [sibling.id, sibling.id]);
  assert.equal(store.claimNext('copilot', hung.id).task, null, 'reserved for the asking window while it is connected');
  tick(LIMITS.sessionStaleMs + 1_000);
  store.heartbeatSessions([hung.id, elsewhere.id]);
  assert.equal(store.claimNext('copilot', elsewhere.id).task, null, 'the asking window is stale: its workspace still applies');
  store.heartbeatSessions([sibling.id]);
  assert.equal(store.claimNext('copilot', hung.id).task, null, 'bound again once the asking window is back');
  tick(LIMITS.sessionStaleMs + 1_000);
  store.heartbeatSessions([hung.id, elsewhere.id]);
  const resumed = store.claimNext('copilot', hung.id).task;
  assert.deepEqual([resumed.id, resumed.to_session, resumed.resume_session], [first.id, null, null], 'another window with the workspace resumes it');

  // A pin without a recorded workspace (the window had neither folders nor a label) falls back to any window.
  const bare = store.openSession({ transport: 'stdio', agent_id: 'copilot' });
  const anywhere = sendOne(store, 'sender', { to_agent: 'copilot', to_session: bare.id, title: 'anywhere' });
  assert.equal(anywhere.to_workspace, null);
  assert.equal(store.claimNext('copilot', elsewhere.id).task, null);
  tick(LIMITS.sessionStaleMs + 1_000);
  store.heartbeatSessions([elsewhere.id]);
  assert.equal(store.claimNext('copilot', elsewhere.id).task.id, anywhere.id);
});

test('input hardening: skill ids, skill / agent tags, to_skill, platform and session labels refuse control characters and < > " `', (t) => {
  const { store } = makeStore(t);
  register(store, 'sender');
  const session = store.openSession({ transport: 'stdio', agent_id: 'sender', label: 'ok' });
  const bad = ['a<b', 'a>b', 'say "hi"', 'run `x`', 'two\nlines', 'tab\there', 'nul\u0000x', 'esc\u001b[31m', 'del\u007fx', 'nel\u0085x', 'ls\u2028x', 'rlo\u202ex'];
  const rejects = (fn, field, value) =>
    assert.throws(fn, (err) => {
      assert.equal(err.code, 'invalid_argument', `${field} ${JSON.stringify(value)}: ${err.message}`);
      assert.ok(err.message.startsWith(`${field} contains a character that is not allowed`), err.message);
      assert.match(err.message, /Allowed: printable characters except < > " and `/);
      assert.ok(!err.message.includes(value), 'the refused value is not echoed back');
      return true;
    });
  for (const value of bad) {
    rejects(() => store.registerAgent({ id: 'newbie', instructions: 'x', platform: value }), 'platform', value);
    rejects(() => store.registerAgent({ id: 'newbie', instructions: 'x', tags: ['ok', value] }), 'tags', value);
    rejects(() => store.registerAgent({ id: 'newbie', instructions: 'x', skills: [{ id: value }] }), 'skills[].id', value);
    rejects(() => store.registerAgent({ id: 'newbie', instructions: 'x', skills: [{ id: 'ok', tags: [value] }] }), 'skills[].tags', value);
    rejects(() => store.updateAgent('sender', { platform: value }), 'platform', value);
    rejects(() => store.updateAgent('sender', { tags: [value] }), 'tags', value);
    rejects(() => store.send('sender', { to_skill: value, title: 'x' }), 'to_skill', value);
    rejects(() => store.openSession({ transport: 'stdio', label: value }), 'session_label', value);
    rejects(() => store.updateSession(session.id, { label: value }), 'session_label', value);
  }
  assert.equal(store.getAgent('newbie'), undefined, 'nothing was registered');
  assert.equal(store.requireAgent('sender').platform, 'other', 'nothing was changed');
  assert.equal(store.getSession(session.id).label, 'ok');
  assert.equal(store.listSessions().length, 1, 'no session was opened');
  assert.equal(store.listTasks().length, 0, 'nothing was queued');

  // Ordinary text passes: punctuation, spaces, non-Latin letters.
  const ok = store.registerAgent({
    id: 'fine',
    instructions: 'x',
    platform: 'VSCode-Copilot',
    tags: ['c++', 'ci/cd', "o'reilly", 'données'],
    skills: [{ id: 'code.review_v2', tags: ['type script', 'node.js (lts)'] }],
  }).agent;
  assert.equal(ok.platform, 'vscode-copilot');
  assert.deepEqual(ok.tags, ['c++', 'ci/cd', "o'reilly", 'données']);
  assert.equal(store.updateSession(session.id, { label: 'VS Code – frontend (main) #2' }).label, 'VS Code – frontend (main) #2');
  assert.equal(sendOne(store, 'sender', { to_skill: 'CI/CD', title: 'x' }).to_skill, 'ci/cd');
});

test('cross-process: workers racing on one database claim every task exactly once, without "database is locked"', async (t) => {
  const { ctx, home } = testContext('store-race');
  t.after(() => ctx.close());
  const workers = ['racer-1', 'racer-2', 'racer-3', 'racer-4'];
  for (const id of workers) register(ctx.store, id, { skills: [{ id: 'job' }], max_concurrent_tasks: 50 });
  const runs = workers.map(
    (id) =>
      new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [fixture('claim-worker.mjs'), home, id], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
        t.after(() => killTree(child.pid));
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
        child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
        child.on('error', reject);
        child.on('close', (code) => resolve({ id, code, stdout, stderr }));
      }),
  );
  // Start line: every worker is up and polling, then all tasks appear at once (one transaction).
  await waitFor(() => ctx.store.listSessions().length === workers.length, { timeout: 15_000, label: 'all workers polling' });
  const sent = transaction(ctx.store.db, () =>
    Array.from({ length: 60 }, (_, i) => sendOne(ctx.store, 'human', { to_skill: 'job', title: `job ${i}` }).id),
  );
  const results = await within(Promise.all(runs), 60_000, 'claim workers');
  const claimed = [];
  for (const r of results) {
    assert.equal(r.code, 0, `${r.id}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.errors, [], `${r.id} saw no errors`);
    claimed.push(...out.claimed);
  }
  assert.ok(results.filter((r) => JSON.parse(r.stdout).claimed.length > 0).length >= 2, 'the workers really competed');
  assert.equal(claimed.length, sent.length, 'no task was claimed twice');
  assert.deepEqual([...claimed].sort(), [...sent].sort(), 'every task was claimed');
  for (const id of sent) {
    const task = ctx.store.requireTask(id);
    assert.equal(task.status, 'completed');
    assert.equal(task.attempts, 1);
    assert.equal(events(ctx.store, id).filter((type) => type === 'claimed').length, 1);
  }
});
