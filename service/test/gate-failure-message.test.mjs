// gate-failure-message.test.mjs — the skeleton-gate failure translator.
//
// Clean-errors (2026-07-13): describeSkeletonGateFailure returns ONLY a friendly
// human sentence — the raw gate JSON is console.error'd + persisted on
// plan.skeleton_gate for operators, never shown to the user. The sizing×scope
// branch is GONE: sizing conventions are advisory WARNs, so genuine structural
// blockers fall through to the generic firstFailingComplaint path (surfacing
// the ACTUAL complaint, not the old, now-wrong "oversized ticket" copy).

import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSkeletonGateFailure } from '../server.mjs';

// A real structural hard fail: cycles remain non-negotiable even when sizing
// conventions are advisory.
const STRUCTURAL_GATE = {
  ok: false,
  raw: {
    ok: false,
    checks: {
      acyclic: { pass: false, complaints: ['depends_on cycle detected: a → b → a'] },
      hierarchy_legal: { pass: true },
      milestone_shippable: { pass: true },
      order_consistent: { pass: true },
      sizing_sane: { pass: true },
    },
    hard_fail: true,
    regen_complaint: 'depends_on cycle detected: a → b → a',
  },
};

test('a structural fail leads with the ACTUAL complaint — never the old "oversized ticket" / scope copy', () => {
  // Regression guard for the misrouted-message finding: a hard structural
  // failure must surface its real complaint rather than obsolete scope advice.
  for (const plan of [{ scope_hint: 'single' }, { scope_hint: 'small' }, { scope_hint: 'auto' }, {}, undefined]) {
    const msg = describeSkeletonGateFailure(STRUCTURAL_GATE, plan);
    assert.match(msg, /^Radsvinn's draft failed a required structural check: depends_on cycle/, 'the actual complaint leads');
    assert.doesNotMatch(msg, /oversized ticket/, 'the old misrouted sizing copy is gone');
    assert.doesNotMatch(msg, /bigger than your/, 'no sizing×scope advice — that branch is removed');
  }
});

test('the returned message is ONLY the human sentence — no raw gate JSON leaks to the user', () => {
  const msg = describeSkeletonGateFailure(STRUCTURAL_GATE, { scope_hint: 'auto' });
  assert.doesNotMatch(msg, /skeleton gate failed \(server-side re-verification\)/, 'the raw operator line is logs-only');
  assert.doesNotMatch(msg, /"checks"|"acyclic"|"regen_complaint"/, 'no raw gate JSON on the user surface');
  assert.ok(msg.length < 300, 'a clean one-liner, not a blob');
});

test('a contract hard-fail leads with a clean human sentence, no raw JSON', () => {
  const contractGate = {
    ok: false,
    raw: {
      ok: false,
      checks: { contract_valid: { pass: false, complaints: ['malformed skeleton JSON: json: unknown field "id"'] } },
      hard_fail: true,
      regen_complaint: 'malformed skeleton JSON: json: unknown field "id"',
    },
  };
  const msg = describeSkeletonGateFailure(contractGate, { scope_hint: 'auto' });
  assert.match(msg, /^Radsvinn's draft didn't match the required ticket shape \(a contract error:/);
  assert.match(msg, /unknown field "id"/);
  assert.doesNotMatch(msg, /skeleton gate failed \(server-side re-verification\)/);
});

test('a non-sizing structural fail (e.g. a cycle) leads with the failing complaint, never scope advice, never raw', () => {
  const structuralFail = { ok: false, raw: { ok: false, checks: { acyclic: { pass: false, complaints: ['depends_on cycle detected: a → b → a'] } }, hard_fail: true } };
  const msg = describeSkeletonGateFailure(structuralFail, { scope_hint: 'single' });
  assert.match(msg, /^Radsvinn's draft failed a required structural check: depends_on cycle/, 'the failing complaint leads');
  assert.doesNotMatch(msg, /Re-run \/plan/, 'no false sizing×scope advice on a structural fail');
  assert.doesNotMatch(msg, /skeleton gate failed \(server-side re-verification\)/, 'the raw is logs-only');
});

test('a malformed failing check with a LEADING advisory WARN still leads with the hard blocker, not the WARN', () => {
  // Defensive display behavior: even if a future gate returns a mixed result,
  // a hard failure must never render a WARN as the blocking reason.
  const mixed = {
    ok: false,
    raw: {
      ok: false,
      checks: {
        acyclic: {
          pass: false,
          complaints: [
            'WARN: i5: leaf predicted_cost_usd $48.00 exceeds $10.00 — consider splitting (advisory)',
            'depends_on cycle detected: a → b → a',
          ],
        },
      },
      hard_fail: true,
    },
  };
  const msg = describeSkeletonGateFailure(mixed, { scope_hint: 'auto' });
  assert.match(msg, /^Radsvinn's draft failed a required structural check: depends_on cycle/, 'the hard blocker leads');
  assert.doesNotMatch(msg, /WARN:/, 'the advisory WARN is not surfaced as the blocker');
  assert.doesNotMatch(msg, /advisory/, 'no advisory copy leaks into the blocker sentence');
});

test('malformed gate objects degrade to a clean human fallback sentence, never throw, never a raw blob', () => {
  for (const gate of [{ ok: false }, { ok: false, raw: null }, { ok: false, raw: 'garbage' }]) {
    const msg = describeSkeletonGateFailure(gate, { scope_hint: 'single' });
    assert.equal(msg, "Radsvinn's draft failed server-side re-verification. Retry re-plans from scratch.");
  }
});
