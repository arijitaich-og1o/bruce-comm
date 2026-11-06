// Fake agent that hangs: starts a grandchild process, records both PIDs in $PID_FILE, then sleeps 30 s.
// Used to check that timeouts, cancels and shutdowns kill the whole process tree.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
if (process.env.PID_FILE) fs.writeFileSync(process.env.PID_FILE, JSON.stringify({ child: process.pid, grandchild: grandchild.pid }));
process.stdin.resume();
setTimeout(() => {
  process.stdout.write('woke up\n');
  process.exit(0);
}, 30_000);
