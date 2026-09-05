// supervise-fixture-crash-once.mjs — test fixture for supervise.test.mjs:
// crashes (exit 1) on its FIRST run, then stays alive on every later run —
// proves the supervisor's crash→restart path. The first-run marker is a
// file at $RADSVINN_TEST_MARKER. NOT a test file (no .test.mjs suffix).
import fs from 'node:fs';

const marker = process.env.RADSVINN_TEST_MARKER;
if (!marker) throw new Error('RADSVINN_TEST_MARKER is required');
if (!fs.existsSync(marker)) {
  fs.writeFileSync(marker, '1');
  // eslint-disable-next-line no-console
  console.log('fixture-crash-once crashing');
  process.exit(1);
}
// eslint-disable-next-line no-console
console.log('fixture-crash-once stable');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
