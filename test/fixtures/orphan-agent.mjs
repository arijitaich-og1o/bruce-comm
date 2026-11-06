// Fake agent CLI that leaves a background process behind: it starts a helper that inherits its stdout / stderr (like a
// dev server or build daemon started by a tool call), prints its answer and exits 0 at once. The helper keeps the
// pipes open for $HELPER_MS (default 30000) ms. PIDs are written to $PID_FILE.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

process.stdin.resume();
process.stdin.on('end', () => {
  const ms = Number(process.env.HELPER_MS ?? 30000);
  const helper = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], {
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: true,
    windowsHide: true,
  });
  helper.unref();
  if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ child: process.pid, helper: helper.pid }));
  process.stdout.write('ANSWER: done\n');
  process.exit(0);
});
