// Fallback ("headless twin") mode: the runner leaves fresh work to the interactive agent and only takes tasks that
// have waited unclaimed past fallbackAfterSeconds; it never takes messages or rewrites the agent's profile/status.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const imp = (p) => import(pathToFileURL(path.join(ROOT, 'dist', p)).href);
const { createContext } = await imp('context.js');
const { runRunners } = await imp('runner/runner.js');

async function until(fn, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 200));
  }
}

test('fallback twin: waits for the interactive agent, then handles aged tasks headless', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'bruce-comm-test-fallback-'));
  process.env.BRUCE_TEST_FIXTURE = '1';
  const ctx = createContext({ home, port: 0 }, { quiet: true });
  const store = ctx.store;
  store.registerAgent({ id: 'office', instructions: 'Interactive agent profile written by the agent itself.', skills: [{ id: 'notes' }] });
  store.registerAgent({ id: 'boss', instructions: 'sender' });
  const configFile = path.join(home, 'runners.json');
  fs.writeFileSync(
    configFile,
    JSON.stringify({
      runners: [
        {
          agent: { id: 'office', instructions: 'TWIN PROFILE MUST NOT OVERWRITE' },
          preset: 'custom',
          command: process.execPath,
          args: [path.join(ROOT, 'test', 'fixtures', 'echo-agent.mjs')],
          fallbackAfterSeconds: 2,
          keepAgentProfile: true,
          timeoutSeconds: 30,
        },
      ],
    }),
  );
  const stop = new AbortController();
  const running = runRunners(ctx, { configFile, signal: stop.signal });
  try {
    const msg = store.send('boss', { to_agent: 'office', kind: 'message', title: 'FYI' }).tasks[0];
    const task = store.send('boss', { to_agent: 'office', title: 'Summarise notes' }).tasks[0];
    await new Promise((r) => setTimeout(r, 1000));
    assert.equal(store.getTask(task.id).status, 'queued', 'fresh task is left for the interactive agent');
    const done = await until(() => (store.getTask(task.id).status === 'completed' ? store.getTask(task.id) : null));
    assert.match(done.result, /^DONE:/);
    assert.ok(done.claimed_at - done.created_at >= 1900, 'claimed only after the fallback delay');
    assert.equal(store.getTask(msg.id).status, 'queued', 'messages are left for the interactive agent');
    const agent = store.getAgent('office');
    assert.match(agent.instructions, /Interactive agent profile/, 'profile kept');
    assert.notEqual(agent.status, 'offline');
    assert.equal(store.presence(agent) === 'listening', false, 'twin does not make the agent look listening');
  } finally {
    stop.abort();
    await running;
    assert.notEqual(store.getAgent('office').status, 'offline', 'stopping the twin does not mark the agent offline');
    ctx.close();
  }
});
