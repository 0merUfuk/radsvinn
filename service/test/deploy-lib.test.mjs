// deploy-lib.test.mjs — the shared credential-hygiene seam (deploy/lib.mjs)
// consumed by BOTH deploy/entrypoint.mjs (boot-time grounding sync) and
// service/grounding.mjs (fetch-before-plan's per-plan fetch). Pure unit tests — no git,
// no network, no fs.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scrub,
  gitAuthEnv,
  DEFAULT_GROUNDING_REPOS,
  groundingRepos,
  resolveGroundingRepos,
  INVALID_GROUNDING_REPOS_MESSAGE,
} from '../../deploy/lib.mjs';

test('groundingRepos: four physical defaults are required; extensions are additive and the plan-only routing marker is never cloned', () => {
  assert.deepEqual(DEFAULT_GROUNDING_REPOS, [
    'web-app', 'api-service', 'worker-service', 'shared-lib',
  ]);
  assert.deepEqual(groundingRepos(), DEFAULT_GROUNDING_REPOS, 'no override uses the tested production default');
  assert.deepEqual(
    groundingRepos('web-app,api-service,worker-service,shared-lib,cross-repo-lockstep'),
    DEFAULT_GROUNDING_REPOS,
    'a legacy explicit list keeps every physical default but filters the plan-only routing marker',
  );
  assert.deepEqual(
    groundingRepos(' api-service, custom-grounding, cross-repo-lockstep, web-app, custom-grounding '),
    [...DEFAULT_GROUNDING_REPOS, 'custom-grounding'],
    'operator additions follow stable default-first order while duplicates and the routing marker are not cloned',
  );
  assert.deepEqual(
    resolveGroundingRepos('cross-repo-lockstep'),
    { repos: [...DEFAULT_GROUNDING_REPOS] },
    'an explicit legacy routing marker never reaches the entrypoint-facing clone list',
  );
});

test('groundingRepos: malformed extensions fail before filesystem path handling; the entrypoint-facing result is generic and safe to log', () => {
  for (const raw of [
    '.',
    '..',
    '../escape',
    '/absolute/path',
    'nested/repo',
    'nested\\repo',
    'api-service,,custom-grounding',
    '',
  ]) {
    assert.throws(
      () => groundingRepos(raw),
      new Error(INVALID_GROUNDING_REPOS_MESSAGE),
      `${JSON.stringify(raw)} must not become a grounding filesystem path`,
    );
  }

  assert.deepEqual(
    groundingRepos('service.v2,custom_repo'),
    [...DEFAULT_GROUNDING_REPOS, 'service.v2', 'custom_repo'],
    'normal GitHub repository slugs remain valid extensions',
  );

  const hostile = '../not-a-secret-but-never-log-me';
  const resolved = resolveGroundingRepos(hostile);
  assert.deepEqual(resolved, { error: INVALID_GROUNDING_REPOS_MESSAGE });
  assert.doesNotMatch(resolved.error, /not-a-secret-but-never-log-me/);
});

test('scrub: masks x-access-token URL credentials AND the literal token; safe on empty/undefined input', () => {
  const line = "fatal: unable to access 'https://x-access-token:ghp_sekret99@github.com/example-org/web-app/': 403 — token ghp_sekret99 expired";

  const out = scrub(line, 'ghp_sekret99');
  assert.doesNotMatch(out, /ghp_sekret99/, 'the literal token is gone everywhere');
  assert.match(out, /x-access-token:\*\*\*@github\.com/, 'the credential-in-URL fragment is masked');
  assert.match(out, /token \*\*\* expired/, 'the prose occurrence is masked too');

  // No token configured: the URL-embedded credential is still masked (the
  // regex leg does not depend on knowing the token).
  const out2 = scrub(line, undefined);
  assert.match(out2, /x-access-token:\*\*\*@github\.com/);

  assert.equal(scrub(undefined, 'x'), '', 'undefined input never throws');
  assert.equal(scrub('', undefined), '', 'empty input never throws');
  assert.equal(scrub('clean text', 'tok'), 'clean text', 'text without token material passes through');
});

test('gitAuthEnv: no token → {} (spread is a no-op); with a token → exactly the three GIT_CONFIG_* vars rewriting https://github.com/', () => {
  assert.deepEqual(gitAuthEnv(undefined), {});
  assert.deepEqual(gitAuthEnv(''), {});

  const env = gitAuthEnv('tok-123');
  assert.deepEqual(env, {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://x-access-token:tok-123@github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'https://github.com/',
  }, 'the exact -c url.<auth>.insteadOf=<clean> shape, expressed as environment config');
});
