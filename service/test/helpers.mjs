// helpers.mjs — shared test scaffolding. NOT a test file itself (no
// `.test.mjs` suffix), so `node --test service/test/` will import it as a
// plain module without trying to run it as a suite.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server.mjs';

/**
 * Boots a fresh server against a fresh tmp results directory, always on the
 * fake engine unless overridden. Returns a `close()` that tears the server
 * down, restores any env vars this touched, and removes the tmp directory.
 */
export async function startTestServer(envOverrides = {}) {
  const resultsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mercury-service-test-'));
  const envToSet = { MERCURY_RESULTS_DIR: resultsDir, MERCURY_ENGINE: 'fake', ...envOverrides };
  const prevEnv = {};
  for (const [k, v] of Object.entries(envToSet)) {
    prevEnv[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }

  const app = createServer();
  const addr = await app.listen(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  return {
    baseUrl,
    resultsDir,
    app,
    async close() {
      await app.close();
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      fs.rmSync(resultsDir, { recursive: true, force: true });
    },
  };
}

async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function postJson(baseUrl, urlPath, body, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await parseJsonResponse(res), headers: res.headers };
}

export async function getJson(baseUrl, urlPath, extraHeaders = {}) {
  const res = await fetch(`${baseUrl}${urlPath}`, { headers: extraHeaders });
  return { status: res.status, body: await parseJsonResponse(res), headers: res.headers };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `fn()` until `predicate(value)` is true, or throws after `timeoutMs`.
 * Default timeout is generous (20s) because the real skeleton gate shells
 * out to `go run ./cmd/treecheck`, which compiles on a cold cache.
 */
export async function pollUntil(fn, predicate, { intervalMs = 25, timeoutMs = 20000 } = {}) {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (predicate(value)) return value;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`pollUntil timed out after ${timeoutMs}ms; last value: ${JSON.stringify(value)}`);
    }
    await sleep(intervalMs);
  }
}
