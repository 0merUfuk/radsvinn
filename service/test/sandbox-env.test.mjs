// sandbox-env.test.mjs — child-env isolation posture, unit level (Phase B, B3a + B3c).
//
// (a) sandboxedEnv: the LLM subprocess env strip. The planning agent needs
//     ONLY the Anthropic credential; everything else a prompt-injected ask
//     could echo (Slack tokens, both planner service bearer tokens, GitHub fetch
//     credentials, Railway platform metadata) must be gone BEFORE spawn.
// (b) buildClaudeArgs: `--add-dir <reposRoot>` is present exactly when the
//     resolved grounding root exists — the agent must be able to READ the
//     repos it grounds anchors in (they live outside the app dir in the
//     container), and a laptop without the checkout keeps the legacy argv.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sandboxedEnv, buildClaudeArgs } from '../engine.mjs';

const STRIPPED = [
  'RADSVINN_JIRA_TOKEN',
  'SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'RADSVINN_SERVICE_TOKEN',
  'RADSVINN_SERVICE_TOKEN_DASHBOARD',
  'GITHUB_TOKEN',
  'GH_TOKEN',
];

test('sandboxedEnv: sandboxedEnv strips every non-Anthropic credential and the whole RAILWAY_*/SLACK_* families; ANTHROPIC_API_KEY and plumbing survive', () => {
  const input = {
    ANTHROPIC_API_KEY: 'sk-keep-me',
    PATH: '/usr/bin',
    HOME: '/data/home',
    RADSVINN_RESULTS_DIR: '/data/results',
    RADSVINN_JIRA_TOKEN: 'leak-1',
    SLACK_APP_TOKEN: 'xapp-leak',
    SLACK_BOT_TOKEN: 'xoxb-leak',
    // NOT on the explicit strip list — the SLACK_ prefix rule must catch
    // future family additions by construction, never by remembering.
    SLACK_SIGNING_SECRET: 'sig-leak',
    SLACK_WEBHOOK_URL: 'https://hooks.slack.com/leak',
    RADSVINN_SERVICE_TOKEN: 'bearer-leak',
    RADSVINN_SERVICE_TOKEN_DASHBOARD: 'dashboard-bearer-leak',
    GITHUB_TOKEN: 'ghp-leak',
    GH_TOKEN: 'gho-leak',
    RAILWAY_ENVIRONMENT: 'production',
    RAILWAY_PROJECT_ID: 'proj-123',
    RAILWAY_SERVICE_NAME: 'radsvinn',
    RADSVINN_OPENROUTER_API_KEY: 'or-leak',
    OPENROUTER_API_KEY: 'or-alt-leak',
  };
  const out = sandboxedEnv(input);

  assert.equal(out.ANTHROPIC_API_KEY, 'sk-keep-me', 'the one credential the agent needs survives');
  assert.equal(out.PATH, '/usr/bin');
  assert.equal(out.HOME, '/data/home');
  assert.equal(out.RADSVINN_RESULTS_DIR, '/data/results');
  assert.equal(out.RADSVINN_OPENROUTER_API_KEY, undefined, 'the source OpenRouter credential is never useful to a child');
  assert.equal(out.OPENROUTER_API_KEY, undefined, 'alternate source key name is stripped too');

  for (const key of STRIPPED) {
    assert.ok(!(key in out), `${key} must be stripped`);
  }
  for (const key of Object.keys(out)) {
    assert.ok(!key.startsWith('RAILWAY_'), `${key} — every RAILWAY_* key must be stripped`);
    assert.ok(!key.startsWith('SLACK_'), `${key} — every SLACK_* key must be stripped, listed or not`);
  }

  // Pure: the input env is never mutated.
  assert.equal(input.RADSVINN_JIRA_TOKEN, 'leak-1');
  assert.equal(input.RAILWAY_PROJECT_ID, 'proj-123');
  assert.equal(input.SLACK_SIGNING_SECRET, 'sig-leak');
});

test('buildClaudeArgs: buildClaudeArgs adds --add-dir <reposRoot> only when the resolved root exists', (t) => {
  const prev = process.env.RADSVINN_REPOS_ROOT;
  t.after(() => {
    if (prev === undefined) delete process.env.RADSVINN_REPOS_ROOT;
    else process.env.RADSVINN_REPOS_ROOT = prev;
  });

  const existing = fs.mkdtempSync(path.join(os.tmpdir(), 'radsvinn-repos-root-'));
  t.after(() => fs.rmSync(existing, { recursive: true, force: true }));

  process.env.RADSVINN_REPOS_ROOT = existing;
  const withRoot = buildClaudeArgs({ userMessage: 'm', sessionId: 's', resume: false });
  const flagIdx = withRoot.indexOf('--add-dir');
  assert.notEqual(flagIdx, -1, '--add-dir present when the root exists');
  assert.equal(withRoot[flagIdx + 1], existing, 'and it names the resolved root');

  process.env.RADSVINN_REPOS_ROOT = path.join(existing, 'does-not-exist');
  const withoutRoot = buildClaudeArgs({ userMessage: 'm', sessionId: 's', resume: false });
  assert.equal(withoutRoot.indexOf('--add-dir'), -1, 'no --add-dir when the root is missing — legacy argv preserved');
});

// ---------------------------------------------------------------------------
// Per-seat model/effort resolution (2026-07-11 cost directive): decompose may
// run a cheaper/faster Claude model while groom keeps the strongest one.
// ---------------------------------------------------------------------------

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

test('seat config: RADSVINN_AGENT_MODEL_DECOMPOSE applies to phase1 ONLY; groom falls back to the shared/default ladder', (t) => {
  const prev = { ...process.env };
  t.after(() => { for (const k of ['RADSVINN_AGENT_MODEL_DECOMPOSE', 'RADSVINN_AGENT_MODEL_GROOM', 'RADSVINN_AGENT_MODEL', 'RADSVINN_AGENT_EFFORT_DECOMPOSE', 'RADSVINN_AGENT_EFFORT']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });

  process.env.RADSVINN_AGENT_MODEL_DECOMPOSE = 'sonnet';
  process.env.RADSVINN_AGENT_EFFORT_DECOMPOSE = 'high';
  delete process.env.RADSVINN_AGENT_MODEL;
  delete process.env.RADSVINN_AGENT_EFFORT;
  delete process.env.RADSVINN_AGENT_MODEL_GROOM;

  const p1 = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: false, kind: 'phase1' });
  assert.equal(argValue(p1, '--model'), 'sonnet', 'decompose seat takes the seat-specific model');
  assert.equal(argValue(p1, '--effort'), 'high', 'decompose seat takes the seat-specific effort');

  const groom = buildClaudeArgs({ userMessage: 'm', sessionId: 's-1', resume: true, kind: 'groom' });
  assert.equal(argValue(groom, '--model'), 'opus', 'groom is untouched by the decompose override — policy default holds');
  assert.equal(argValue(groom, '--effort'), 'xhigh');
});

test('seat config: the shared RADSVINN_AGENT_MODEL still governs BOTH seats when no seat override exists (existing deploys unchanged)', (t) => {
  const prev = { ...process.env };
  t.after(() => { for (const k of ['RADSVINN_AGENT_MODEL_DECOMPOSE', 'RADSVINN_AGENT_MODEL_GROOM', 'RADSVINN_AGENT_MODEL']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });

  process.env.RADSVINN_AGENT_MODEL = 'opus';
  delete process.env.RADSVINN_AGENT_MODEL_DECOMPOSE;
  delete process.env.RADSVINN_AGENT_MODEL_GROOM;

  for (const kind of ['phase1', 'groom']) {
    const args = buildClaudeArgs({ userMessage: 'm', sessionId: 's-2', resume: kind === 'groom', kind });
    assert.equal(argValue(args, '--model'), 'opus', `${kind}: shared override honored`);
  }
  // Seat override beats shared; shared beats default.
  process.env.RADSVINN_AGENT_MODEL_GROOM = 'opus';
  process.env.RADSVINN_AGENT_MODEL_DECOMPOSE = 'sonnet';
  assert.equal(argValue(buildClaudeArgs({ userMessage: 'm', sessionId: 's-2', resume: false, kind: 'phase1' }), '--model'), 'sonnet');
  assert.equal(argValue(buildClaudeArgs({ userMessage: 'm', sessionId: 's-2', resume: true, kind: 'groom' }), '--model'), 'opus');
});

test('seat config: an omitted kind resolves as the GROOM seat (fail toward the stronger model, never the cheaper one)', (t) => {
  const prev = { ...process.env };
  t.after(() => { for (const k of ['RADSVINN_AGENT_MODEL_DECOMPOSE']) { if (prev[k] === undefined) delete process.env[k]; else process.env[k] = prev[k]; } });
  process.env.RADSVINN_AGENT_MODEL_DECOMPOSE = 'sonnet';
  const args = buildClaudeArgs({ userMessage: 'm', sessionId: 's-3', resume: false });
  assert.equal(argValue(args, '--model'), 'opus', 'no kind → groom-seat resolution → the strong default');
});

test('OpenRouter runtime can force a stable CLI alias despite inherited Radsvinn model overrides', (t) => {
  const previous = process.env.RADSVINN_AGENT_MODEL_DECOMPOSE;
  t.after(() => {
    if (previous === undefined) delete process.env.RADSVINN_AGENT_MODEL_DECOMPOSE;
    else process.env.RADSVINN_AGENT_MODEL_DECOMPOSE = previous;
  });
  process.env.RADSVINN_AGENT_MODEL_DECOMPOSE = 'claude-expensive-override';
  const args = buildClaudeArgs({ userMessage: 'm', sessionId: 's', resume: false, kind: 'phase1', modelOverride: 'opus' });
  assert.equal(argValue(args, '--model'), 'opus', 'provider runtime owns the alias; inherited provider-unaware override cannot escape');
});
