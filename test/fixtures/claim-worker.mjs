// Worker process for the cross-process claim test: opens the shared database in <home> with its own store session,
// waits for work, then claims and completes tasks as <agentId> until every task in the database is finished. Prints
// {claimed: [ids], errors: [messages]}. Arguments: <home> <agentId>.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

const { createContext } = await import('../../dist/context.js');
const [home, agentId] = process.argv.slice(2);
const ctx = createContext({ home }, { quiet: true });
const sessionId = ctx.store.openSession({ transport: 'stdio', agent_id: agentId }).id;
const claimed = [];
const errors = [];
const deadline = Date.now() + 30_000;
while (Date.now() < deadline) {
  try {
    const { task } = ctx.store.claimNext(agentId, sessionId);
    if (task) {
      claimed.push(task.id);
      // "Work" on it for a moment without holding any lock, so the other workers claim in between.
      await new Promise((resolve) => setTimeout(resolve, 5));
      ctx.store.complete(agentId, task.id, `done by ${agentId}`);
      continue;
    }
    // The test queues all tasks in one transaction: once some exist and none is open, the work is done.
    const queuedYet = ctx.store.listTasks({ limit: 1 }).length > 0;
    if (queuedYet && ctx.store.listTasks({ status: ['queued', 'working'], limit: 1 }).length === 0) break;
  } catch (err) {
    errors.push(err.message);
  }
  await new Promise((resolve) => setTimeout(resolve, 2));
}
ctx.store.closeSession(sessionId, 'worker done');
ctx.close();
process.stdout.write(JSON.stringify({ claimed, errors }));
