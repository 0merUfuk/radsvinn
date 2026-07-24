// supervise-fixture-crash-loop.mjs — test fixture for supervise.test.mjs:
// always exits 1 immediately — proves the supervisor's give-up-after-N-
// restarts fatal path. NOT a test file (no .test.mjs suffix).
process.exit(1);
