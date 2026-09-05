#!/usr/bin/env node
// Exact-line allowances keep compatibility and history visible without hiding
// newly introduced branding elsewhere in an otherwise allowed source file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OLD_BRAND = /mercury/gi;
const CATEGORIES = new Set(['compatibility', 'historical', 'third-party', 'audit-guard']);
export function lineHash(text) { return crypto.createHash('sha256').update(text).digest('hex'); }

function excluded(file) {
  const parts = file.split('/');
  const name = parts.at(-1);
  return parts.some((part) => ['.git', 'node_modules'].includes(part))
    || /^(?:tasks|\.agents)\//.test(file)
    || ['CODEX-HANDOFF.md', 'CODEX_HANDOFF.md'].includes(file)
    || (/^\.env(?:\.|$)/.test(name) && !/^\.env\.(?:example|template|sample)$/.test(name))
    || name.endsWith('.env')
    || /^dashboard\/public\/fonts\/.*\.woff2$/.test(file);
}

export function auditIdentity({ root = ROOT, allowlist } = {}) {
  const entries = allowlist ?? JSON.parse(fs.readFileSync(path.join(root, 'docs/identity-reference-allowlist.json'), 'utf8'));
  const allowed = new Map();
  for (const entry of entries) {
    if (!entry.path || !/^[a-f0-9]{64}$/.test(entry.sha256) || !CATEGORIES.has(entry.category)
      || !entry.reason || !Number.isInteger(entry.count) || entry.count < 1) throw new Error('Invalid identity allowance');
    const key = entry.path + ':' + entry.sha256;
    if (allowed.has(key)) throw new Error('Duplicate identity allowance');
    allowed.set(key, { ...entry, remaining: entry.count });
  }
  const files = [...new Set(execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean))].sort();
  const occurrences = [];
  const failures = [];
  function record(file, line, text, kind = 'content') {
    OLD_BRAND.lastIndex = 0;
    if (!OLD_BRAND.test(text)) return;
    const key = file + ':' + lineHash(text);
    const entry = kind === 'content' ? allowed.get(key) : undefined;
    const accepted = entry && entry.remaining > 0;
    if (accepted) entry.remaining -= 1;
    const finding = { path: file, line, kind, category: accepted ? entry.category : 'unexplained', reason: accepted ? entry.reason : 'Unreviewed old identity reference', text };
    occurrences.push(finding);
    if (!accepted) failures.push(finding);
  }
  for (const file of files) {
    if (excluded(file)) continue;
    const absolute = path.join(root, file);
    let stat;
    try { stat = fs.lstatSync(absolute); }
    catch (err) { if (err.code === 'ENOENT') continue; else throw err; } // removed tracked path
    record(file, 0, file, 'filename');
    if (stat.isSymbolicLink()) { record(file, 1, fs.readlinkSync(absolute), 'symlink'); continue; }
    if (!stat.isFile()) continue;
    const content = fs.readFileSync(absolute, 'utf8');
    content.split(/\r?\n/).forEach((text, i) => record(file, i + 1, text));
  }
  for (const entry of allowed.values()) {
    if (entry.remaining) failures.push({ path: entry.path, category: 'stale-allowance', reason: 'Remove or review an unused exact-line allowance', sha256: entry.sha256 });
  }
  return { occurrences, failures };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = auditIdentity();
    for (const row of result.occurrences) console.log(JSON.stringify(row));
    for (const row of result.failures.filter((r) => r.category === 'stale-allowance')) console.error(JSON.stringify(row));
    console.log(JSON.stringify({ references: result.occurrences.length, unexplained: result.failures.length }));
    process.exitCode = result.failures.length ? 1 : 0;
  } catch (err) {
    console.error(`Identity audit could not complete: ${err.message}`);
    process.exitCode = 2;
  }
}
