// supervise-fixture-idle.mjs — test fixture for supervise.test.mjs: stays
// alive but serves NOTHING — proves the supervisor's health-poll fatal
// path (a server process that runs but never answers /healthz). NOT a test
// file (no .test.mjs suffix).
// eslint-disable-next-line no-console
console.log('fixture-idle started');
setInterval(() => {}, 1000);
process.on('SIGTERM', () => process.exit(0));
