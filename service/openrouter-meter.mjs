// openrouter-meter.mjs — provider-authoritative OpenRouter egress meter.
//
// Claude Code's `total_cost_usd` is intentionally NOT used when Radsvinn is
// routed through OpenRouter.  A fresh loopback proxy is created for each
// `claude -p` invocation.  The subprocess gets a single-use-for-that-session
// capability, never the OpenRouter credential; the proxy records every
// X-Generation-Id and reconciles each receipt through OpenRouter's generation
// endpoint after the subprocess exits.  Any uncertainty is a hard failure.

import { readEnv } from '../dashboard/lib/env.mjs';
import { sandboxedEnv } from '../dashboard/lib/child-env.mjs';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const OPENROUTER_MODEL = 'deepseek/deepseek-v4-flash';
export const OPENROUTER_MESSAGES_PATHS = new Set(['/v1/messages', '/api/v1/messages']);
const OPENROUTER_MESSAGES_URL = 'https://openrouter.ai/api/v1/messages';
const OPENROUTER_GENERATION_URL = 'https://openrouter.ai/api/v1/generation';
const MAX_PROXY_REQUEST_BYTES = 8 * 1024 * 1024;
const CLOSE_GRACE_MS = 2_000;
const DEFAULT_UPSTREAM_TIMEOUT_MS = 5 * 60 * 1000;

// Integers are deliberately used at this boundary.  A planning call can cost
// far below one cent, and rounding each call to cents before a breaker sees it
// would let an arbitrary number of low-price calls evade the cap.  1e9 is
// exactly representable and leaves a large safety margin below Number's
// integer limit for Radsvinn's deliberately-small daily limits.
export const NANODOLLARS_PER_USD = 1_000_000_000;

export class CostTelemetryError extends Error {
  constructor(message, { cause, costNanos = 0 } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'CostTelemetryError';
    this.code = 'COST_TELEMETRY_UNAVAILABLE';
    this.costNanos = Number.isSafeInteger(costNanos) && costNanos >= 0 ? costNanos : 0;
  }
}

export class MeteredPhaseError extends Error {
  constructor(message, { cause, costNanos = 0 } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'MeteredPhaseError';
    this.code = 'METERED_PHASE_FAILED';
    this.costNanos = costNanos;
  }
}

export function usdToNanodollars(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new CostTelemetryError('authoritative OpenRouter cost is missing, non-finite, or negative');
  }
  const nanos = Math.round(value * NANODOLLARS_PER_USD);
  if (!Number.isSafeInteger(nanos) || nanos < 0) {
    throw new CostTelemetryError('authoritative OpenRouter cost cannot be represented safely');
  }
  return nanos;
}

export function nanodollarsToUsd(nanos) {
  if (!Number.isSafeInteger(nanos) || nanos < 0) {
    throw new CostTelemetryError('invalid internal nanodollar value');
  }
  return nanos / NANODOLLARS_PER_USD;
}

export function resolveLlmRuntime(env = process.env) {
  const provider = readEnv('RADSVINN_LLM_PROVIDER', env) || 'anthropic';
  if (provider === 'anthropic') return { provider };
  if (provider !== 'openrouter') {
    throw new Error('RADSVINN_LLM_PROVIDER must be "anthropic" or "openrouter"');
  }
  const apiKey = readEnv('RADSVINN_OPENROUTER_API_KEY', env);
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw new Error('RADSVINN_OPENROUTER_API_KEY is required when RADSVINN_LLM_PROVIDER=openrouter');
  }
  return { provider, apiKey: apiKey.trim(), model: OPENROUTER_MODEL };
}

// The aliases are required because Claude Code selects a Claude seat name
// before constructing the Messages request.  Mapping all of them ensures a
// phase cannot silently resolve to an expensive Claude model.  The proxy then
// independently rejects any payload whose final model is not the exact slug.
export function openRouterChildEnv(parentEnv, { baseUrl, capability }) {
  const env = sandboxedEnv(parentEnv);
  for (const key of [
    'RADSVINN_OPENROUTER_API_KEY', 'OPENROUTER_API_KEY',
    'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  ]) delete env[key];
  env.ANTHROPIC_BASE_URL = baseUrl;
  env.ANTHROPIC_AUTH_TOKEN = capability;
  // Some versions prefer API_KEY if it exists, so leave a deliberately blank
  // value rather than inheriting a source credential.
  env.ANTHROPIC_API_KEY = '';
  env.ANTHROPIC_DEFAULT_MODEL = OPENROUTER_MODEL;
  env.ANTHROPIC_DEFAULT_OPUS_MODEL = OPENROUTER_MODEL;
  env.ANTHROPIC_DEFAULT_SONNET_MODEL = OPENROUTER_MODEL;
  env.ANTHROPIC_DEFAULT_HAIKU_MODEL = OPENROUTER_MODEL;
  env.CLAUDE_CODE_SUBAGENT_MODEL = OPENROUTER_MODEL;
  return env;
}

function headerValues(rawHeaders, name) {
  const found = [];
  for (let i = 0; i < rawHeaders.length; i += 2) {
    if (String(rawHeaders[i]).toLowerCase() === name) found.push(String(rawHeaders[i + 1]));
  }
  return found;
}

function oneHeader(rawHeaders, name) {
  const values = headerValues(rawHeaders, name);
  return values.length === 1 && values[0].trim() ? values[0].trim() : undefined;
}

function readRequest(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_PROXY_REQUEST_BYTES) {
        reject(new CostTelemetryError('OpenRouter proxy request exceeded the maximum allowed size'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('aborted', () => reject(new CostTelemetryError('OpenRouter proxy request was aborted')));
    req.on('error', reject);
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function writeProxyError(res, status, message) {
  if (!res.headersSent) res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function safeUpstreamHeaders(requestHeaders, sourceKey) {
  // Build this allowlist from scratch.  In particular, do not copy
  // Authorization, x-api-key, HTTP-Referer, X-Title, or any provider-routing
  // header supplied by the untrusted subprocess.
  const headers = {
    authorization: `Bearer ${sourceKey}`,
    'content-type': 'application/json',
  };
  const accept = requestHeaders.accept;
  if (typeof accept === 'string' && accept.includes('text/event-stream')) headers.accept = 'text/event-stream';
  else headers.accept = 'application/json';
  for (const name of ['anthropic-version', 'anthropic-beta']) {
    const value = requestHeaders[name];
    if (typeof value === 'string' && value.length > 0 && value.length < 4096) headers[name] = value;
  }
  return headers;
}

function sanitizePayload(payload) {
  // A caller-controlled OpenRouter routing directive is a cost/correctness
  // bypass even if `model` itself is exact.  Preserve standard Anthropic
  // fields but delete all routing knobs and set the sole permitted provider
  // option explicitly.  This means the proxy, rather than Claude Code, owns
  // fallback policy.
  const sanitized = { ...payload, model: OPENROUTER_MODEL };
  for (const key of ['models', 'fallbacks', 'route', 'provider', 'plugins', 'service_tier', 'transforms']) delete sanitized[key];
  sanitized.provider = { allow_fallbacks: false };
  return sanitized;
}

function defaultUpstreamRequest({ body, headers }) {
  return new Promise((resolve, reject) => {
    const target = new URL(OPENROUTER_MESSAGES_URL);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: { ...headers, 'content-length': String(body.length) },
    }, (response) => {
      resolve({
        statusCode: response.statusCode || 502,
        headers: response.headers,
        rawHeaders: response.rawHeaders,
        stream: response,
      });
    });
    request.setTimeout(openRouterRequestTimeoutMs(), () => request.destroy(new Error('OpenRouter upstream request timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

function defaultGenerationLookup({ generationId, sourceKey }) {
  return new Promise((resolve, reject) => {
    const target = new URL(OPENROUTER_GENERATION_URL);
    target.searchParams.set('id', generationId);
    const request = https.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || 443,
      path: `${target.pathname}${target.search}`,
      method: 'GET',
      headers: { authorization: `Bearer ${sourceKey}`, accept: 'application/json' },
    }, (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { text += chunk; });
      response.on('error', reject);
      response.on('end', () => {
        let body;
        try { body = text.length > 0 ? JSON.parse(text) : undefined; } catch (err) { reject(err); return; }
        resolve({ status: response.statusCode || 502, body });
      });
    });
    request.setTimeout(openRouterRequestTimeoutMs(), () => request.destroy(new Error('OpenRouter generation lookup timed out')));
    request.on('error', reject);
    request.end();
  });
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openRouterRequestTimeoutMs() {
  const raw = Number(readEnv('RADSVINN_OPENROUTER_REQUEST_TIMEOUT_MS'));
  // Long-running tool loops and cold provider queues are normal enough that a
  // 30-second idle socket cap is a reliability bug.  Keep an operator-tunable
  // finite bound well below the engine's 45-minute outer phase timeout.
  if (Number.isInteger(raw) && raw >= 30_000 && raw <= 44 * 60 * 1000) return raw;
  return DEFAULT_UPSTREAM_TIMEOUT_MS;
}

function normalizeReceipt(response) {
  return response && response.body && response.body.data ? response.body.data : response && response.body;
}

async function lookupReceiptWithRetry({ generationId, sourceKey, lookup, sleep, attempts }) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await lookup({ generationId, sourceKey });
      const receipt = response && response.status >= 200 && response.status < 300
        ? normalizeReceipt(response)
        : undefined;
      // The generation endpoint may briefly return a 2xx shell before usage
      // accounting is populated.  That is eventual consistency, not a valid
      // receipt: keep retrying until every authoritative field is present.
      if (
        receipt
        && receipt.id === generationId
        && receipt.model === OPENROUTER_MODEL
        && typeof receipt.total_cost === 'number'
        && Number.isFinite(receipt.total_cost)
        && receipt.total_cost >= 0
      ) return receipt;
      last = new Error('generation receipt is not complete yet');
    } catch (err) {
      last = err;
    }
    if (i + 1 < attempts) await sleep(250 * (2 ** i));
  }
  throw new CostTelemetryError(`OpenRouter receipt ${generationId} was unavailable after ${attempts} attempts`, { cause: last });
}

function forwardResponse(upstream, res, markAnomaly) {
  return new Promise((resolve) => {
    let complete = false;
    let clientClosed = false;
    let settled = false;
    const settle = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    const headers = {};
    for (const [name, value] of Object.entries(upstream.headers || {})) {
      // Hop-by-hop headers are not safe to relay through a new local hop.
      if (!['connection', 'keep-alive', 'transfer-encoding', 'upgrade'].includes(name.toLowerCase()) && value !== undefined) {
        headers[name] = value;
      }
    }
    res.writeHead(upstream.statusCode, headers);
    res.on('close', () => {
      clientClosed = true;
      if (!complete) markAnomaly('OpenRouter proxy response was aborted by the child');
      if (!complete) settle();
    });
    upstream.stream.on('error', (err) => {
      // Upstream errors can echo request metadata.  This string ultimately
      // reaches a plan's human-visible failure, so never interpolate it.
      markAnomaly('OpenRouter upstream response errored');
      if (!res.writableEnded) res.destroy(err);
      settle();
    });
    upstream.stream.on('aborted', () => {
      markAnomaly('OpenRouter upstream response was aborted');
      if (!res.writableEnded) res.destroy();
      settle();
    });
    upstream.stream.on('end', () => {
      complete = true;
      if (!res.writableEnded && !clientClosed) res.end();
      settle();
    });
    upstream.stream.pipe(res, { end: false });
  });
}

/**
 * Starts a one-phase loopback proxy.  `upstreamRequest`, `generationLookup`,
 * and `sleep` are explicit test seams; production supplies none and therefore
 * uses only OpenRouter's Messages and Generation endpoints.
 */
export async function startOpenRouterMeterProxy({
  sourceKey,
  upstreamRequest = defaultUpstreamRequest,
  generationLookup = defaultGenerationLookup,
  sleep = defaultSleep,
  receiptAttempts = 7,
} = {}) {
  if (typeof sourceKey !== 'string' || sourceKey.length === 0) {
    throw new CostTelemetryError('OpenRouter meter started without a source credential');
  }
  if (!Number.isInteger(receiptAttempts) || receiptAttempts < 1 || receiptAttempts > 8) {
    throw new Error('receiptAttempts must be an integer from 1 through 8');
  }

  const capability = crypto.randomBytes(32).toString('base64url');
  const requests = [];
  const receiptIds = new Set();
  const sockets = new Set();
  let anomaly;
  let finalized = false;
  let active = 0;
  const markAnomaly = (message) => { anomaly ||= message; };

  const server = http.createServer(async (req, res) => {
    active += 1;
    try {
      const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
      const authValues = headerValues(req.rawHeaders, 'authorization');
      if (req.method !== 'POST' || !OPENROUTER_MESSAGES_PATHS.has(requestUrl.pathname) || requestUrl.search) {
        markAnomaly('OpenRouter proxy received an unauthorized method or path');
        writeProxyError(res, 404, 'not found');
        return;
      }
      if (finalized || authValues.length !== 1 || authValues[0] !== `Bearer ${capability}`) {
        markAnomaly('OpenRouter proxy received an unknown or reused capability');
        writeProxyError(res, 401, 'unauthorized');
        return;
      }
      const body = await readRequest(req);
      let payload;
      try { payload = JSON.parse(body.toString('utf8')); } catch { payload = undefined; }
      if (!payload || payload.model !== OPENROUTER_MODEL) {
        markAnomaly('OpenRouter proxy received a request with a non-allowlisted model');
        writeProxyError(res, 400, 'model is not allowed');
        return;
      }
      const record = { generationId: undefined };
      requests.push(record);
      let upstream;
      try {
        upstream = await upstreamRequest({
          body: Buffer.from(JSON.stringify(sanitizePayload(payload))),
          headers: safeUpstreamHeaders(req.headers, sourceKey),
          sourceKey,
          model: OPENROUTER_MODEL,
        });
      } catch (err) {
        markAnomaly('OpenRouter upstream request failed');
        writeProxyError(res, 502, 'upstream unavailable');
        return;
      }
      const generationId = oneHeader(upstream.rawHeaders || [], 'x-generation-id');
      if (upstream.statusCode < 200 || upstream.statusCode >= 300) {
        markAnomaly('OpenRouter upstream returned a non-success response');
      }
      if (!generationId || receiptIds.has(generationId)) {
        markAnomaly('OpenRouter upstream response has a missing or duplicate X-Generation-Id receipt');
      } else {
        receiptIds.add(generationId);
        record.generationId = generationId;
      }
      await forwardResponse(upstream, res, markAnomaly);
    } catch (err) {
      markAnomaly('OpenRouter proxy request failed');
      if (!res.writableEnded) writeProxyError(res, 502, 'proxy failure');
    } finally {
      active -= 1;
    }
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function closeServer() {
    // A malicious/broken child can leave a keepalive or response stream open.
    // Do not let that turn a failed accounting operation into an unbounded
    // worker hang: close gracefully for a small bound, then destroy every
    // socket and mark the phase's telemetry unknown.
    let completed = false;
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (completed) return;
        markAnomaly('OpenRouter proxy shutdown timed out');
        for (const socket of sockets) socket.destroy();
        if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
        resolve();
      }, CLOSE_GRACE_MS);
      server.close(() => {
        completed = true;
        clearTimeout(timer);
        resolve();
      });
    });
  }

  return {
    baseUrl,
    capability,
    async finalize() {
      if (finalized) throw new CostTelemetryError('OpenRouter proxy capability was finalized more than once');
      finalized = true;
      // `server.close` stops new connects.  Existing active requests should
      // have ended before claude exits; any survivor is accounting-unknown.
      await closeServer();
      if (active !== 0) markAnomaly('OpenRouter proxy had an active request at phase finalization');
      let totalNanos = 0;
      let receiptFailure;
      for (const request of requests) {
        if (!request.generationId) {
          receiptFailure ||= 'OpenRouter proxy cannot reconcile a request without a receipt';
          continue;
        }
        try {
          const receipt = await lookupReceiptWithRetry({
            generationId: request.generationId,
            sourceKey,
            lookup: generationLookup,
            sleep,
            attempts: receiptAttempts,
          });
          if (!receipt || receipt.id !== request.generationId || receipt.model !== OPENROUTER_MODEL) {
            throw new CostTelemetryError('OpenRouter receipt did not match its request');
          }
          totalNanos += usdToNanodollars(receipt.total_cost);
          if (!Number.isSafeInteger(totalNanos)) throw new CostTelemetryError('OpenRouter aggregate cost cannot be represented safely');
        } catch (err) {
          // Reconcile the other known receipts too; their real spend must be
          // retained even though the phase is terminally accounting-unknown.
          receiptFailure ||= 'OpenRouter receipt reconciliation failed';
        }
      }
      if (anomaly || receiptFailure) {
        throw new CostTelemetryError(anomaly || receiptFailure, { costNanos: totalNanos });
      }
      return { costNanos: totalNanos, costUsd: nanodollarsToUsd(totalNanos), requestCount: requests.length };
    },
  };
}
