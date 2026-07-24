// test/fake-github.mjs — a minimal, real node:http GitHub stand-in for the
// OAuth test seam (DASH_GITHUB_API_BASE / DASH_GITHUB_OAUTH_BASE). Every
// dashboard test that exercises login runs the FULL OAuth flow against this
// server — there is no auth-bypass flag anywhere in lib/oauth.mjs.

import http from 'node:http';

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

export function createFakeGithub() {
  const codesByValue = new Map(); // code -> { token, scope }
  const usersByToken = new Map(); // token -> { login, id, name, membership, teams }
  const revokeCalls = [];
  let exchangeCallCount = 0;

  function addCode(code, { token, scope = 'read:org' }) {
    codesByValue.set(code, { token, scope });
  }

  // `membership` is one of: { status: 200, state: 'active' } | { status: 404 }
  // | { status: 403 } | { status: 200, state: 'pending' } | { status: 401 }
  // | { transientError: true } (simulated by closing the listener mid-test —
  // see server.close() below; this flag alone does nothing here).
  function addUser(token, { login, id, name, membership, teams = [] }) {
    usersByToken.set(token, { login, id, name, membership, teams });
  }

  function setMembership(token, membership) {
    const u = usersByToken.get(token);
    if (u) u.membership = membership;
  }

  function setTeams(token, teams) {
    const u = usersByToken.get(token);
    if (u) u.teams = teams;
  }

  function bearerToken(req) {
    const h = req.headers.authorization || '';
    return h.startsWith('Bearer ') ? h.slice(7) : null;
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake-github.invalid');

    if (req.method === 'POST' && url.pathname === '/login/oauth/access_token') {
      const body = await readJson(req);
      exchangeCallCount += 1;
      const entry = codesByValue.get(body.code);
      if (!entry) return send(res, 200, { error: 'bad_verification_code', error_description: 'unknown code' });
      // Consume the code (real GitHub codes are single-use) — a second
      // exchange attempt with the same code must fail too.
      codesByValue.delete(body.code);
      return send(res, 200, { access_token: entry.token, token_type: 'bearer', scope: entry.scope });
    }

    if (req.method === 'GET' && url.pathname === '/user') {
      const token = bearerToken(req);
      const u = token && usersByToken.get(token);
      if (!u) return send(res, 401, { message: 'Bad credentials' });
      return send(res, 200, { login: u.login, id: u.id, name: u.name });
    }

    const membershipMatch = url.pathname.match(/^\/user\/memberships\/orgs\/([^/]+)$/);
    if (req.method === 'GET' && membershipMatch) {
      const token = bearerToken(req);
      const u = token && usersByToken.get(token);
      if (!u) return send(res, 401, { message: 'Bad credentials' });
      const m = u.membership || { status: 404 };
      if (m.status === 500) return send(res, 500, { message: 'internal error' });
      if (m.status !== 200) return send(res, m.status, { message: 'denied' });
      return send(res, 200, { state: m.state || 'active', organization: { login: membershipMatch[1] } });
    }

    if (req.method === 'GET' && url.pathname === '/user/teams') {
      const token = bearerToken(req);
      const u = token && usersByToken.get(token);
      if (!u) return send(res, 401, { message: 'Bad credentials' });
      const page = Number(url.searchParams.get('page') || '1');
      const perPage = Number(url.searchParams.get('per_page') || '100');
      const start = (page - 1) * perPage;
      const slice = (u.teams || []).slice(start, start + perPage);
      return send(res, 200, slice);
    }

    const revokeMatch = url.pathname.match(/^\/applications\/([^/]+)\/token$/);
    if (req.method === 'DELETE' && revokeMatch) {
      const body = await readJson(req);
      revokeCalls.push({ clientId: revokeMatch[1], token: body.access_token, auth: req.headers.authorization });
      res.writeHead(204);
      return res.end();
    }

    return send(res, 404, { message: 'not found' });
  });

  return {
    server,
    addCode,
    addUser,
    setMembership,
    setTeams,
    revokeCalls,
    exchangeCallCount: () => exchangeCallCount,
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
