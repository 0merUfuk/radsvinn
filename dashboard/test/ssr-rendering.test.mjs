// test/ssr-rendering.test.mjs — the XSS discipline of the shipped UI.
//
// DESIGN DECISION (v1, §9.2 split): read screens are rendered CLIENT-SIDE
// from the same-origin /api/* surface using text-node-only DOM construction,
// NOT server-side string interpolation. So the hostile-prose guarantee the
// design's §9.2 adversarial corpus targets ("hostile plan/LLM prose must
// never become markup") is enforced at two points, both statically checkable
// here without a browser:
//
//   1. The SSR shell interpolates NO data at all (pages.test.mjs proves it is
//      a deterministic static string) — zero server injection surface.
//   2. The client bundle constructs every node via el() TEXT NODES and never
//      touches innerHTML/insertAdjacentHTML/outerHTML/document.write — so a
//      plan description of `<img src=x onerror=alert(1)>` renders as literal
//      characters, never as a parsed element.
//
// This test is the CI guard on (2): a future edit that reintroduces an
// innerHTML sink fails here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP_JS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'app.js');

test('client bundle uses no HTML-string DOM sink (text-node discipline)', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  // Strip line/block comments so the guard matches real code, not prose.
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');

  for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'dangerouslySet']) {
    assert.ok(!code.includes(sink), `client bundle must not use ${sink}`);
  }
  // The one construction primitive is el(); it must funnel children through
  // createTextNode (the property that makes hostile prose inert).
  assert.match(code, /createTextNode/, 'el() builds children as text nodes');
  // Attribute values must never be set through an event-handler string or a
  // javascript: URL builder from data — el() only takes on* as real
  // addEventListener callbacks (functions), never string handlers.
  assert.ok(!/setAttribute\(\s*['"]on/i.test(code), 'no string event-handler attributes');
});

test('client bundle only calls the same-origin /api and /auth surface', () => {
  const src = fs.readFileSync(APP_JS, 'utf8');
  // Every fetch/navigation target is a root-relative path — never an absolute
  // URL to another origin (the planner URL/token live only server-side).
  const urls = [...src.matchAll(/['"`](https?:\/\/[^'"`]+)['"`]/g)].map((m) => m[1]);
  assert.equal(urls.length, 0, `no absolute URLs in the client bundle (found: ${urls.join(', ')})`);
});
