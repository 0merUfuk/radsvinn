// search-terms.test.mjs — the dup-search UTF-8 fix + seed preference
// Two search-normalization failure shapes:
// (1) searchTerms()'s old `[^A-Za-z0-9 ]` strip reduced a Turkish ask to
// garbage — the live JQL rendered `summary ~ "taski zel bir teri istedi
// task"` ("özel"→"zel", "müşteri"→"teri") — useless for ANY non-ASCII
// language; (2) seeding from the raw ask prefix missed an on-board
// near-identical epic that the skeleton's own concise epic summary would
// have matched.
//
// searchTerms is exported from server.mjs as the unit seam; the seed
// preference is proven at the service level through a capture engine over
// the fake (createServer's documented options.engine seam).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { postJson, getJson, pollUntil } from './helpers.mjs';
import { createServer, searchTerms } from '../server.mjs';
import { createEngine } from '../engine.mjs';

// -- unit: the Unicode-aware term builder ------------------------------------

test('searchTerms: Unicode letters survive — Turkish özel/müşteri stay intact (the live mangling bug)', () => {
  assert.equal(
    searchTerms('müşteri özel bir workflow istedi'),
    'müşteri özel bir workflow istedi',
    'an all-Turkish ask passes through whole',
  );
  // The old regex rendered this as
  // "taski zel bir teri istedi task".
  const terms = searchTerms('taskı özel bir müşteri istedi task');
  assert.match(terms, /özel/, '"özel" must not degrade to "zel"');
  assert.match(terms, /müşteri/, '"müşteri" must not degrade to "teri"');
  assert.equal(/(^| )(zel|teri)( |$)/.test(terms), false, 'no mangled fragments');
});

test('searchTerms: the ~6-significant-words shape is unchanged — punctuation strips, short words drop, 7th word cut, empty falls back', () => {
  assert.equal(searchTerms('fix: the "auth" bug, now!!'), 'fix the auth bug now', 'punctuation still strips (JQL noise)');
  assert.equal(searchTerms('an ab abc'), 'abc', 'words of length <= 2 still drop');
  assert.equal(
    searchTerms('one two three four five six seven eight'),
    'one two three four five six',
    'capped at 6 significant words',
  );
  assert.equal(searchTerms(''), 'plan', 'empty input keeps the "plan" fallback');
  assert.equal(searchTerms('!! ?? ..'), 'plan', 'all-punctuation input keeps the fallback');
});

// -- service wire: the seed preference ---------------------------------------

// Boots a server with a capture engine over the fake — records what
// engine.search receives, exactly as the real engine would.
async function startCaptureServer(t) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-search-seed-'));
  // These fake-mode wire tests do not seed grounding repositories, so use the
  // fake-only whole-plan-gate skip (set/restore locally so the file passes
  // standalone too).
  const prevSkip = process.env.MERCURY_SKIP_PLAN_ANCHORS;
  process.env.MERCURY_SKIP_PLAN_ANCHORS = '1';

  const fake = createEngine('fake');
  const searchCalls = [];
  const engine = {
    ...fake,
    async search(args) {
      searchCalls.push(args);
      return fake.search(args);
    },
  };
  const app = createServer({ engineMode: 'fake', engine, resultsDir });
  const addr = await app.listen(0, '127.0.0.1');
  t.after(async () => {
    await app.close();
    if (prevSkip === undefined) delete process.env.MERCURY_SKIP_PLAN_ANCHORS;
    else process.env.MERCURY_SKIP_PLAN_ANCHORS = prevSkip;
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });
  return { baseUrl: `http://127.0.0.1:${addr.port}`, searchCalls };
}

async function driveToPlanReady(baseUrl, { description, skeletonEdits } = {}) {
  const res = await postJson(baseUrl, '/plan', { description, requester: 'test-requester' });
  assert.equal(res.status, 202);
  const planId = res.body.plan_id;
  await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'breaking_down', { timeoutMs: 30000 });
  const approved = await postJson(baseUrl, `/plan/${planId}/approve-shape`, skeletonEdits ? { skeleton_edits: skeletonEdits } : {});
  assert.equal(approved.status, 202);
  const ready = await pollUntil(() => getJson(baseUrl, `/plan/${planId}`), (r) => r.body.status !== 'grooming');
  assert.equal(ready.body.status, 'plan_ready');
  return planId;
}

test('dup-search seed: the skeleton epic summary is preferred over the ask prefix (the live near-miss)', async (t) => {
  const { baseUrl, searchCalls } = await startCaptureServer(t);

  // A Turkish ask whose prefix is NOT the on-board-comparable title; the
  // fake engine's fixture skeleton carries the concise epic summary.
  const ask = 'müşteri kendi üretim geçmişini prompt metniyle arayabilsin diye bir özellik istiyoruz';
  await driveToPlanReady(baseUrl, { description: ask });

  assert.equal(searchCalls.length, 1, 'exactly one advisory dup-search at plan_ready');
  assert.equal(
    searchCalls[0].terms,
    searchTerms('Growth: Search generation history by prompt text'),
    'engine.search receives terms built from the fixture skeleton epic summary, not the ask',
  );
  assert.notEqual(searchCalls[0].terms, searchTerms(ask), 'sanity: the two seeds genuinely differ here');
});

test('dup-search seed: a one-node skeleton (epic: null) falls back to the ask prefix — Turkish intact end-to-end', async (t) => {
  const { baseUrl, searchCalls } = await startCaptureServer(t);

  // Replace the shape via approve-shape's skeleton_edits with a gate-legal
  // one-node skeleton (epic: null) — the documented edit path, real gate.
  const oneNode = {
    plan_id: 'one-node-search-seed',
    requester: 'test-requester',
    mode: 'front_door',
    epic: null,
    milestones: [],
    items: [
      {
        temp_id: 'i1',
        type: 'Task',
        parent_temp_id: null,
        depends_on: [],
        milestone_id: null,
        repo: 'web-app',
        size_estimate: { tier: 'low', predicted_cost_usd: 2.0, rationale: 'single focused config change, one PR' },
        one_line_summary: 'Add prompt search input to history page',
      },
    ],
  };
  const ask = 'müşteri kendi üretim geçmişini prompt metniyle arayabilsin';
  await driveToPlanReady(baseUrl, { description: ask, skeletonEdits: oneNode });

  assert.equal(searchCalls.length, 1);
  assert.equal(
    searchCalls[0].terms,
    'müşteri kendi üretim geçmişini prompt metniyle',
    'no epic → the ask prefix seeds the search, with Turkish letters preserved',
  );
});
