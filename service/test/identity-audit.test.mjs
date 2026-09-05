import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { auditIdentity, lineHash } from '../../tools/audit-identity.mjs';

test('reference audit rejects injected doc/source/path branding and stale or overbroad allowances', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-audit-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet', root]);
  fs.writeFileSync(path.join(root, 'README.md'), '# Radsvinn\n');
  assert.deepEqual(auditIdentity({ root, allowlist: [] }).failures, []);
  for (const [file, text] of [['README.md', '# MeRcUrY'], ['source.mjs', '// Mercury'], ['mercury-path.md', '# Radsvinn']]) {
    fs.writeFileSync(path.join(root, file), text);
    assert.ok(auditIdentity({ root, allowlist: [] }).failures.some((r) => r.path === file));
    fs.rmSync(path.join(root, file));
  }
  const text = 'Legacy MERCURY_SETTING fixture';
  fs.writeFileSync(path.join(root, 'compat.md'), text);
  const allowlist = [{ path: 'compat.md', sha256: lineHash(text), count: 1, category: 'compatibility', reason: 'Fixture for exact-line enforcement' }];
  assert.deepEqual(auditIdentity({ root, allowlist }).failures, []);
  fs.appendFileSync(path.join(root, 'compat.md'), '\nMercury is current\n');
  assert.equal(auditIdentity({ root, allowlist }).failures.length, 1);
  fs.writeFileSync(path.join(root, 'compat.md'), '# Radsvinn');
  assert.equal(auditIdentity({ root, allowlist }).failures[0].category, 'stale-allowance');
});
