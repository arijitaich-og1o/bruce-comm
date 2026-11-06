// Fake agent configured with resultFrom "mcp" that forgets to call complete_task (prints text, exits 0).
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

process.stdin.resume();
process.stdin.on('end', () => process.stdout.write('I did the work but did not report it\n'));
