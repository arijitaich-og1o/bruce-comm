// A runner process whose user presses Ctrl+C twice ("press Ctrl+C again to force"): runs runRunners on <home> with
// <configFile>, waits until <watchFile> holds the runner's entry (`--agent-id`: a run is in progress), then emits SIGINT
// twice so the runner exits at once (exit code 130) through its forced-exit path.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
import fs from 'node:fs';

if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

const { createContext } = await import('../../dist/context.js');
const { runRunners } = await import('../../dist/runner/runner.js');
const [home, configFile, watchFile] = process.argv.slice(2);
const ctx = createContext({ home }, { quiet: true });
void runRunners(ctx, { configFile });
const deadline = Date.now() + 20_000;
while (Date.now() < deadline) {
  let text = '';
  try {
    text = fs.readFileSync(watchFile, 'utf8');
  } catch {
    // not written yet
  }
  if (text.includes('--agent-id')) break;
  await new Promise((resolve) => setTimeout(resolve, 50));
}
process.emit('SIGINT', 'SIGINT');
process.emit('SIGINT', 'SIGINT');
