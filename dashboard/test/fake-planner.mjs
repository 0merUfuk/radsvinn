// test/fake-planner.mjs — a recording node:http stand-in for the Radsvinn
// planner (main + assumed-shipped PR A shape). Records every request so
// tests can assert what the BFF forwarded (actor shape, confirm strings,
// query passthrough) and — critically for the RBAC matrix — assert it was
// NEVER called on a 403.

import http from 'node:http';
import crypto from 'node:crypto';

function readJson(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        resolve({});
      }
    });
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

const DEFAULT_ACTION_RESULT = {
  'approve-shape': { status: 202, body: { status: 'grooming' } },
  create: { status: 202, body: { status: 'creating' } },
  reject: { status: 200, body: { status: 'rejected' } },
  retry: { status: 202, body: { status: 'breaking_down' } },
  cancel: { status: 202, body: { status: 'cancelling' } },
};

export function createFakePlanner({ token } = {}) {
  const calls = [];
  const overrides = new Map(); // `${method} ${pathname}` -> (call) => ({status, body}) | array of same (queue)

  function on(method, pathname, handlerOrResult) {
    overrides.set(`${method} ${pathname}`, handlerOrResult);
  }

  function reset() {
    calls.length = 0;
    overrides.clear();
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-planner.invalid');
    const body = req.method === 'POST' ? await readJson(req) : undefined;
    const call = {
      method: req.method,
      path: url.pathname,
      search: url.search,
      authorization: req.headers.authorization,
      body,
    };
    calls.push(call);

    if (token !== undefined) {
      if (req.headers.authorization !== `Bearer ${token}`) {
        return send(res, 401, { error: 'unauthorized' });
      }
    }

    const key = `${req.method} ${url.pathname}`;
    if (overrides.has(key)) {
      const entry = overrides.get(key);
      let result;
      if (Array.isArray(entry)) {
        result = entry.length > 1 ? entry.shift() : entry[0];
      } else if (typeof entry === 'function') {
        result = entry(call, url);
      } else {
        result = entry;
      }
      return send(res, result.status, result.body);
    }

    // Sensible generic defaults so tests that don't care about the exact
    // planner response body still get a plausible 200/202.
    if (req.method === 'GET' && url.pathname === '/healthz') {
      return send(res, 200, { ok: true, version: '0.1.0', engine: 'real' });
    }
    if (req.method === 'GET' && url.pathname === '/plans') {
      return send(res, 200, { plans: [], next_cursor: null });
    }
    if (req.method === 'GET' && url.pathname === '/plans/summary') {
      return send(res, 200, {
        total: 0,
        counts: {
          breaking_down: 0, shape_ready: 0, grooming: 0, plan_ready: 0, creating: 0,
          created: 0, rejected: 0, failed: 0, budget_blocked: 0, cancelling: 0, cancelled: 0,
        },
      });
    }
    if (req.method === 'GET' && url.pathname === '/audit') {
      return send(res, 200, { records: [], next_cursor: null });
    }
    const planMatch = url.pathname.match(/^\/plan\/([0-9a-f-]{36})$/);
    if (req.method === 'GET' && planMatch) {
      return send(res, 404, { error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname === '/plan') {
      return send(res, 202, { plan_id: crypto.randomUUID(), status: 'breaking_down' });
    }
    const actionMatch = url.pathname.match(/^\/plan\/([0-9a-f-]{36})\/(approve-shape|create|reject|retry|cancel)$/);
    if (req.method === 'POST' && actionMatch) {
      const defaults = DEFAULT_ACTION_RESULT[actionMatch[2]];
      return send(res, defaults.status, { ...defaults.body, request_id: crypto.randomUUID() });
    }

    return send(res, 404, { error: 'not found' });
  });

  return {
    server,
    calls,
    on,
    reset,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address();
      return `http://127.0.0.1:${port}`;
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}
