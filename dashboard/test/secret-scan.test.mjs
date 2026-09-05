import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { scanText, scanDirectory } from '../lib/secret-scan.mjs';

describe('lib/secret-scan scanText', () => {
  test('flags a DASH_ env name', () => {
    const hits = scanText('const x = "DASH_SESSION_SECRET leaked here";');
    assert.ok(hits.some((h) => h.pattern === 'DASH_ env name'));
  });

  test('flags a RADSVINN_ env name', () => {
    const hits = scanText('fetch(RADSVINN_SERVICE_TOKEN_DASHBOARD)');
    assert.ok(hits.some((h) => h.pattern === 'RADSVINN_ env name'));
  });

  test('flags GitHub token shapes', () => {
    assert.ok(scanText('token=ghp_abcdefghijklmnopqrstuvwxyz0123').some((h) => h.pattern.includes('ghp_')));
    assert.ok(scanText('token=gho_abcdefghijklmnopqrstuvwxyz0123').some((h) => h.pattern.includes('gho_')));
    assert.ok(scanText('github_pat_abcdefghijklmnopqrstuvwxyz012345').some((h) => h.pattern.includes('github_pat_')));
  });

  test('flags Slack token shapes', () => {
    assert.ok(scanText('xoxb-1234567890-abcdefgh').some((h) => h.pattern.includes('xoxb-')));
    assert.ok(scanText('xapp-1-A0123456-abcdefgh').some((h) => h.pattern.includes('xapp-')));
  });

  test('flags a client_secret literal', () => {
    assert.ok(scanText('const body = { client_secret: "whatever" }').some((h) => h.pattern.includes('client_secret')));
  });

  test('clean, ordinary UI-shaped source produces zero hits', () => {
    const clean = `
      export function el(tag) { return document.createElement(tag); }
      async function api(path) { return fetch(path).then((r) => r.json()); }
      const STATUS = { created: 'CREATED', failed: 'FAILED' };
    `;
    assert.deepEqual(scanText(clean), []);
  });

  test('does not infinite-loop on adjacent/zero-width-adjacent matches', () => {
    const many = 'RADSVINN_A RADSVINN_B RADSVINN_C '.repeat(50);
    const hits = scanText(many);
    assert.equal(hits.length, 150);
  });
});

describe('lib/secret-scan scanDirectory', () => {
  test('returns [] for a directory that does not exist (pre-UI dashboard/public/)', () => {
    assert.deepEqual(scanDirectory('/definitely/does/not/exist/anywhere'), []);
  });

  test('walks nested directories and flags violations with file paths', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-secret-scan-'));
    try {
      fs.writeFileSync(path.join(dir, 'clean.js'), 'console.log("hello world");');
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, 'nested', 'dirty.js'), 'const t = "ghp_abcdefghijklmnopqrstuvwxyz0123";');
      fs.mkdirSync(path.join(dir, 'node_modules'));
      fs.writeFileSync(path.join(dir, 'node_modules', 'ignored.js'), 'DASH_SESSION_SECRET');

      const hits = scanDirectory(dir);
      assert.equal(hits.length, 1);
      assert.ok(hits[0].file.endsWith(path.join('nested', 'dirty.js')));
      assert.ok(!hits.some((h) => h.file.includes('node_modules')), 'node_modules must be skipped');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ignores non-matching extensions', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-secret-scan-'));
    try {
      fs.writeFileSync(path.join(dir, 'secret.env'), 'DASH_SESSION_SECRET=abc');
      assert.deepEqual(scanDirectory(dir), []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
