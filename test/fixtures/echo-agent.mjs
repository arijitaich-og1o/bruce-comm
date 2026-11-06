// Fake agent: reads the whole prompt from stdin, optionally records the raw stdin bytes, argv, cwd and selected
// environment variables into $CAPTURE_DIR, then prints "DONE: <first prompt line>" and exits 0.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
import fs from 'node:fs';
import path from 'node:path';

if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks);
const capture = process.env.CAPTURE_DIR;
if (capture) {
  fs.mkdirSync(capture, { recursive: true });
  fs.writeFileSync(path.join(capture, 'stdin.bin'), stdin);
  fs.writeFileSync(
    path.join(capture, 'argv.json'),
    JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: { NO_COLOR: process.env.NO_COLOR, EXTRA: process.env.EXTRA_VAR } }),
  );
}
process.stdout.write(`DONE: ${stdin.toString('utf8').split(/\r?\n/)[0]}\n`);
