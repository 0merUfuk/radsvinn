// dev-boot.mjs — LOCAL manual-QA harness ONLY (never shipped; excluded from
// the image — it lives beside server.mjs but is not COPYed by the Dockerfile,
// which only takes lib/, public/, server.mjs, package.json).
//
// Boots the REAL production BFF (server.mjs, unmodified) against the running
// fake-engine planner on :8090, and wraps its request handler so a pre-minted
// full-role session cookie is injected on every request — letting the owner
// click the real shipped UI driving live planner data WITHOUT standing up a
// GitHub OAuth app. The OAuth/login/RBAC/CSRF paths are exercised by the
// automated suite against a fake GitHub; this harness only renders the screens.
import http from 'node:http';
import { createServer } from './server.mjs';
import { baseTestConfig } from './test/helpers.mjs';
import { SESSION_COOKIE_NAME } from './lib/sessions.mjs';

const config = baseTestConfig({
  plannerUrl: 'http://127.0.0.1:8090',
  plannerToken: 'dev-local-unused', // fake-engine planner ignores the bearer
  publicOrigin: 'http://127.0.0.1:8686',
  nodeEnv: 'development',
});

const built = createServer({ config });
const { cookieValue } = built.sessionStore.create({
  githubId: 1, login: 'test-requester-dev', display: 'Development Requester',
  roles: ['viewer', 'planner', 'approver', 'creator'], ghToken: 'dev',
});
const seededCookie = `${SESSION_COOKIE_NAME}=${cookieValue}`;

// The BFF's own handler is the http server's single 'request' listener.
const [handler] = built.server.listeners('request');

const wrapper = http.createServer((req, res) => {
  // Inject the dev session on every request so no login round-trip is needed;
  // preserve any real cookies the browser also sends.
  req.headers.cookie = req.headers.cookie ? `${req.headers.cookie}; ${seededCookie}` : seededCookie;
  // The BFF requires Origin on mutations; the browser sends it for same-origin
  // fetches, so nothing to fake here.
  handler(req, res);
});

wrapper.listen(8686, '127.0.0.1', () => {
  console.log('[dev-boot] dashboard (real BFF, dev-seeded session) on http://127.0.0.1:8686');
});
