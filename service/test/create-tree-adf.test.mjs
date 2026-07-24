// create-tree-adf.test.mjs — proseToADF's CRLF normalization, proven through
// the tool's own `--show-adf` seam (dry, zero
// network: it prints the full create request body — ADF description included
// — and exits). Before the fix, '\r\n' input defeated every '\n'-keyed split
// in proseToADF: '\r\n\r\n' never matched the blank-line splitter
// /\n[ \t]*\n+/ ('\r' is neither space nor tab), collapsing intended
// paragraphs into one, and stray '\r' rode into ADF text nodes as invisible
// control characters.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const TOOL = path.join(ROOT, 'tools', 'create-tree.mjs');
const FIXTURE_DIR = path.join(ROOT, 'fixtures', 'e2e-sample');

// Walks an ADF node tree collecting every text-node string.
function textNodes(node, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (node.type === 'text' && typeof node.text === 'string') out.push(node.text);
  for (const child of node.content || []) textNodes(child, out);
  return out;
}

test('proseToADF via --show-adf: CRLF input normalizes — paragraphs split, bullets list, zero \\r in any text node', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-adf-crlf-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Fixture COPY with a CRLF-structured why on i1: two paragraphs (CRLF
  // blank line), a hardBreak inside the first, and a dash list.
  const plan = JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, 'plan.json'), 'utf8'));
  plan.items[0].fields.why = 'First para line one.\r\nline two.\r\n\r\nSecond para.\r\n\r\n- bullet a\r\n- bullet b';
  fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
  fs.copyFileSync(path.join(FIXTURE_DIR, 'skeleton.json'), path.join(dir, 'skeleton.json'));

  const res = spawnSync(process.execPath, [TOOL, '--plan', path.join(dir, 'plan.json'), '--scope', 'full', '--show-adf', 'i1'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(res.status, 0, res.stderr);

  // Output = `# …` comment lines, then the JSON body.
  const jsonStart = res.stdout.indexOf('{');
  assert.ok(jsonStart >= 0, `no JSON body in --show-adf output:\n${res.stdout}`);
  const body = JSON.parse(res.stdout.slice(jsonStart));
  const description = body.fields.description;

  // The CRLF leak: not one '\r' may survive into any ADF text node.
  const texts = textNodes(description);
  assert.ok(texts.length > 0);
  assert.equal(texts.some((s) => s.includes('\r')), false, 'no \\r in any ADF text node');

  // The structure the groomer intended survives CRLF line endings exactly
  // as it does LF ones: two separate paragraphs + a two-item bulletList.
  const flat = JSON.stringify(description);
  assert.ok(flat.includes('"First para line one."'), 'first paragraph line survives as its own text node');
  assert.ok(flat.includes('"line two."'), 'the hardBreak-joined second line survives');
  assert.ok(flat.includes('"Second para."'), 'the blank-line split produced a second paragraph');
  const bullets = (description.content || []).flatMap((n) => (n.type === 'bulletList' ? textNodes(n) : []));
  assert.deepEqual(bullets.slice(0, 2), ['bullet a', 'bullet b'], 'the dash list renders as a bulletList');
  // 'Second para.' must NOT share a paragraph with the first block — find
  // the paragraph containing 'First para line one.' and assert it does not
  // also carry 'Second para.'.
  const firstPara = (description.content || []).find((n) => n.type === 'paragraph' && textNodes(n).includes('First para line one.'));
  assert.ok(firstPara, 'the first paragraph node exists');
  assert.equal(textNodes(firstPara).includes('Second para.'), false, 'the CRLF blank line splits paragraphs (the pre-fix collapse)');
});
