// supervise-fixture-server.mjs — test fixture for supervise.test.mjs: a
// tiny HTTP server that answers /healthz ok (stand-in for server.mjs) and
// exits 0 on SIGTERM. NOT a test file (no .test.mjs suffix).
import http from 'node:http';

const port = Number(process.env.RADSVINN_PORT || 0);
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end('{"ok":true}');
});
server.listen(port, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`fixture-server listening on ${server.address().port}`);
});
process.on('SIGTERM', () => {
  // eslint-disable-next-line no-console
  console.log('fixture-server terminated');
  process.exit(0);
});
