// test/pages.test.mjs — the SSR shell + static asset serving.
//
// Verifies: the page shell is served (public, no session) with the CSP/base
// security headers and the right content-type; assets resolve with correct
// MIME + cache; the traversal guard rejects `..` escapes, absolute paths,
// disallowed extensions, and directories; unknown/absent assets 404.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, baseTestConfig } from './helpers.mjs';
import { resolveAsset, renderShell, isPagePath } from '../lib/pages.mjs';

async function raw(baseUrl, path, opts = {}) {
  const res = await fetch(`${baseUrl}${path}`, { redirect: 'manual', ...opts });
  const text = await res.text();
  return { status: res.status, headers: res.headers, text };
}

test('page shell is served for every page path, public, with CSP + no interpolation', async (t) => {
  const srv = await startTestServer({ config: baseTestConfig() });
  t.after(() => srv.stop());

  for (const p of ['/', '/plans', '/plans/new', '/operations', '/audit', '/settings',
    '/plans/0d1298f3-627a-4b32-aceb-3f381be62cd5']) {
    const r = await raw(srv.baseUrl, p);
    assert.equal(r.status, 200, `${p} serves the shell`);
    assert.match(r.headers.get('content-type'), /text\/html/, `${p} is html`);
    assert.match(r.headers.get('content-security-policy'), /default-src 'none'/, `${p} carries CSP`);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.match(r.text, /id="main"/, `${p} has the client mount point`);
    assert.match(r.text, /\/assets\/app\.js/, `${p} loads the client bundle`);
  }
});

test('the shell is a pure static string — identical every call, no request data', () => {
  const a = renderShell();
  const b = renderShell();
  assert.equal(a, b, 'renderShell is deterministic');
  // No template-literal interpolation markers survived into the shipped shell
  // (there is nothing to interpolate — this is the "no SSR injection surface"
  // guarantee stated in lib/pages.mjs).
  assert.doesNotMatch(a, /\$\{/, 'no un-evaluated interpolation in the shell');
  assert.ok(!a.includes('<script>'), 'no inline script (CSP forbids it)');
});

test('assets serve with correct MIME + cache and no session required', async (t) => {
  const srv = await startTestServer({ config: baseTestConfig() });
  t.after(() => srv.stop());

  const css = await raw(srv.baseUrl, '/assets/app.css');
  assert.equal(css.status, 200);
  assert.match(css.headers.get('content-type'), /text\/css/);
  assert.match(css.headers.get('cache-control'), /max-age=300/);

  const js = await raw(srv.baseUrl, '/assets/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /text\/javascript/);

  const font = await raw(srv.baseUrl, '/assets/fonts/fonts.css');
  assert.equal(font.status, 200);
});

test('static traversal guard rejects escapes, bad extensions, directories, missing files', async (t) => {
  const srv = await startTestServer({ config: baseTestConfig() });
  t.after(() => srv.stop());

  // Unit-level guard (server may normalize `..` before it reaches the route).
  assert.equal(resolveAsset('/assets/../server.mjs'), null, 'parent escape rejected');
  assert.equal(resolveAsset('/assets/../../etc/passwd'), null, 'deep escape rejected');
  assert.equal(resolveAsset('/assets/app.mjs'), null, 'disallowed extension rejected');
  assert.equal(resolveAsset('/assets/'), null, 'empty path rejected');
  assert.equal(resolveAsset('/assets/fonts'), null, 'directory rejected');
  assert.equal(resolveAsset('/assets/does-not-exist.css'), null, 'missing file rejected');
  assert.equal(resolveAsset('/not-assets/app.css'), null, 'outside /assets rejected');
  assert.ok(resolveAsset('/assets/app.css'), 'a real asset resolves');

  // HTTP-level: an encoded traversal and a bad extension both 404, never leak
  // a file outside public/.
  const escaped = await raw(srv.baseUrl, '/assets/%2e%2e/server.mjs');
  assert.equal(escaped.status, 404);
  assert.doesNotMatch(escaped.text, /createServer/, 'no source leaked');
  const badExt = await raw(srv.baseUrl, '/assets/server.mjs');
  assert.equal(badExt.status, 404);
});

test('isPagePath matches the fixed set + detail UUIDs, nothing else', () => {
  assert.ok(isPagePath('/plans'));
  assert.ok(isPagePath('/plans/new'));
  assert.ok(isPagePath('/plans/0d1298f3-627a-4b32-aceb-3f381be62cd5'));
  assert.ok(!isPagePath('/plans/not-a-uuid'));
  assert.ok(!isPagePath('/api/plans'));
  assert.ok(!isPagePath('/auth/login'));
});

test('page routes are GET-only', async (t) => {
  const srv = await startTestServer({ config: baseTestConfig() });
  t.after(() => srv.stop());
  const r = await raw(srv.baseUrl, '/plans', { method: 'POST' });
  assert.equal(r.status, 405);
});
