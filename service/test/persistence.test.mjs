import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { State } from '../state.mjs';
import { createServer } from '../server.mjs';
import { getJson } from './helpers.mjs';

test('crash-resume: a plan stuck in a transient status reloads as failed / interrupted by restart', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-service-persist-'));
  const prevResultsDir = process.env.MERCURY_RESULTS_DIR;
  const prevEngine = process.env.MERCURY_ENGINE;
  process.env.MERCURY_RESULTS_DIR = resultsDir;
  process.env.MERCURY_ENGINE = 'fake';

  t.after(() => {
    if (prevResultsDir === undefined) delete process.env.MERCURY_RESULTS_DIR;
    else process.env.MERCURY_RESULTS_DIR = prevResultsDir;
    if (prevEngine === undefined) delete process.env.MERCURY_ENGINE;
    else process.env.MERCURY_ENGINE = prevEngine;
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  // Simulate a plan that was mid-flight when the process died: write its
  // state file directly (bypassing HTTP/workers entirely), exactly as
  // state.mjs would have left it on disk mid-groom.
  const plansDir = path.join(resultsDir, 'service', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const stuckPlanId = '11111111-1111-4111-8111-111111111111';
  const stuckPlan = {
    plan_id: stuckPlanId,
    status: 'grooming',
    requester: 'test-requester',
    description: 'stuck mid-groom when the process died',
    role_lens: 'business',
    mode: 'front_door',
    cost_usd: 0.8,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(plansDir, `${stuckPlanId}.json`), JSON.stringify(stuckPlan, null, 2));

  // A brand new State instance reading the same directory (as if the
  // process had restarted) must recover this rather than resume it silently.
  const freshState = new State();
  freshState.load();
  const reloaded = freshState.get(stuckPlanId);
  assert.equal(reloaded.status, 'failed');
  assert.equal(reloaded.error, 'interrupted by restart');
  assert.equal(reloaded.cost_usd, 0.8, 'prior accumulated cost is preserved, not reset');

  const onDisk = JSON.parse(fs.readFileSync(path.join(plansDir, `${stuckPlanId}.json`), 'utf8'));
  assert.equal(onDisk.status, 'failed', 'the correction must also be persisted back to disk, not just in memory');
  assert.equal(onDisk.error, 'interrupted by restart');

  // And end-to-end through the real HTTP server booted against this dir.
  const app = createServer();
  const addr = await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const view = await getJson(baseUrl, `/plan/${stuckPlanId}`);
  assert.equal(view.status, 200);
  assert.equal(view.body.status, 'failed');
  assert.equal(view.body.error, 'interrupted by restart');
});

test('crash-resume: a healthy terminal-status plan reloads unchanged', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-service-persist-'));
  const prevResultsDir = process.env.MERCURY_RESULTS_DIR;
  process.env.MERCURY_RESULTS_DIR = resultsDir;
  t.after(() => {
    if (prevResultsDir === undefined) delete process.env.MERCURY_RESULTS_DIR;
    else process.env.MERCURY_RESULTS_DIR = prevResultsDir;
    fs.rmSync(resultsDir, { recursive: true, force: true });
  });

  const plansDir = path.join(resultsDir, 'service', 'plans');
  fs.mkdirSync(plansDir, { recursive: true });
  const donePlanId = '22222222-2222-4222-8222-222222222222';
  const donePlan = {
    plan_id: donePlanId,
    status: 'created',
    requester: 'test-requester',
    cost_usd: 2.0,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(plansDir, `${donePlanId}.json`), JSON.stringify(donePlan, null, 2));

  const freshState = new State();
  freshState.load();
  const reloaded = freshState.get(donePlanId);
  assert.equal(reloaded.status, 'created', 'a genuinely terminal status must not be touched by crash-resume');
  assert.equal(reloaded.cost_usd, 2.0);
});
