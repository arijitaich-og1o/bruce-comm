// Fake agent that takes $SLOW_MS (default 1500) ms, then prints "SLOW-DONE <first argument>".
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

process.stdin.resume();
setTimeout(() => {
  process.stdout.write(`SLOW-DONE ${process.argv[2] ?? ''}\n`);
  process.exit(0);
}, Number(process.env.SLOW_MS ?? 1500));
