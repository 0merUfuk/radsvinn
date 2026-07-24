// supervise-fixture-bridge.mjs — test fixture for supervise.test.mjs: a
// long-lived no-op process (stand-in for slack.mjs) that exits 0 on
// SIGTERM. NOT a test file (no .test.mjs suffix).
// eslint-disable-next-line no-console
console.log('fixture-bridge started');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('fixture-bridge terminated');
  process.exit(0);
});
