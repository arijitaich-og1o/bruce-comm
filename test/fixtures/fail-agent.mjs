// Fake agent that fails: writes diagnostics to stderr and exits with code 3.
// Started only by the test suite (BRUCE_TEST_FIXTURE=1); `node --test` executing this file directly is a no-op.
if (process.env.BRUCE_TEST_FIXTURE !== '1') process.exit(0);

process.stdin.resume();
process.stdin.on('end', () => {
  process.stderr.write('fake-agent: starting\n');
  process.stderr.write('fake-agent: FATAL something broke: model quota exceeded\n');
  process.stdout.write('partial output\n');
  process.exit(3);
});
