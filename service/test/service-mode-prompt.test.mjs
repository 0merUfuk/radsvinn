// service-mode-prompt.test.mjs — service-mode prompt posture.
// In service mode the agent runs under `--allowedTools Read,Grep,Glob`, but
// the shared workflow (.claude/agents/jira-planner.md — the INTERACTIVE
// path, which really holds Bash/Write) orders it to git-fetch, Write its
// artifacts, and run treecheck; every attempt is DENIED and costs a full
// model round-trip. Both per-call
// service messages open with a `# TOOLS` directive stating the real
// posture, and their Write/gate imperatives soften to match (the service
// owns fetch/persistence/gating control-plane). phase1Message
// injects the coupling map that prompts/decomposer.md always promised
// ("injected YAML") — no more self-read turn, and the two no-go-zone
// coupling-safety stanzas are UNCONDITIONALLY in front of the agent.
//
// Pure prompt-construction units — no server, no subprocess, zero network.
// The shared prompt files and the agent definition are deliberately NOT
// touched by these fixes; the interactive path keeps its full workflow.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MERCURY_ROOT } from '../state.mjs';
import { phase1Message, groomMessage, loadPromptBody } from '../engine.mjs';

const BASE = { ask: 'do the thing', requester: 'test-requester', roleLens: 'business', runDir: '/tmp/run-x', outputLanguage: 'en' };
const DECOMPOSER_PROMPT = path.join(MERCURY_ROOT, 'prompts', 'decomposer.md');
const GROOMER_PROMPT = path.join(MERCURY_ROOT, 'prompts', 'groomer.md');

// Saves + restores one env var around a test (same discipline as the
// buildClaudeArgs test in grounding-hint.test.mjs).
function stashEnv(t, key) {
  const prev = process.env[key];
  t.after(() => {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  });
}

// ---------------------------------------------------------------------------
// Prompt-body delivery
// ---------------------------------------------------------------------------

test('prompt bodies lead both composed messages; loader trims, caches, and degrades without throwing', (t) => {
  const decomposerBody = loadPromptBody(DECOMPOSER_PROMPT);
  const groomerBody = loadPromptBody(GROOMER_PROMPT);
  const p1 = phase1Message(BASE);
  const groom = groomMessage({ edited: false, runDir: BASE.runDir, outputLanguage: 'en' });

  assert.ok(p1.startsWith(`${decomposerBody}\n\n# OUTPUT LANGUAGE\nen\n`),
    'phase1 starts with the complete decomposer body before its directives');
  assert.ok(groom.startsWith(`${groomerBody}\n\n# OUTPUT LANGUAGE\nen\n`),
    'groom starts with the complete groomer body before its directives');
  assert.match(decomposerBody, /Emit \*\*exactly one JSON object\*\* conforming to `contracts\/skeleton\.schema\.json`/,
    'the delivered decomposer body carries the schema contract');
  assert.match(groomerBody, /Emit \*\*exactly one JSON object\*\* conforming to `contracts\/plan\.schema\.json`/,
    'the delivered groomer body carries the schema contract');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-prompt-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const cachedPath = path.join(dir, 'cached.md');
  fs.writeFileSync(cachedPath, '  prompt-cache-A  \n');
  assert.equal(loadPromptBody(cachedPath), 'prompt-cache-A', 'the first read is trimmed');
  fs.writeFileSync(cachedPath, 'prompt-cache-B');
  assert.equal(loadPromptBody(cachedPath), 'prompt-cache-A', 'later edits do not bypass the per-path cache');

  const missingPath = path.join(dir, 'missing.md');
  let fallback;
  assert.doesNotThrow(() => { fallback = loadPromptBody(missingPath); });
  assert.equal(fallback, `[prompt body unavailable at ${missingPath} — emit valid JSON per the contract schema]`);
  fs.writeFileSync(missingPath, 'late prompt body');
  assert.equal(loadPromptBody(missingPath), fallback, 'the graceful fallback is cached per path too');
});

// ---------------------------------------------------------------------------
// The `# TOOLS` directive
// ---------------------------------------------------------------------------

test('tools directive: BOTH phase1 and groom messages carry it under the safe default posture, and the denied imperatives are gone', (t) => {
  stashEnv(t, 'MERCURY_AGENT_ALLOWED_TOOLS');
  delete process.env.MERCURY_AGENT_ALLOWED_TOOLS; // the safe default: Read,Grep,Glob

  const p1 = phase1Message(BASE);
  const groom = groomMessage({ edited: false, runDir: BASE.runDir, outputLanguage: 'en' });

  for (const [name, msg] of [['phase1', p1], ['groom', groom]]) {
    assert.ok(msg.includes('# TOOLS'), `${name}: the directive block must be present`);
    assert.ok(msg.includes('Your tools in this run are Read, Grep, Glob ONLY.'),
      `${name}: the directive names the resolved allowlist`);
    assert.ok(msg.includes('(including'), `${name}: treecheck is called out`);
    assert.ok(msg.includes('`treecheck`)'), `${name}: treecheck is called out by name`);
    assert.ok(msg.includes('every denied attempt wastes a turn.'),
      `${name}: the directive states the cost of an attempt`);
    assert.ok(msg.includes("prompt's self-check as PROSE reasoning, not by invoking a tool."),
      `${name}: the self-check is redirected to prose, not a gate run`);
  }

  // The tail imperatives that INVITED the denied attempts are softened:
  // the service writes the artifact and runs the gate itself.
  assert.equal(p1.includes('Run the skeleton gate'), false,
    'phase1: the agent is no longer told to run the gate — the service gates server-side');
  assert.equal(p1.includes('Write all Phase 1 artifacts'), false,
    'phase1: the agent is no longer told to Write the artifacts');
  assert.match(p1, /Present the shape, then STOP; do not proceed to Phase 2\./);
  assert.ok(p1.includes(`The run directory for this plan is: ${BASE.runDir}`),
    'phase1: the run directory stays visible (context, not an instruction to write)');
  assert.equal(groom.includes('run the plan gate'), false,
    'groom: the agent is no longer told to run the gate');
  assert.equal(groom.includes('write plan.json'), false,
    'groom: the agent is no longer told to Write plan.json');
  assert.match(groom, /present the summary, STOP\./);
});

test('tools directive coexists with — and reinforces — the emit-JSON-verbatim contract (both instructions present)', (t) => {
  stashEnv(t, 'MERCURY_AGENT_ALLOWED_TOOLS');
  delete process.env.MERCURY_AGENT_ALLOWED_TOOLS;

  const p1 = phase1Message(BASE);
  const groom = groomMessage({ edited: false, runDir: BASE.runDir, outputLanguage: 'en' });

  for (const [name, msg, artifact] of [['phase1', p1, 'skeleton'], ['groom', groom, 'plan']]) {
    assert.ok(msg.includes('Your tools in this run are Read, Grep, Glob ONLY.'), `${name}: directive present`);
    assert.ok(msg.includes('ALWAYS include the complete,'), `${name}: the verbatim-JSON safety net is untouched`);
    assert.ok(msg.includes(`valid ${artifact} JSON verbatim in a fenced \`\`\`json code block`),
      `${name}: the fenced-block contract names the artifact`);
    assert.ok(msg.includes('the service reads it from there as the source of truth.'),
      `${name}: the source-of-truth sentence survives`);
  }
});

test('a deliberately loosened posture (Bash/Write allowed) suppresses the directive and keeps the interactive-style imperatives byte-for-byte', (t) => {
  stashEnv(t, 'MERCURY_AGENT_ALLOWED_TOOLS');
  process.env.MERCURY_AGENT_ALLOWED_TOOLS = 'Read,Write,Grep,Glob,Bash';

  const p1 = phase1Message(BASE);
  assert.equal(p1.includes('# TOOLS'), false,
    'the directive would be FALSE under a loosened posture — inject nothing');
  assert.match(p1, /Write all Phase 1 artifacts under this exact directory/);
  assert.match(p1, /Run the skeleton gate, present the shape, then STOP; do not proceed to Phase 2\./);

  const groom = groomMessage({ edited: false, runDir: BASE.runDir, outputLanguage: 'en' });
  assert.equal(groom.includes('# TOOLS'), false);
  assert.ok(groom.includes('write plan.json next to'), 'groom keeps the write imperative when Write is real');
  assert.ok(groom.includes('run the plan gate'), 'groom keeps the gate imperative when Bash is real');

  // An EMPTY allowlist passes no --allowedTools at all (CLI defaults apply)
  // — the directive must not claim "no tools"; inject nothing.
  process.env.MERCURY_AGENT_ALLOWED_TOOLS = '';
  assert.equal(phase1Message(BASE).includes('# TOOLS'), false, 'empty allowlist injects no directive');
});

// ---------------------------------------------------------------------------
// The `# COUPLING MAP` injection
// ---------------------------------------------------------------------------

test('phase1Message: `# COUPLING MAP` carries the REAL map — the no-go-zone money-safety stanza unconditionally present; groom does NOT re-inject', (t) => {
  stashEnv(t, 'MERCURY_COUPLING_MAP');
  delete process.env.MERCURY_COUPLING_MAP; // the repo's own coupling-map.yaml

  const p1 = phase1Message(BASE);
  assert.ok(p1.includes('# COUPLING MAP'), 'the block must be present');
  assert.ok(p1.includes('This is the full coupling map (no-go zones + module edges) — use it for'),
    'the block explains what it is');
  assert.ok(p1.includes('you do NOT need to Read'),
    'the agent is told the self-read turn is unnecessary');
  // Real content from the repo map — the safety payoff of the fix: the
  // no-go-zone stanza is in EVERY phase-1 prompt, not conditional on the
  // agent choosing to Read the file.
  assert.ok(p1.includes('no_go_zones:'), 'the injected text is the real YAML');
  assert.ok(p1.includes('id: shared-write'), 'the money-write zone is unconditionally present');
  // Placement: trusted reference DATA after the ask, alongside the other
  // service-injected material — never between the directives and the ask.
  assert.ok(p1.indexOf('# COUPLING MAP') > p1.indexOf('do the thing'), 'the map sits after the ask');
  assert.ok(p1.indexOf('# COUPLING MAP') < p1.indexOf('ALWAYS include the complete,'),
    'the map precedes the closing artifact instructions');

  // Groom resumes the phase-1 session — the map is already in its context;
  // re-injecting would pay its ~3-4K tokens twice.
  const groom = groomMessage({ edited: false, runDir: BASE.runDir, outputLanguage: 'en' });
  assert.equal(groom.includes('# COUPLING MAP'), false, 'groom never re-injects the map');
  assert.equal(groom.includes('no_go_zones:'), false, 'no map content leaks into the groom message');
});

test('missing/unreadable coupling map: phase1Message still builds, injects the graceful fallback note, never throws', (t) => {
  stashEnv(t, 'MERCURY_COUPLING_MAP');
  // A path that provably does not exist — a laptop/test checkout without
  // the file must still plan.
  process.env.MERCURY_COUPLING_MAP = path.join(os.tmpdir(), `mercury-no-map-${Date.now()}`, 'coupling-map.yaml');

  let p1;
  assert.doesNotThrow(() => { p1 = phase1Message(BASE); });
  assert.ok(p1.includes('# COUPLING MAP'), 'the block header still anchors the section');
  assert.ok(p1.includes('Not injected this run (the map file was missing or unreadable).'),
    'the fallback note is explicit about the degradation');
  assert.ok(p1.includes('Read it before'),
    'the fallback restores the pre-fix behavior: the agent self-reads if the file exists');
  assert.equal(p1.includes('no_go_zones:'), false, 'no fabricated map content');
});

test('coupling-map cache: the file is read ONCE per path — later edits do not change the injected content', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-map-cache-'));
  const mapPath = path.join(dir, 'coupling-map.yaml');
  fs.writeFileSync(mapPath, 'no_go_zones: [cache-proof-A]\n');
  stashEnv(t, 'MERCURY_COUPLING_MAP');
  process.env.MERCURY_COUPLING_MAP = mapPath;
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const first = phase1Message(BASE);
  assert.ok(first.includes('cache-proof-A'), 'the first build reads the file');

  // Overwrite the file — a cached loader must NOT see the new content. This
  // proves the read-once contract without a spy: identical output alone
  // would also pass on an uncached loader.
  fs.writeFileSync(mapPath, 'no_go_zones: [cache-proof-B]\n');
  const second = phase1Message(BASE);
  assert.ok(second.includes('cache-proof-A'), 'the second build serves the module-scope cache');
  assert.equal(second.includes('cache-proof-B'), false, 'the file was not re-read');
});
