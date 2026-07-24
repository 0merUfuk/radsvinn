import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import {
  CostTelemetryError,
  MeteredPhaseError,
  OPENROUTER_MODEL,
  openRouterChildEnv,
  startOpenRouterMeterProxy,
} from '../openrouter-meter.mjs';
import { createServer } from '../server.mjs';
import { getDailySpendNanos } from '../breakers.mjs';
import { getJson, pollUntil, postJson } from './helpers.mjs';

function upstreamResponse({ generationId = 'gen-1', statusCode = 200, failStream = false } = {}) {
  const stream = new PassThrough();
  queueMicrotask(() => {
    if (failStream) stream.destroy(new Error('simulated upstream failure'));
    else stream.end('{"type":"message_stop"}');
  });
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    rawHeaders: generationId ? ['X-Generation-Id', generationId] : [],
    stream,
  };
}

function postProxy(proxy, { capability = proxy.capability, payload = { model: OPENROUTER_MODEL }, path = '/v1/messages' } = {}) {
  return new Promise((resolve) => {
    const body = JSON.stringify(payload);
    const req = http.request(`${proxy.baseUrl}${path}`, {
      method: 'POST',
      agent: false,
      headers: {
        authorization: `Bearer ${capability}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        connection: 'close',
        'http-referer': 'https://attacker.invalid',
        'x-title': 'attacker-route',
      },
    }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode }));
      res.on('error', () => resolve({ status: res.statusCode, errored: true }));
    });
    req.on('error', () => resolve({ status: 0, errored: true }));
    req.end(body);
  });
}

function receipt(id, totalCost = 0.000000001) {
  return { status: 200, body: { data: { id, model: OPENROUTER_MODEL, total_cost: totalCost } } };
}

test('OpenRouter child environment contains only loopback capability and pins every model alias', () => {
  const sourceKey = 'or-source-never-child-visible';
  const env = openRouterChildEnv({
    MERCURY_OPENROUTER_API_KEY: sourceKey,
    OPENROUTER_API_KEY: sourceKey,
    ANTHROPIC_API_KEY: 'anthropic-source-never-child-visible',
    ANTHROPIC_AUTH_TOKEN: 'anthropic-auth-never-child-visible',
    PATH: '/usr/bin',
  }, { baseUrl: 'http://127.0.0.1:12345', capability: 'phase-only-capability' });

  assert.equal(env.MERCURY_OPENROUTER_API_KEY, undefined);
  assert.equal(env.OPENROUTER_API_KEY, undefined);
  assert.equal(env.ANTHROPIC_API_KEY, '');
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'phase-only-capability');
  assert.equal(env.ANTHROPIC_BASE_URL, 'http://127.0.0.1:12345');
  for (const name of [
    'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
  ]) assert.equal(env[name], OPENROUTER_MODEL, `${name} is exact`);
  assert.doesNotMatch(JSON.stringify(env), /source-never-child-visible/);
});

test('proxy strips caller routing/auth headers, forces no fallback, and reconciles a nanodollar receipt', async () => {
  const sourceKey = 'or-source-never-in-error';
  let forwarded;
  const proxy = await startOpenRouterMeterProxy({
    sourceKey,
    upstreamRequest: async (request) => {
      forwarded = request;
      return upstreamResponse({ generationId: 'gen-sanitized' });
    },
    generationLookup: async ({ generationId }) => receipt(generationId),
    sleep: async () => {},
  });

  const sent = await postProxy(proxy, {
    payload: {
      model: OPENROUTER_MODEL,
      models: ['evil/expensive'],
      fallbacks: ['evil/fallback'],
      route: 'fallback',
      provider: { allow_fallbacks: true, sort: 'price' },
      plugins: [{ id: 'evil' }],
      service_tier: 'priority',
      messages: [],
    },
  });
  assert.equal(sent.status, 200);
  const result = await proxy.finalize();
  assert.equal(result.costNanos, 1, 'one nanodollar survives aggregation');
  assert.equal(result.costUsd, 0.000000001);
  assert.equal(forwarded.headers.authorization, `Bearer ${sourceKey}`);
  assert.equal(forwarded.headers['http-referer'], undefined);
  assert.equal(forwarded.headers['x-title'], undefined);
  const forwardedPayload = JSON.parse(forwarded.body.toString('utf8'));
  assert.deepEqual(forwardedPayload.provider, { allow_fallbacks: false });
  for (const key of ['models', 'fallbacks', 'route', 'plugins', 'service_tier']) assert.equal(forwardedPayload[key], undefined, `${key} is stripped`);
});

test('proxy retries an incomplete/404 generation receipt until provider accounting is complete', async () => {
  let lookups = 0;
  const proxy = await startOpenRouterMeterProxy({
    sourceKey: 'or-test-key',
    upstreamRequest: async () => upstreamResponse({ generationId: 'gen-eventual' }),
    generationLookup: async ({ generationId }) => {
      lookups += 1;
      if (lookups === 1) return { status: 404, body: {} };
      if (lookups === 2) return { status: 200, body: { data: { id: generationId, model: OPENROUTER_MODEL } } };
      return receipt(generationId, 0.000000002);
    },
    sleep: async () => {},
  });
  assert.equal((await postProxy(proxy)).status, 200);
  const result = await proxy.finalize();
  assert.equal(lookups, 3);
  assert.equal(result.costNanos, 2);
});

test('missing, duplicate, non-success, and mismatched receipts fail closed without leaking source credential', async (t) => {
  const cases = [
    {
      name: 'missing generation header',
      upstreamRequest: async () => upstreamResponse({ generationId: undefined }),
      requests: 1,
      lookup: async () => receipt('unused'),
    },
    {
      name: 'duplicate generation header',
      upstreamRequest: async () => upstreamResponse({ generationId: 'same' }),
      requests: 2,
      lookup: async ({ generationId }) => receipt(generationId),
    },
    {
      name: 'non-success Messages response',
      upstreamRequest: async () => upstreamResponse({ generationId: 'non-success', statusCode: 429 }),
      requests: 1,
      lookup: async ({ generationId }) => receipt(generationId),
    },
    {
      name: 'mismatched receipt after bounded retry',
      upstreamRequest: async () => upstreamResponse({ generationId: 'expected' }),
      requests: 1,
      lookup: async () => receipt('different'),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const proxy = await startOpenRouterMeterProxy({
        sourceKey: 'or-source-never-in-error',
        upstreamRequest: scenario.upstreamRequest,
        generationLookup: scenario.lookup,
        sleep: async () => {},
        receiptAttempts: 2,
      });
      for (let i = 0; i < scenario.requests; i += 1) await postProxy(proxy);
      await assert.rejects(
        () => proxy.finalize(),
        (err) => err instanceof CostTelemetryError && !String(err.message).includes('or-source-never-in-error'),
      );
    });
  }
});

test('known receipt is retained when child-side stream abort makes telemetry uncertain', async () => {
  const proxy = await startOpenRouterMeterProxy({
    sourceKey: 'or-test-key',
    upstreamRequest: async () => upstreamResponse({ generationId: 'charged-before-abort', failStream: true }),
    generationLookup: async ({ generationId }) => receipt(generationId, 0.000000003),
    sleep: async () => {},
  });
  await postProxy(proxy);
  await assert.rejects(
    () => proxy.finalize(),
    (err) => err instanceof CostTelemetryError && err.costNanos === 3,
  );
});

test('unknown capability, model, and path are rejected and make the session accounting-unknown', async (t) => {
  const cases = [
    { name: 'capability', request: { capability: 'stale-capability' } },
    { name: 'model', request: { payload: { model: 'anthropic/expensive' } } },
    { name: 'path', request: { path: '/v1/complete' } },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const proxy = await startOpenRouterMeterProxy({
        sourceKey: 'or-test-key',
        upstreamRequest: async () => upstreamResponse(),
        generationLookup: async ({ generationId }) => receipt(generationId),
      });
      const response = await postProxy(proxy, scenario.request);
      assert.ok(response.status >= 400);
      await assert.rejects(() => proxy.finalize(), CostTelemetryError);
    });
  }
});

test('two billable requests aggregate exactly before a phase result can be consumed', async () => {
  let sequence = 0;
  const proxy = await startOpenRouterMeterProxy({
    sourceKey: 'or-test-key',
    upstreamRequest: async () => upstreamResponse({ generationId: `multi-${++sequence}` }),
    generationLookup: async ({ generationId }) => receipt(generationId, generationId === 'multi-1' ? 0.000000001 : 0.000000002),
    sleep: async () => {},
  });
  await postProxy(proxy);
  await postProxy(proxy, { path: '/api/v1/messages' });
  const result = await proxy.finalize();
  assert.equal(result.requestCount, 2);
  assert.equal(result.costNanos, 3);
});

test('negative, non-finite, and string receipt totals fail closed', async (t) => {
  for (const totalCost of [-1, Number.POSITIVE_INFINITY, '0.1']) {
    await t.test(String(totalCost), async () => {
      const proxy = await startOpenRouterMeterProxy({
        sourceKey: 'or-test-key',
        upstreamRequest: async () => upstreamResponse({ generationId: `bad-${String(totalCost)}` }),
        generationLookup: async ({ generationId }) => ({ status: 200, body: { data: { id: generationId, model: OPENROUTER_MODEL, total_cost: totalCost } } }),
        sleep: async () => {},
        receiptAttempts: 1,
      });
      await postProxy(proxy);
      await assert.rejects(() => proxy.finalize(), CostTelemetryError);
    });
  }
});

test('a capability from a finalized proxy cannot authorize a fresh proxy', async () => {
  const first = await startOpenRouterMeterProxy({
    sourceKey: 'or-test-key', upstreamRequest: async () => upstreamResponse(), generationLookup: async ({ generationId }) => receipt(generationId),
  });
  const oldCapability = first.capability;
  await first.finalize();
  const fresh = await startOpenRouterMeterProxy({
    sourceKey: 'or-test-key', upstreamRequest: async () => upstreamResponse(), generationLookup: async ({ generationId }) => receipt(generationId),
  });
  assert.ok((await postProxy(fresh, { capability: oldCapability })).status >= 400);
  await assert.rejects(() => fresh.finalize(), CostTelemetryError);
});

test('server records known failed-phase spend but only unknown telemetry locks later LLM work', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-meter-server-'));
  let calls = 0;
  const knownEngine = {
    async phase1() {
      calls += 1;
      throw new MeteredPhaseError('internal only', { costNanos: 1 });
    },
  };
  const app = createServer({ engine: knownEngine, resultsDir });
  const address = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(resultsDir, { recursive: true, force: true }); });

  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const failed = await pollUntil(() => getJson(baseUrl, `/plan/${created.body.plan_id}`), (r) => r.body.status === 'failed');
  assert.equal(failed.body.cost_usd, 0, 'legacy presentation may round sub-cent cost');
  assert.equal(getDailySpendNanos(resultsDir), 1, 'known provider charge is durable');
  assert.match(failed.body.error, /phase failed/i);
  assert.doesNotMatch(failed.body.error, /no further LLM/i, 'known spend does not claim an accounting lock');
  assert.equal((await getJson(baseUrl, '/healthz')).body.cost_telemetry_locked, false);
  assert.equal(calls, 1);
});

test('server persists charge before a gate exception, and retry sees the fixed-point plan cap', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-meter-gate-'));
  const previous = process.env.MERCURY_PLAN_BUDGET_USD;
  process.env.MERCURY_PLAN_BUDGET_USD = '0.000000001';
  let calls = 0;
  const engine = {
    async phase1() { calls += 1; return { sessionId: 's', costUsd: 0.000000001, resultText: 'x', model: 'fake' }; },
  };
  const app = createServer({ engine, resultsDir, gateSkeleton: async () => { throw new Error('test gate interruption'); } });
  const address = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await app.close(); fs.rmSync(resultsDir, { recursive: true, force: true });
    if (previous === undefined) delete process.env.MERCURY_PLAN_BUDGET_USD;
    else process.env.MERCURY_PLAN_BUDGET_USD = previous;
  });
  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const failed = await pollUntil(() => getJson(baseUrl, `/plan/${created.body.plan_id}`), (r) => r.body.status === 'failed');
  assert.equal(getDailySpendNanos(resultsDir), 1);
  assert.equal(calls, 1);
  const retried = await postJson(baseUrl, `/plan/${created.body.plan_id}/retry`, {});
  assert.equal(retried.status, 202);
  const blocked = await pollUntil(() => getJson(baseUrl, `/plan/${created.body.plan_id}`), (r) => r.body.status === 'budget_blocked');
  assert.equal(blocked.body.status, 'budget_blocked');
  assert.equal(calls, 1, 'retry is stopped by one nanodollar before a second phase call');
  assert.equal(failed.body.cost_usd, 0);
});

test('unknown receipt locks the root after preserving known spend; corrupted daily ledger is visibly locked', async (t) => {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-meter-lock-'));
  const app = createServer({
    resultsDir,
    engine: { async phase1() { throw new CostTelemetryError('internal only', { costNanos: 2 }); } },
  });
  const address = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => { await app.close(); fs.rmSync(resultsDir, { recursive: true, force: true }); });
  const created = await postJson(baseUrl, '/plan', { description: 'x'.repeat(50), requester: 'test-requester' });
  const failed = await pollUntil(() => getJson(baseUrl, `/plan/${created.body.plan_id}`), (r) => r.body.status === 'failed');
  assert.equal(getDailySpendNanos(resultsDir), 2, 'known receipt component is retained first');
  assert.match(failed.body.error, /no further LLM/i);
  const health = await getJson(baseUrl, '/healthz');
  assert.equal(health.body.cost_telemetry_locked, true);
  assert.equal(health.body.daily_spend_usd, null);

  const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-meter-corrupt-'));
  t.after(() => fs.rmSync(corruptDir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(corruptDir, 'service'), { recursive: true });
  fs.writeFileSync(path.join(corruptDir, 'service', `daily-spend-${new Date().toISOString().slice(0, 10)}.json`), '{broken');
  const corruptApp = createServer({ resultsDir: corruptDir, engine: { async phase1() {} } });
  const corruptAddr = await corruptApp.listen(0, '127.0.0.1');
  t.after(() => corruptApp.close());
  const corruptHealth = await getJson(`http://127.0.0.1:${corruptAddr.port}`, '/healthz');
  assert.equal(corruptHealth.body.cost_telemetry_locked, true);
  assert.equal(corruptHealth.body.daily_spend_usd, null);
});
