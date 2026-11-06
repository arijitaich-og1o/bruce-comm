// Runner with preset "custom" fake agents (test/fixtures): stdout completion, byte-exact prompt on stdin with shell
// metacharacters, placeholders, timeout / cancel / shutdown killing the process tree, non-zero exits, resultFrom
// "mcp" through the real stdio server, concurrency, and the runner's own store session. Robustness: runs end when the
// CLI exits (leftover pipe holders), request_input ends the run, one run directory per claim, workspace config restored
// after forced exits, runs sharing a workspace config take turns (each sees its own task marker), system tools never
// started from the current directory, preset specifics (runner-task marker,
// Gemini settings precedence, vscode-chat identity).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { bruceServerSpec } from '../dist/clients.js';
import { normalizeWorkspace } from '../dist/store/store.js';
import { buildPrompt } from '../dist/runner/prompt.js';
import { checkRunners, PRESETS, runRunners } from '../dist/runner/runner.js';
import { runProcess } from '../dist/runner/spawn.js';
import { INPUT_GRACE_MS } from '../dist/runner/worker.js';
import {
  BIN,
  IS_WINDOWS,
  alive,
  customRunner,
  fixture,
  killTree,
  runCli,
  tempDir,
  testContext,
  waitFor,
  within,
  writeRunnerConfig,
} from './helpers.mjs';

/**
 * A context + runners.json in a fresh home; the context is closed after the test. The runner agents are registered
 * up front (as if they had run before) so tasks can be addressed to them.
 */
function setup(t, prefix, runners) {
  const env = testContext(prefix);
  t.after(() => env.ctx.close());
  for (const runner of runners) env.ctx.store.registerAgent({ id: runner.agent.id, instructions: 'Registered before the runner starts.' });
  return { ...env, configFile: writeRunnerConfig(env.home, runners) };
}

const METACHARS = 'He said "hi" & echo INJECTED | more %PATH% ^caret !bang! <tag> $HOME `whoami` ;rm -rf /\r\nsecond line\ttab\r\nthird ünïcødé ✓';

test('stdout completion: the prompt reaches stdin byte-exact (shell metacharacters), placeholders and env are filled', async (t) => {
  const capture = tempDir('capture');
  const { ctx, home, configFile } = setup(t, 'runner-stdout', [
    customRunner('echo-worker', 'echo-agent.mjs', {
      argsTail: ['{promptFile}', '{taskId}', '{agentId}', '{cwd}', '{mcpUrl}', '{runDir}'],
      env: { CAPTURE_DIR: capture, EXTRA_VAR: 'task={taskId}' },
      keepRunFiles: true,
    }),
  ]);
  ctx.store.registerAgent({ id: 'echo-worker', instructions: 'Pre-existing profile: the runner updates it.' });
  const id = ctx.store.send('human', { to_agent: 'echo-worker', title: 'Title with "quotes" & pipes |', body: METACHARS }).tasks[0].id;
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once');

  const task = ctx.store.requireTask(id);
  assert.equal(task.status, 'completed', task.error ?? '');
  assert.match(task.result, /^DONE: The following was written by the human operator/);
  assert.equal(task.result_data.runner.preset, 'custom');
  assert.equal(task.result_data.runner.exit_code, 0);
  assert.equal(task.assignee_session, ctx.store.listSessions({ agent_id: 'echo-worker', include_closed: true })[0].id, 'claimed through the runner session');

  const runDir = path.join(home, 'runs', `${id}-1-${task.claimed_at}`);
  const promptFile = path.join(runDir, 'prompt.md');
  const stdin = fs.readFileSync(path.join(capture, 'stdin.bin'));
  assert.ok(stdin.equals(fs.readFileSync(promptFile)), 'stdin bytes equal prompt.md bytes');
  const prompt = stdin.toString('utf8');
  assert.ok(prompt.includes(METACHARS), 'the body with " & | % ^ ! < > $ ` ; CRLF and unicode arrives unchanged');
  assert.ok(prompt.includes('agent_id="echo-worker"') && prompt.includes(`task_id="${id}"`));
  assert.ok(prompt.includes('your final answer is recorded as the task result'));
  assert.ok(prompt.includes(`Do not call get_next_task: this run handles only task ${id}. If you need information, call request_input and then stop`));

  const { argv, cwd, env } = JSON.parse(fs.readFileSync(path.join(capture, 'argv.json'), 'utf8'));
  assert.deepEqual(argv.slice(0, 3), [promptFile, id, 'echo-worker']);
  assert.ok(argv.every((arg) => !arg.includes('INJECTED')), 'task text never reaches argv');
  assert.equal(path.resolve(cwd), path.resolve(home, 'work', 'echo-worker'), 'default cwd');
  assert.equal(argv[3], cwd);
  assert.match(argv[4], new RegExp(`^http://127\\.0\\.0\\.1:\\d+/mcp\\?agent=echo-worker&runner_task=${id}$`), "{mcpUrl} is this run's URL");
  assert.equal(argv[5], runDir);
  assert.deepEqual(env, { NO_COLOR: '1', EXTRA: `task=${id}` });

  const mcpConfig = JSON.parse(fs.readFileSync(path.join(runDir, 'mcp-config.json'), 'utf8')).mcpServers['bruce-comm'];
  assert.equal(mcpConfig.command, process.execPath);
  assert.deepEqual(mcpConfig.args, [BIN, 'stdio', '--agent-id', 'echo-worker', '--runner-task', id], 'marked as a one-shot runner child');
  assert.equal(mcpConfig.env.BRUCE_COMM_RUNNER_TASK, id);
  assert.equal(mcpConfig.env.BRUCE_COMM_HOME, home);
  const agent = ctx.store.requireAgent('echo-worker');
  assert.equal(agent.metadata.runner.preset, 'custom');
  assert.equal(agent.platform, 'custom');
  assert.equal(agent.instructions, 'Test agent started by the Bruce Comm test suite.', 'the configured profile replaces the old one');
  assert.equal(ctx.store.listAgents().length, 1, 'updated, not duplicated');
});

test('non-zero exit fails the task with the exit code and stderr tail; retryOnFailure re-queues; run files are removed', async (t) => {
  const { ctx, home, configFile } = setup(t, 'runner-fail', [customRunner('failer', 'fail-agent.mjs')]);
  const id = ctx.store.send('human', { to_agent: 'failer', title: 'please fail' }).tasks[0].id;
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once');
  const task = ctx.store.requireTask(id);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /exited with code 3/);
  assert.match(task.error, /model quota exceeded/);
  assert.deepEqual(fs.readdirSync(path.join(home, 'runs')), [], 'run directory cleaned up (keepRunFiles=false)');

  writeRunnerConfig(home, [customRunner('failer', 'fail-agent.mjs', { retryOnFailure: true })]);
  const retried = ctx.store.send('human', { to_agent: 'failer', title: 'retry me', max_attempts: 2 }).tasks[0].id;
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once (1)');
  assert.equal(ctx.store.requireTask(retried).status, 'queued');
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once (2)');
  const final = ctx.store.requireTask(retried);
  assert.deepEqual([final.status, final.attempts], ['failed', 2]);
});

test('timeout kills the whole process tree and fails the task', async (t) => {
  const pidFile = path.join(tempDir('pids'), 'timeout.json');
  const { ctx, configFile } = setup(t, 'runner-timeout', [customRunner('sleepy', 'sleep-agent.mjs', { timeoutSeconds: 1, env: { PID_FILE: pidFile } })]);
  const id = ctx.store.send('human', { to_agent: 'sleepy', title: 'sleep please' }).tasks[0].id;
  const started = Date.now();
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once');
  const elapsed = Date.now() - started;
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => [pids.child, pids.grandchild].forEach(killTree));
  await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), { timeout: 5000, label: 'process tree killed' });
  const task = ctx.store.requireTask(id);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /Timed out after 1s/);
  assert.ok(elapsed < 10_000, `stopped soon after the 1 s timeout (${elapsed} ms)`);
});

test('resultFrom "mcp": the agent reports through the real stdio MCP server; forgetting to report fails the task', async (t) => {
  const { ctx, home, configFile } = setup(t, 'runner-mcp', [
    customRunner('mcp-worker', 'mcp-agent.mjs', { argsTail: ['{mcpConfigFile}', '{taskId}', '{agentId}'], resultFrom: 'mcp', timeoutSeconds: 60 }),
  ]);
  const id = ctx.store.send('human', { to_agent: 'mcp-worker', title: 'report via mcp', body: 'Do it via MCP.' }).tasks[0].id;
  await within(runRunners(ctx, { configFile, once: true }), 30_000, 'runner --once (mcp)');
  const task = ctx.store.requireTask(id);
  assert.equal(task.status, 'completed', task.error ?? '');
  assert.match(task.result, /^MCP-DONE \(33 tools, prompt \d+ chars\)$/);
  assert.equal(task.result_data, null, 'the runner does not overwrite a result reported via MCP');
  const events = ctx.store.getEvents(id);
  assert.ok(events.some((e) => e.type === 'progress' && e.actor === 'mcp-worker' && e.message === 'halfway'));
  const sessions = ctx.store.listSessions({ agent_id: 'mcp-worker', include_closed: true });
  assert.deepEqual(sessions.map((s) => s.transport).sort(), ['runner', 'stdio'], 'the spawned CLI\'s stdio connection is a second session');
  assert.ok(sessions.every((s) => s.closed_at !== null), 'both closed afterwards');

  writeRunnerConfig(home, [customRunner('silent', 'mcp-silent-agent.mjs', { resultFrom: 'mcp' })]);
  ctx.store.registerAgent({ id: 'silent', instructions: 'x' });
  const silent = ctx.store.send('human', { to_agent: 'silent', title: 'forget to report' }).tasks[0].id;
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once (silent)');
  const failed = ctx.store.requireTask(silent);
  assert.equal(failed.status, 'failed');
  assert.match(failed.error, /without calling complete_task/);
});

test('end to end: the CLI the runner starts gets a one-shot runner session (no get_next_task nudges, get_next_task refused)', async (t) => {
  const probeFile = path.join(tempDir('probe'), 'probe.json');
  const { ctx, configFile } = setup(t, 'runner-child', [
    customRunner('child-worker', 'mcp-agent.mjs', {
      argsTail: ['{mcpConfigFile}', '{taskId}', '{agentId}'],
      resultFrom: 'mcp',
      timeoutSeconds: 60,
      env: { PROBE_FILE: probeFile },
    }),
  ]);
  const id = ctx.store.send('human', { to_agent: 'child-worker', title: 'the run\'s task', priority: 9 }).tasks[0].id;
  const other = ctx.store.send('human', { to_agent: 'child-worker', title: 'waits for its own run', priority: 1 }).tasks[0].id;
  await within(runRunners(ctx, { configFile, once: true }), 30_000, 'runner --once (runner child)');
  assert.equal(ctx.store.requireTask(id).status, 'completed', ctx.store.requireTask(id).error ?? '');

  const probe = JSON.parse(fs.readFileSync(probeFile, 'utf8'));
  assert.match(probe.instructions, new RegExp(`one-shot session started by the Bruce Comm runner for task ${id}`));
  assert.doesNotMatch(probe.instructions, /call get_next_task again/, 'no work loop in the instructions');
  for (const reply of [probe.progress, probe.complete]) {
    assert.match(reply, /"tasks": 1/, 'another task is waiting for the runner agent...');
    assert.doesNotMatch(reply, /get_next_task/, '... but the one-shot CLI is never told to fetch it');
  }
  assert.match(probe.complete, /This one-shot run is done: stop now\./);
  assert.equal(probe.nextIsError, true, probe.next);
  assert.match(probe.next, new RegExp(`one-shot runner session: report on task ${id} and stop`));
  const waiting = ctx.store.requireTask(other);
  assert.deepEqual([waiting.status, waiting.attempts], ['queued', 0], 'the CLI claimed nothing outside the runner');
  assert.ok(!ctx.store.getEvents(other).some((e) => e.type === 'claimed'));
});

test('cancel from another process kills the running agent; shutdown marks the runner agent offline', async (t) => {
  const pidFile = path.join(tempDir('pids'), 'cancel.json');
  const { ctx, home, logs, configFile } = setup(t, 'runner-cancel', [customRunner('sleepy', 'sleep-agent.mjs', { timeoutSeconds: 120, env: { PID_FILE: pidFile } })]);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const id = ctx.store.send('human', { to_agent: 'sleepy', title: 'long job' }).tasks[0].id;
  const running = runRunners(ctx, { configFile, signal: stop.signal });
  await waitFor(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, { timeout: 10_000, label: 'agent started' });
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => [pids.child, pids.grandchild].forEach(killTree));
  assert.ok(alive(pids.child) && alive(pids.grandchild));

  const cli = await runCli(['cancel', id, '--reason', 'changed my mind'], { env: { BRUCE_COMM_HOME: home } });
  assert.equal(cli.code, 0, cli.stderr);
  await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), { timeout: 8000, label: 'agent tree killed after the cancel' });
  await waitFor(() => logs.some((l) => l.includes(id) && /canceled/.test(l)), { label: 'runner noticed the cancel' });
  stop.abort();
  await within(running, 10_000, 'runner shutdown');
  assert.equal(ctx.store.requireTask(id).status, 'canceled');
  const agent = ctx.store.requireAgent('sleepy');
  assert.equal(agent.status, 'offline');
  assert.match(agent.status_message, /Runner stopped/);
});

test('shutdown hands the in-flight task back unchanged and kills the agent', async (t) => {
  const pidFile = path.join(tempDir('pids'), 'shutdown.json');
  const { ctx, configFile } = setup(t, 'runner-shutdown', [customRunner('sleepy', 'sleep-agent.mjs', { timeoutSeconds: 120, env: { PID_FILE: pidFile } })]);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const id = ctx.store.send('human', { to_agent: 'sleepy', title: 'long job' }).tasks[0].id;
  const running = runRunners(ctx, { configFile, signal: stop.signal });
  await waitFor(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, { timeout: 10_000, label: 'agent started' });
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => [pids.child, pids.grandchild].forEach(killTree));
  stop.abort();
  await within(running, 10_000, 'runner shutdown');
  await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), { timeout: 5000, label: 'agent tree killed' });
  const task = ctx.store.requireTask(id);
  assert.deepEqual([task.status, task.attempts, task.assignee], ['queued', 0, null]);
});

test('runner session: one session (workspace = cwd) shared by concurrent runs, routed work only, closed on shutdown', async (t) => {
  const cwd = path.join(tempDir('ws'), 'FrontEnd');
  fs.mkdirSync(cwd);
  const { ctx, logs, configFile } = setup(t, 'runner-session', [
    customRunner('duo', 'slow-agent.mjs', { argsTail: ['{taskId}'], concurrency: 2, cwd, env: { SLOW_MS: '1500' } }),
  ]);
  const stop = new AbortController();
  t.after(() => stop.abort());
  ctx.store.registerAgent({ id: 'duo', instructions: 'x', max_concurrent_tasks: 1 });
  const running = runRunners(ctx, { configFile, signal: stop.signal });
  const session = await waitFor(() => ctx.store.listSessions({ agent_id: 'duo' })[0], { label: 'runner session' });
  assert.equal(session.transport, 'runner');
  assert.equal(session.client_name, 'bruce-comm-runner');
  assert.equal(session.label, 'custom runner');
  assert.deepEqual(session.workspaces, [normalizeWorkspace(cwd)]);
  assert.equal(session.host_pid, process.pid);
  await waitFor(() => ctx.store.getSession(session.id).listening, { label: 'runner session listening' });
  assert.equal(ctx.store.presence(ctx.store.requireAgent('duo')), 'listening');
  assert.equal(ctx.store.requireAgent('duo').max_concurrent_tasks, 2, 'max_concurrent_tasks follows the runner concurrency');

  const send = (title, extra) => ctx.store.send('human', { to_agent: 'duo', title, ...extra });
  const other = send('pinned to another workspace', { to_workspace: 'C:\\repos\\backend' });
  assert.match(other.warnings.join(' '), /No connected session of "duo" has workspace/);
  ctx.store.send('human', { to_agent: 'duo', kind: 'message', title: 'FYI: hello runner', body: 'just saying hi' });
  const started = Date.now();
  const byPath = send('by path', { to_workspace: cwd.replace(/\//g, '\\') }).tasks[0].id;
  const byName = send('by folder name', { to_workspace: 'frontend' }).tasks[0].id;
  await waitFor(() => [byPath, byName].every((id) => ctx.store.requireTask(id).status === 'completed'), { timeout: 15_000, label: 'two parallel tasks' });
  const elapsed = Date.now() - started;
  // One after the other they would need more than 2 x 1500 ms, however fast the machine is.
  assert.ok(elapsed < 3000, `two 1.5 s tasks ran in parallel (${elapsed} ms)`);
  const bySession = send('by session id', { to_session: session.id }).tasks[0].id;
  await waitFor(() => ctx.store.requireTask(bySession).status === 'completed', { timeout: 10_000, label: 'session-pinned task' });
  for (const id of [byPath, byName, bySession]) assert.equal(ctx.store.requireTask(id).assignee_session, session.id);
  assert.match(ctx.store.requireTask(byPath).result, /^SLOW-DONE T-/);
  assert.ok(logs.some((l) => l.includes('message M-') && l.includes('FYI: hello runner')), 'messages are delivered and logged');

  const otherTask = ctx.store.requireTask(other.tasks[0].id);
  assert.deepEqual([otherTask.status, otherTask.assignee], ['queued', null], 'work pinned elsewhere is left alone');
  assert.equal(ctx.store.pendingCounts('duo', session.id).tasks, 0, 'nothing claimable for the runner (no busy loop)');
  assert.equal(logs.filter((l) => / claimed T-/.test(l)).length, 3);
  assert.equal(ctx.store.listSessions({ agent_id: 'duo' }).filter((s) => s.transport === 'runner').length, 1, 'concurrency 2 shares ONE session');

  stop.abort();
  await within(running, 10_000, 'runner shutdown');
  const closed = ctx.store.getSession(session.id);
  assert.equal(closed.close_reason, 'runner stopped');
  assert.equal(ctx.store.listSessions({ agent_id: 'duo' }).length, 0);
});

test('a hard-killed runner process is recovered by the next runner start: dead session closed, task taken over', async (t) => {
  const pidFile = path.join(tempDir('pids'), 'crash.json');
  const { ctx, home, logs, configFile } = setup(t, 'runner-crash', [customRunner('phoenix', 'sleep-agent.mjs', { timeoutSeconds: 300, env: { PID_FILE: pidFile } })]);
  ctx.store.registerAgent({ id: 'phoenix', instructions: 'x' });
  const id = ctx.store.send('human', { to_agent: 'phoenix', title: 'survive a crash', lease_seconds: 3600 }).tasks[0].id;
  const child = spawn(process.execPath, [BIN, 'runner', '--config', configFile], {
    env: { ...process.env, BRUCE_COMM_HOME: home },
    stdio: ['ignore', 'ignore', 'pipe'],
    windowsHide: true,
  });
  t.after(() => killTree(child.pid));
  const claimed = await waitFor(() => {
    const task = ctx.store.requireTask(id);
    return task.status === 'working' && task.assignee_session ? task : null;
  }, { timeout: 15_000, label: 'the child runner to claim the task' });
  const session = ctx.store.requireSession(claimed.assignee_session);
  assert.equal(session.host_pid, child.pid);
  await waitFor(() => fs.existsSync(pidFile) && fs.statSync(pidFile).size > 0, { timeout: 10_000, label: 'agent started' });
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => [pids.child, pids.grandchild].forEach(killTree));

  killTree(child.pid); // like taskkill /F: no shutdown code runs
  await waitFor(() => !alive(child.pid), { timeout: 5000, label: 'runner process gone' });
  assert.equal(ctx.store.getSession(session.id).closed_at, null, 'its session still looks open');

  writeRunnerConfig(home, [customRunner('phoenix', 'echo-agent.mjs')]);
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'restarted runner');
  const task = ctx.store.requireTask(id);
  assert.ok(logs.some((l) => l.includes(`closed session ${session.id} of an earlier runner process (pid ${child.pid} is gone)`) && l.includes(id)));
  assert.equal(task.status, 'completed');
  assert.equal(task.attempts, 2, 'the crashed attempt counts');
  assert.notEqual(task.assignee_session, session.id);
  assert.equal(ctx.store.getSession(session.id).close_reason, 'host process exited');
});

test('invalid runner configs are reported clearly', async (t) => {
  const { ctx, configFile } = setup(t, 'runner-config', []);
  fs.writeFileSync(configFile, JSON.stringify({ runners: [{ agent: { id: 'Bad Id!' }, preset: 'nope', timeoutSeconds: -1, typo: 1 }] }));
  await assert.rejects(runRunners(ctx, { configFile, once: true }), (err) => err.code === 'invalid_runner_config' && /preset/.test(err.message) && /typo/.test(err.message));
  fs.writeFileSync(configFile, JSON.stringify({ runners: [{ agent: { id: 'Bad Id!' }, preset: 'custom' }] }));
  await assert.rejects(runRunners(ctx, { configFile, once: true }), (err) => /Invalid agent id/i.test(err.message) && /command: required/.test(err.message));
  writeRunnerConfig(path.dirname(configFile), [customRunner('nobin', 'echo-agent.mjs', { command: 'definitely-not-a-command-xyz' })]);
  await assert.rejects(runRunners(ctx, { configFile, once: true }), { code: 'no_runners' });
  writeRunnerConfig(path.dirname(configFile), [{ ...customRunner('off', 'echo-agent.mjs'), enabled: false }]);
  await assert.rejects(runRunners(ctx, { configFile, once: true }), { code: 'no_runners', message: /No enabled runner/ });
  await assert.rejects(runRunners(ctx, { configFile: `${configFile}.missing`, once: true }), { code: 'no_runner_config' });
});

// ---------------------------------------------------------------- robustness regressions

test('a CLI that exits while a background process it started still holds stdout: the run ends at exit with the real result', async (t) => {
  // Regression: the run only ended on 'close', which waits for every holder of the pipe - the task stayed "working"
  // (lease renewed, slot taken) until the helper exited, and was then failed as "Timed out" despite a clean answer.
  const pidFile = path.join(tempDir('pids'), 'orphan.json');
  const { ctx, configFile } = setup(t, 'runner-orphan', [
    customRunner('orphaner', 'orphan-agent.mjs', { timeoutSeconds: 8, env: { PID_FILE: pidFile, HELPER_MS: '30000' } }),
  ]);
  const id = ctx.store.send('human', { to_agent: 'orphaner', title: 'answer, and leave a daemon behind' }).tasks[0].id;
  const started = Date.now();
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once');
  const elapsed = Date.now() - started;
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => [pids.child, pids.helper].forEach(killTree));
  assert.ok(alive(pids.helper), 'the background helper is still running and holding the pipes');
  const task = ctx.store.requireTask(id);
  assert.equal(task.status, 'completed', task.error ?? '');
  assert.equal(task.result, 'ANSWER: done');
  assert.equal(task.result_data.runner.exit_code, 0);
  assert.ok(elapsed < 8000, `done shortly after the CLI exited, before the 8 s timeout (${elapsed} ms)`);
});

test('runProcess: a timeout ends the run even when a descendant that escaped the tree kill keeps the pipes open', async (t) => {
  // The CLI starts a helper through an intermediate process that exits at once, so taskkill /T (or the POSIX process
  // group kill) cannot reach it; the helper inherits stdout / stderr. Then the CLI hangs.
  const dir = tempDir('escape');
  const pidFile = path.join(dir, 'pids.json');
  const cli = path.join(dir, 'cli.mjs');
  const middle = path.join(dir, 'middle.cjs');
  fs.writeFileSync(
    middle,
    "const helper = require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], " +
      "{ stdio: ['ignore', 'inherit', 'inherit'], detached: true, windowsHide: true });\n" +
      "helper.unref();\nrequire('node:fs').writeFileSync(process.argv[2], JSON.stringify({ helper: helper.pid }));\n",
  );
  fs.writeFileSync(
    cli,
    "import { spawnSync } from 'node:child_process';\n" +
      "spawnSync(process.execPath, [process.argv[2], process.argv[3]], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });\n" +
      "process.stdout.write('working...\\n');\nsetInterval(() => {}, 1000);\n",
  );
  const started = Date.now();
  const proc = runProcess({
    command: { file: process.execPath, prefixArgs: [cli], env: {}, unsetEnv: [], via: 'test' },
    args: [middle, pidFile],
    cwd: dir,
    timeoutMs: 1500,
  });
  t.after(() => killTree(proc.pid));
  const outcome = await within(proc.done, 15_000, 'the timed-out run to settle');
  const { helper } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => killTree(helper));
  assert.ok(alive(helper), 'the escaped helper still holds the pipes');
  assert.equal(outcome.timedOut, true);
  assert.equal(outcome.killedReason, 'timeout');
  assert.match(outcome.stdout, /working\.\.\./, 'output captured before the timeout is kept');
  assert.ok(Date.now() - started < 12_000, `settled soon after the timeout, not when the helper exits (${Date.now() - started} ms)`);
});

test('request_input ends the run after a short grace without reporting; the answer starts a new run (one run directory per claim)', async (t) => {
  const pidFile = path.join(tempDir('pids'), 'ask.json');
  const { ctx, home, logs, configFile } = setup(t, 'runner-ask', [
    customRunner('asker', 'ask-agent.mjs', {
      argsTail: ['{mcpConfigFile}', '{promptFile}', '{taskId}', '{agentId}'],
      timeoutSeconds: 120,
      keepRunFiles: true,
      env: { PID_FILE: pidFile, LINGER_MS: '60000', RESUME_DELAY_MS: '0' },
    }),
  ]);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const id = ctx.store.send('human', { to_agent: 'asker', title: 'configure the server' }).tasks[0].id;
  const running = runRunners(ctx, { configFile, signal: stop.signal });
  await waitFor(() => ctx.store.requireTask(id).status === 'input_required', { timeout: 20_000, label: 'the question' });
  const askedAt = Date.now();
  const { child } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => killTree(child));
  // The CLI goes on running (like one that keeps polling): the runner ends it, so the slot is free for the resume.
  await waitFor(() => !alive(child), { timeout: INPUT_GRACE_MS + 10_000, label: 'the asking run to be ended' });
  assert.ok(Date.now() - askedAt < INPUT_GRACE_MS + 6000, 'ended after the grace period, not at the 120 s timeout');
  await waitFor(() => logs.some((l) => l.includes(id) && /the agent reported "input_required"/.test(l)), { label: 'the run to finish' });
  let task = ctx.store.requireTask(id);
  assert.deepEqual([task.status, task.error], ['input_required', null], 'the ended run reported nothing');
  assert.ok(logs.some((l) => l.includes(id) && /asked for input - ending the run/.test(l)));

  ctx.store.provideInput('human', id, 'Use ANSWER-42.');
  await waitFor(() => ctx.store.requireTask(id).status === 'completed', { timeout: 20_000, label: 'the resumed run' });
  task = ctx.store.requireTask(id);
  assert.equal(task.result, 'RESUMED with ANSWER-42');
  assert.equal(task.attempts, 1, 'the resume did not use up an attempt');
  const dirs = fs.readdirSync(path.join(home, 'runs')).filter((d) => d.startsWith(`${id}-1-`));
  assert.equal(dirs.length, 2, `one run directory per claim, though the attempt number is the same: ${dirs.join(', ')}`);
  const outputs = dirs.map((d) => fs.readFileSync(path.join(home, 'runs', d, 'stdout.txt'), 'utf8'));
  assert.ok(outputs.some((o) => o.startsWith('asked a question (isError=false)')), 'the asking run kept its own output');
  assert.ok(outputs.some((o) => o.startsWith('RESUMED')));
  stop.abort();
  await within(running, 10_000, 'runner shutdown');
});

test('concurrency 2: an answer that arrives while the asking CLI still runs ends that run at once; the new run keeps its own files', async (t) => {
  // Regression: both claims used runs/<task>-<attempt>; the older run, killed as "claimed again", deleted the shared
  // directory (prompt, MCP config) while the resumed CLI was starting, and the task failed.
  const pidFile = path.join(tempDir('pids'), 'ask2.json');
  const { ctx, home, configFile } = setup(t, 'runner-rundir', [
    customRunner('asker2', 'ask-agent.mjs', {
      argsTail: ['{mcpConfigFile}', '{promptFile}', '{taskId}', '{agentId}'],
      concurrency: 2,
      timeoutSeconds: 120,
      env: { PID_FILE: pidFile, LINGER_MS: '60000', RESUME_DELAY_MS: '1500' },
    }),
  ]);
  const stop = new AbortController();
  t.after(() => stop.abort());
  const id = ctx.store.send('human', { to_agent: 'asker2', title: 'configure the server' }).tasks[0].id;
  const running = runRunners(ctx, { configFile, signal: stop.signal });
  await waitFor(() => ctx.store.requireTask(id).status === 'input_required', { timeout: 20_000, interval: 10, label: 'the question' });
  ctx.store.provideInput('human', id, 'Use ANSWER-42.');
  const answeredAt = Date.now();
  const { child } = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => killTree(child));
  await waitFor(() => !alive(child), { timeout: 5000, label: 'the asking run to be ended at once' });
  await waitFor(() => ['completed', 'failed'].includes(ctx.store.requireTask(id).status), { timeout: 20_000, label: 'the resumed run' });
  const task = ctx.store.requireTask(id);
  assert.equal(task.status, 'completed', task.error ?? '');
  assert.equal(task.result, 'RESUMED with ANSWER-42');
  assert.ok(Date.now() - answeredAt < INPUT_GRACE_MS, 'resumed without waiting for the grace period');
  stop.abort();
  await within(running, 10_000, 'runner shutdown');
  assert.deepEqual(fs.readdirSync(path.join(home, 'runs')), [], 'every run removed only its own directory');
});

/** A cursor-agent runner (fake CLI) on `repo`, whose .cursor/mcp.json belongs to the user. */
function cursorSetup(t, prefix, script, original) {
  const repo = path.join(tempDir('repo'), 'my repo');
  const userFile = path.join(repo, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, original);
  const pidFile = path.join(tempDir('pids'), 'cursor.json');
  const runner = { agent: { id: 'cursor-runner', instructions: 'Cursor runner.' }, preset: 'cursor-agent', command: fixture(script), cwd: repo, timeoutSeconds: 120, env: { PID_FILE: pidFile } };
  const env = setup(t, prefix, [runner]);
  t.after(() => {
    try {
      const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
      [pids.child, pids.grandchild].forEach(killTree);
    } catch {
      // the fake CLI never started
    }
  });
  return { ...env, repo, userFile, pidFile };
}

const USER_CURSOR_CONFIG = `${JSON.stringify(
  { mcpServers: { 'my-own-server': { command: 'x' }, 'bruce-comm': { command: 'node', args: ['bruce-comm.js', 'stdio'], env: { BRUCE_AGENT_ID: 'cursor' } } } },
  null,
  2,
)}\n`;

test("cursor-agent: the user's .cursor/mcp.json is restored after a second Ctrl+C, and after a hard kill by the next runner start", async (t) => {
  const { ctx, home, logs, configFile, userFile } = cursorSetup(t, 'runner-cursor-exit', 'sleep-agent.mjs', USER_CURSOR_CONFIG);
  const id = ctx.store.send('human', { to_agent: 'cursor-runner', title: 'edit something' }).tasks[0].id;

  // 1. Second Ctrl+C: the runner exits at once (130) - its forced-exit path restores the file.
  const forced = spawn(process.execPath, [fixture('force-exit-runner.mjs'), home, configFile, userFile], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
  t.after(() => killTree(forced.pid));
  let stderr = '';
  forced.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
  const code = await within(new Promise((resolve) => forced.on('close', resolve)), 30_000, 'the force-exited runner');
  assert.equal(code, 130, stderr);
  assert.equal(fs.readFileSync(userFile, 'utf8'), USER_CURSOR_CONFIG, 'restored on the forced exit');
  assert.equal(ctx.store.requireTask(id).status, 'queued', 'the task was handed back');

  // 2. Hard kill (taskkill /F: no exit code runs). The restore record it left lets the next start put the file back.
  const child = spawn(process.execPath, [BIN, 'runner', '--config', configFile], {
    env: { ...process.env, BRUCE_COMM_HOME: home },
    stdio: ['ignore', 'ignore', 'ignore'],
    windowsHide: true,
  });
  t.after(() => killTree(child.pid));
  await waitFor(() => fs.readFileSync(userFile, 'utf8').includes('--runner-task'), { timeout: 20_000, label: 'the runner entry merged in' });
  killTree(child.pid);
  await waitFor(() => !alive(child.pid), { timeout: 5000, label: 'runner process gone' });
  assert.notEqual(fs.readFileSync(userFile, 'utf8'), USER_CURSOR_CONFIG, 'left modified by the killed runner');
  const records = () => fs.readdirSync(path.join(home, 'runs')).filter((n) => n.startsWith('workspace-restore-'));
  assert.equal(records().length, 1, 'a restore record survived the kill');
  ctx.store.cancel('human', id, 'nothing more to do');
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'the next runner start');
  assert.equal(fs.readFileSync(userFile, 'utf8'), USER_CURSOR_CONFIG, 'restored by the next start');
  assert.deepEqual(records(), []);
  assert.ok(logs.some((l) => l.includes(`restored ${userFile}`)));
});

test('cursor-agent: a runner entry left in .cursor/mcp.json without a restore record is not restored as the user\'s own', async (t) => {
  const leftover = {
    mcpServers: {
      'my-own-server': { command: 'x' },
      'bruce-comm': { command: 'node', args: ['bruce-comm.js', 'stdio', '--agent-id', 'cursor-runner', '--runner-task', 'T-OLDRUN0000'] },
    },
  };
  const { ctx, configFile, userFile } = cursorSetup(t, 'runner-cursor-leftover', 'echo-agent.mjs', JSON.stringify(leftover));
  ctx.store.send('human', { to_agent: 'cursor-runner', title: 'edit something' });
  await within(runRunners(ctx, { configFile, once: true }), 20_000, 'runner --once');
  assert.deepEqual(JSON.parse(fs.readFileSync(userFile, 'utf8')), { mcpServers: { 'my-own-server': { command: 'x' } } });
});

/**
 * A fake cursor-agent: reads the bruce-comm entry of <cwd>/.cursor/mcp.json when it starts and again before it ends
 * ($HOLD_FILE ms later), logs both task markers with its own task id (the last argument, from extraArgs {taskId}) to
 * $LOG_FILE, and prints a Cursor-style JSON result.
 */
const FAKE_CURSOR = `import fs from 'node:fs';
import path from 'node:path';
const own = process.argv[process.argv.length - 1];
const marker = () => {
  const entry = JSON.parse(fs.readFileSync(path.join(process.cwd(), '.cursor', 'mcp.json'), 'utf8')).mcpServers['bruce-comm'];
  return [entry.args[entry.args.indexOf('--runner-task') + 1], entry.env?.BRUCE_COMM_RUNNER_TASK];
};
const log = (record) => fs.appendFileSync(process.env.LOG_FILE, JSON.stringify({ own, pid: process.pid, ...record, at: Date.now() }) + '\\n');
const before = marker();
log({ phase: 'start', marker: before });
await new Promise((resolve) => setTimeout(resolve, Number(fs.readFileSync(process.env.HOLD_FILE, 'utf8'))));
const after = marker();
log({ phase: 'end', marker: after });
process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'own=' + own + ' seen=' + [...before, ...after].join(',') }) + '\\n');
`;

test('cursor-agent: runs sharing a cwd take turns, so each sees its OWN task marker in .cursor/mcp.json; waiting runs can be canceled or handed back', async (t) => {
  // Regression: with concurrency >= 2 the shared, ref-counted .cursor/mcp.json kept the FIRST run's bruce-comm entry,
  // so a concurrent second run was marked as the runner child of the wrong task.
  const dir = tempDir('fake-cursor');
  const script = path.join(dir, 'fake-cursor.mjs');
  const logFile = path.join(dir, 'runs.jsonl');
  const holdFile = path.join(dir, 'hold-ms.txt');
  fs.writeFileSync(script, FAKE_CURSOR);
  fs.writeFileSync(holdFile, '600');
  const repo = path.join(tempDir('repo'), 'shared repo');
  const userFile = path.join(repo, '.cursor', 'mcp.json');
  fs.mkdirSync(path.dirname(userFile), { recursive: true });
  fs.writeFileSync(userFile, USER_CURSOR_CONFIG);
  const cursor = (id, extra = {}) => ({
    agent: { id, instructions: 'Fake Cursor runner.' },
    preset: 'cursor-agent',
    command: script,
    extraArgs: ['{taskId}'],
    cwd: repo,
    timeoutSeconds: 120,
    env: { LOG_FILE: logFile, HOLD_FILE: holdFile },
    ...extra,
  });
  // Two cursor entries on one cwd (the turn-taking is process-wide), plus a preset that writes no workspace files.
  const { ctx, home, logs, configFile } = setup(t, 'runner-cursor-turns', [
    cursor('cursor-duo', { concurrency: 2 }),
    cursor('cursor-solo'),
    customRunner('plain-duo', 'echo-agent.mjs', { concurrency: 2, cwd: repo }),
  ]);
  const records = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  const send = (to, title) => ctx.store.send('human', { to_agent: to, title }).tasks[0].id;
  const stop = new AbortController();
  t.after(() => stop.abort());
  t.after(() => records().forEach((r) => killTree(r.pid)));
  const running = runRunners(ctx, { configFile, signal: stop.signal });

  // 1. Four runs (two of them claimed at once by the concurrency-2 entry) on one cwd: they finish, one after the other.
  const ids = [send('cursor-duo', 'a'), send('cursor-duo', 'b'), send('cursor-solo', 'c'), send('cursor-duo', 'd')];
  await waitFor(() => ids.every((id) => ['completed', 'failed'].includes(ctx.store.requireTask(id).status)), {
    timeout: 40_000,
    label: 'all four runs to finish (no deadlock)',
  });
  for (const id of ids) {
    const task = ctx.store.requireTask(id);
    assert.equal(task.status, 'completed', task.error ?? '');
    assert.equal(task.result, `own=${id} seen=${[id, id, id, id].join(',')}`, 'the run saw its own task marker (args and env) from start to end');
  }
  const starts = records().filter((r) => r.phase === 'start').sort((a, b) => a.at - b.at);
  const ends = records().filter((r) => r.phase === 'end');
  assert.equal(starts.length, 4);
  for (let i = 1; i < starts.length; i++) {
    const previousEnd = ends.find((e) => e.own === starts[i - 1].own).at;
    assert.ok(starts[i].at >= previousEnd, `${starts[i].own} started only after ${starts[i - 1].own} had finished`);
  }
  assert.ok(logs.some((l) => /waiting for the workspace files in .*shared repo/.test(l)), 'the wait is logged');
  assert.equal(fs.readFileSync(userFile, 'utf8'), USER_CURSOR_CONFIG, "the user's file is restored after the last run");

  // 2. While one run holds the workspace, the others wait (their leases kept alive); a runner of a preset that writes
  //    no workspace files is not held up. A waiting task can be canceled, and a shutdown hands waiting tasks back.
  fs.writeFileSync(holdFile, '60000');
  const t1 = [send('cursor-duo', 'e'), send('cursor-duo', 'f'), send('cursor-solo', 'g')];
  const first = await waitFor(() => records().find((r) => r.phase === 'start' && t1.includes(r.own))?.own, { timeout: 15_000, label: 'one run to start' });
  const waiting = t1.filter((id) => id !== first);
  await waitFor(() => waiting.every((id) => logs.some((l) => l.includes(`${id}: waiting for the workspace files`))), { label: 'the other two to wait' });
  for (const id of waiting) assert.equal(ctx.store.requireTask(id).status, 'working', 'a waiting run keeps its claim');
  const plain = send('plain-duo', 'not held up');
  await waitFor(() => ctx.store.requireTask(plain).status === 'completed', { timeout: 10_000, label: 'the plain runner in the same cwd' });

  ctx.store.cancel('human', waiting[0], 'no longer needed');
  await waitFor(() => logs.some((l) => l.includes(`${waiting[0]}: stopped waiting for the workspace (canceled)`)), { label: 'the canceled wait to end' });
  stop.abort();
  await within(running, 15_000, 'runner shutdown while a run waits for the workspace');
  assert.equal(ctx.store.requireTask(waiting[0]).status, 'canceled');
  for (const id of [first, waiting[1]]) {
    const task = ctx.store.requireTask(id);
    assert.deepEqual([task.status, task.attempts, task.assignee], ['queued', 0, null], `${id} handed back unchanged`);
  }
  assert.ok(!records().some((r) => waiting.includes(r.own)), 'the waiting runs never started their CLI');
  assert.equal(fs.readFileSync(userFile, 'utf8'), USER_CURSOR_CONFIG);
  assert.deepEqual(fs.readdirSync(path.join(home, 'runs')).filter((n) => n.startsWith('workspace-restore-')), []);
});

test('runner check: concurrency > 1 (or a shared cwd) with a preset that writes workspace files says the runs take turns', async (t) => {
  const repo = tempDir('check-repo');
  const cursor = (id, extra = {}) => ({ agent: { id, instructions: 'x' }, preset: 'cursor-agent', command: fixture('echo-agent.mjs'), cwd: repo, ...extra });
  const { ctx, home, configFile } = setup(t, 'runner-check-turns', [
    cursor('cursor-duo', { concurrency: 3 }),
    cursor('cursor-solo'),
    cursor('cursor-elsewhere', { cwd: tempDir('other-repo') }),
    customRunner('plain-duo', 'echo-agent.mjs', { concurrency: 2, cwd: repo }),
  ]);
  const report = await checkRunners(ctx, configFile);
  const notes = Object.fromEntries(report.runners.map((r) => [r.agent_id, r.warnings.join('\n')]));
  const cursorFile = path.join(repo, '.cursor', 'mcp.json').replace(/[\\.]/g, '\\$&');
  assert.match(notes['cursor-duo'], new RegExp(`concurrency 3: every cursor-agent run writes its own task marker into ${cursorFile}, so runs in this working directory take turns`));
  assert.match(notes['cursor-duo'], /shares its working directory with cursor-solo/);
  assert.doesNotMatch(notes['cursor-solo'], /concurrency/, 'concurrency 1');
  assert.match(notes['cursor-solo'], /shares its working directory with cursor-duo/);
  assert.doesNotMatch(notes['cursor-elsewhere'], /take turns|shares its working directory/);
  assert.doesNotMatch(notes['plain-duo'], /take turns|shares its working directory/, 'no workspace files: runs stay concurrent');

  const cli = await runCli(['runner', 'check', '--config', configFile], { env: { BRUCE_COMM_HOME: home } });
  assert.equal(cli.code, 0, cli.stderr);
  assert.match(cli.stdout, /note: +concurrency 3: every cursor-agent run writes its own task marker/);
});

/** spawn(), waiting for the exit; `env` replaces the environment completely. */
function runIn(cwd, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN, ...args], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    child.stdout.setEncoding('utf8').on('data', (d) => (out += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, out }));
  });
}

test('where.exe and taskkill.exe are started from System32, never from the current directory', { skip: !IS_WINDOWS && 'Windows-only (binary planting)' }, async (t) => {
  // Windows searches the current directory before PATH unless NoDefaultCurrentDirectoryInExePath is set (it is not by
  // default). Plant node.exe as where.exe / taskkill.exe there; a preloaded payload records whether either one ran.
  const plant = tempDir('plant');
  const marker = path.join(plant, 'PLANTED.txt');
  const payload = path.join(plant, 'payload.cjs');
  fs.writeFileSync(
    payload,
    "const name = require('node:path').basename(process.execPath).toLowerCase();\n" +
      "if (name === 'where.exe' || name === 'taskkill.exe') {\n" +
      `  require('node:fs').appendFileSync(${JSON.stringify(marker)}, name + ' ' + JSON.stringify(process.argv.slice(1)) + '\\n');\n` +
      '  process.exit(0);\n}\n',
  );
  for (const exe of ['where.exe', 'taskkill.exe']) {
    try {
      fs.linkSync(process.execPath, path.join(plant, exe));
    } catch {
      fs.copyFileSync(process.execPath, path.join(plant, exe));
    }
  }
  const pidFile = path.join(tempDir('pids'), 'planted.json');
  const { ctx, home, configFile } = setup(t, 'runner-plant', [
    customRunner('sleepy', 'sleep-agent.mjs', { timeoutSeconds: 1, env: { PID_FILE: pidFile } }), // taskkill.exe on the timeout
    customRunner('by-name', 'echo-agent.mjs', { command: 'node' }), // a command name on PATH: where.exe
  ]);
  const id = ctx.store.send('human', { to_agent: 'sleepy', title: 'time out please' }).tasks[0].id;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== 'nodefaultcurrentdirectoryinexepath'));
  Object.assign(env, { BRUCE_COMM_HOME: home, NODE_OPTIONS: `--require "${payload.replace(/\\/g, '/')}"` });

  const run = await runIn(plant, ['runner', '--once', '--config', configFile], env);
  assert.equal(run.code, 0, run.out);
  const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
  t.after(() => [pids.child, pids.grandchild].forEach(killTree));
  assert.equal(fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '', '', 'no planted executable ran');
  assert.match(run.out, /runner\[by-name\] profile updated \(custom: PATH: .*node\.exe\)/i, 'the real where.exe found "node"');
  assert.match(ctx.store.requireTask(id).error, /Timed out after 1s/);
  await waitFor(() => !alive(pids.child) && !alive(pids.grandchild), { timeout: 5000, label: 'the real taskkill killed the tree' });
});

test('every preset hands its CLI a Bruce Comm config marked as a runner child of the task (stdio and http)', async (t) => {
  const { ctx } = setup(t, 'runner-marker', []);
  for (const transport of ['stdio', 'http']) {
    const spec = bruceServerSpec(ctx.config, { transport, agentId: 'w', bindVia: 'arg', env: { BRUCE_COMM_HOME: ctx.config.home }, runnerTask: 'T-MARK000000' });
    if (transport === 'stdio') {
      assert.deepEqual(spec.args.slice(-4), ['--agent-id', 'w', '--runner-task', 'T-MARK000000']);
      assert.equal(spec.env.BRUCE_COMM_RUNNER_TASK, 'T-MARK000000');
    } else {
      assert.match(spec.url, /\/mcp\?agent=w&runner_task=T-MARK000000$/);
    }
    const dir = tempDir('marker');
    const ictx = { agentId: 'w', taskId: 'T-MARK000000', resultFrom: 'stdout', spec, cwd: dir, runDir: dir, promptFile: path.join(dir, 'p.md'), mcpConfigFile: path.join(dir, 'm.json'), outputFile: path.join(dir, 'o.txt') };
    const marker = transport === 'stdio' ? /--runner-task["'], ["']T-MARK000000/ : /runner_task=T-MARK000000/;
    for (const preset of Object.values(PRESETS)) {
      if (preset.borrowedSession) continue; // vscode-chat uses the VS Code window's own connection
      // What the CLI actually reads: codex gets its server through -c, cursor through the workspace file.
      const used = preset.id === 'codex' ? preset.args(ictx) : preset.id === 'cursor-agent' ? preset.files(ictx) : preset.mcpConfig(spec);
      assert.match(JSON.stringify(used).replace(/","/g, '", "'), marker, `${preset.id} (${transport})`);
      // runner check reads workspaceFiles; the worker takes the cwd's turn lock for the workspace files of files().
      const written = (preset.files?.(ictx) ?? []).filter((f) => f.workspace).map((f) => path.relative(dir, f.path));
      assert.deepEqual(preset.workspaceFiles ?? [], written, `${preset.id}: workspaceFiles lists exactly the workspace files it writes`);
    }
  }
});

test("gemini-cli: the runner's settings take the SYSTEM settings slot (highest precedence) and keep the machine's own system settings", async (t) => {
  const { ctx } = setup(t, 'runner-gemini', []);
  const dir = tempDir('gemini');
  const adminFile = path.join(dir, 'settings.json');
  fs.writeFileSync(adminFile, JSON.stringify({ mcp: { allowed: ['bruce-comm', 'corp'] }, mcpServers: { corp: { command: 'corp.exe' } } }));
  const saved = [process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH];
  process.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = adminFile;
  delete process.env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH;
  t.after(() => {
    for (const [key, value] of [['GEMINI_CLI_SYSTEM_SETTINGS_PATH', saved[0]], ['GEMINI_CLI_SYSTEM_DEFAULTS_PATH', saved[1]]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  const spec = bruceServerSpec(ctx.config, { transport: 'stdio', agentId: 'gemini-worker', bindVia: 'arg', runnerTask: 'T-GEMINI0000' });
  const ictx = { agentId: 'gemini-worker', taskId: 'T-GEMINI0000', resultFrom: 'stdout', spec, cwd: dir, runDir: dir, promptFile: path.join(dir, 'p.md'), mcpConfigFile: path.join(dir, 'gemini-settings.json'), outputFile: path.join(dir, 'o.txt') };
  const preset = PRESETS['gemini-cli'];
  const env = preset.env(ictx);
  // A "bruce-comm" entry in ~/.gemini/settings.json (bruce-comm install gemini-cli) would replace one in the defaults.
  assert.equal(env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, ictx.mcpConfigFile);
  assert.equal(env.GEMINI_CLI_SYSTEM_DEFAULTS_PATH, path.join(dir, 'system-defaults.json'), 'the system defaults file stays in effect');
  const settings = preset.mcpConfig(spec);
  assert.deepEqual(settings.mcp, { allowed: ['bruce-comm', 'corp'] }, 'admin policy from the real system settings is kept');
  assert.deepEqual(settings.mcpServers.corp, { command: 'corp.exe' });
  assert.deepEqual(settings.mcpServers['bruce-comm'].args.slice(-4), ['--agent-id', 'gemini-worker', '--runner-task', 'T-GEMINI0000']);
  assert.equal(settings.mcpServers['bruce-comm'].trust, true);
});

test("vscode-chat: the prompt has the chat name the runner agent per call (the VS Code window keeps its identity); runner check compares the ids", async (t) => {
  const { ctx, configFile } = setup(t, 'runner-vscode', [{ agent: { id: 'vscode-chat-worker', instructions: 'x' }, preset: 'vscode-chat' }]);
  const id = ctx.store.send('human', { to_agent: 'vscode-chat-worker', title: 'tidy the readme' }).tasks[0].id;
  const task = ctx.store.claimNext('vscode-chat-worker').task;
  assert.equal(task.id, id);
  const prompt = buildPrompt(ctx.store, task, { agentId: 'vscode-chat-worker', presetTitle: 'VS Code chat', resultFrom: 'mcp', timeoutSeconds: 1800, borrowedSession: true });
  assert.match(prompt, /pass agent_id="vscode-chat-worker" on EVERY bruce-comm call \(it acts as "vscode-chat-worker" for that call only\)/);
  assert.match(prompt, /Do not call register_agent/);
  assert.doesNotMatch(prompt, /identity is pre-bound/);
  assert.match(prompt, new RegExp(`Do not call get_next_task: this run handles only task ${id}`));

  const cwd = tempDir('vscode-ws');
  writeRunnerConfig(path.dirname(configFile), [{ agent: { id: 'vscode-chat-worker', instructions: 'x' }, preset: 'vscode-chat', command: process.execPath, cwd }]);
  const vscodeEntry = (entry) => {
    fs.mkdirSync(path.join(cwd, '.vscode'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.vscode', 'mcp.json'), JSON.stringify({ servers: { 'bruce-comm': entry } }));
  };
  const warnings = async () => (await checkRunners(ctx, configFile)).runners[0].warnings.join('\n');
  vscodeEntry({ type: 'stdio', command: 'node', args: ['bruce-comm.js', 'stdio'], env: { BRUCE_AGENT_ID: 'vscode-copilot' } });
  assert.match(await warnings(), /is bound to "vscode-copilot", this runner to "vscode-chat-worker".*Set "agent\.id" to "vscode-copilot"/);
  vscodeEntry({ type: 'http', url: 'http://127.0.0.1:7457/mcp?agent=vscode-chat-worker' });
  assert.doesNotMatch(await warnings(), /VS Code's bruce-comm entry|No bruce-comm entry/, 'same id: nothing to warn about');
  vscodeEntry({ type: 'stdio', command: 'node', args: ['bruce-comm.js', 'stdio'] });
  assert.match(await warnings(), /pre-binds no agent id: the first call that passes agent_id="vscode-chat-worker" binds that window/);
  fs.rmSync(path.join(cwd, '.vscode'), { recursive: true });
  assert.match(await warnings(), /No bruce-comm entry in .*mcp\.json or .*mcp\.json: the Copilot agent needs one to report/);
});
