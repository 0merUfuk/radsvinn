// breakers.mjs — per-plan cost cap + daily circuit breaker.
//
// Per-plan: before groom AND phase1 bounded-regen calls (B2), if the
// plan's accumulated cost_usd already meets/exceeds RADSVINN_PLAN_BUDGET_USD
// (default $10), the plan is refused (caller sets status to budget_blocked).
// A fresh plan's FIRST phase1 call is exempt (cost_usd 0); the cap bites only
// once real spend has accumulated, so it also bounds the regen loop's spend.
//
// Daily: a rolling UTC-day total, persisted at
// `${resultsDir}/service/daily-spend-<YYYY-MM-DD>.json`, checked before ANY
// engine call (phase1 included). >= hard (default $100) refuses; >= soft
// (default $50) logs one warning per process boot and continues.

import { readEnv } from '../dashboard/lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { nanodollarsToUsd, usdToNanodollars } from './openrouter-meter.mjs';

const DEFAULT_PLAN_BUDGET_USD = 10;
const DEFAULT_DAILY_SOFT_USD = 50;
const DEFAULT_DAILY_HARD_USD = 100;

let warnedSoftThisBoot = false;
// A durable lock is the cross-restart signal.  This in-memory set is equally
// important: if a filesystem write fails, an already-running process must
// still block later LLM work against that same results root immediately.
const telemetryLocks = new Map();

function envFloat(env, name, fallback) {
  const raw = readEnv(name, env);
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD, always UTC
}

function dailyFilePath(resultsDirPath) {
  return path.join(resultsDirPath, 'service', `daily-spend-${todayUtc()}.json`);
}

function telemetryLockFilePath(resultsDirPath) {
  // This is deliberately NOT daily.  An unknown receipt is a safety event,
  // not a daily-budget event; rolling UTC midnight must never silently clear
  // it and allow additional provider calls with an undercounted history.
  return path.join(resultsDirPath, 'service', 'cost-telemetry.lock.json');
}

function freshDaily() {
  return { date: todayUtc(), total_nanos: 0, total_usd: 0 };
}

function readDaily(resultsDirPath) {
  const file = dailyFilePath(resultsDirPath);
  if (!fs.existsSync(file)) return freshDaily();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && Number.isSafeInteger(parsed.total_nanos) && parsed.total_nanos >= 0) {
      return { date: parsed.date || todayUtc(), total_nanos: parsed.total_nanos, total_usd: nanodollarsToUsd(parsed.total_nanos) };
    }
    // Compatibility migration: legacy ledgers held only a USD number.  The
    // first post-upgrade write adds total_nanos; we never discard old spend.
    if (parsed && typeof parsed.total_usd === 'number' && Number.isFinite(parsed.total_usd) && parsed.total_usd >= 0) {
      const totalNanos = usdToNanodollars(parsed.total_usd);
      return { date: parsed.date || todayUtc(), total_nanos: totalNanos, total_usd: nanodollarsToUsd(totalNanos) };
    }
  } catch {
    // Fall through; a corrupt existing ledger is not a fresh day.
  }
  return undefined;
}

function writeDaily(resultsDirPath, data) {
  const file = dailyFilePath(resultsDirPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

export function getDailySpend(resultsDirPath) {
  const daily = readDaily(resultsDirPath);
  return daily ? daily.total_usd : Number.NaN;
}

export function getDailySpendNanos(resultsDirPath) {
  const daily = readDaily(resultsDirPath);
  return daily ? daily.total_nanos : undefined;
}

function lockReason(resultsDirPath) {
  const inMemory = telemetryLocks.get(resultsDirPath);
  if (inMemory) return inMemory;
  try {
    const parsed = JSON.parse(fs.readFileSync(telemetryLockFilePath(resultsDirPath), 'utf8'));
    if (parsed && typeof parsed.reason === 'string' && parsed.reason) {
      telemetryLocks.set(resultsDirPath, parsed.reason);
      return parsed.reason;
    }
  } catch {
    // no lock file is normal; unreadable one is itself an unsafe condition.
    if (fs.existsSync(telemetryLockFilePath(resultsDirPath))) {
      const reason = 'cost telemetry lock is unreadable';
      telemetryLocks.set(resultsDirPath, reason);
      return reason;
    }
  }
  return undefined;
}

export function lockCostTelemetry(resultsDirPath, reason = 'cost telemetry is unavailable') {
  const safeReason = 'cost telemetry is unavailable';
  // Do not serialize provider/transport error text into plan state or logs.
  telemetryLocks.set(resultsDirPath, safeReason);
  try {
    const file = telemetryLockFilePath(resultsDirPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify({ date: todayUtc(), reason: safeReason, at: new Date().toISOString() }, null, 2));
    fs.renameSync(tmp, file);
  } catch {
    // Map above is intentionally retained even when persistence itself fails.
  }
  return safeReason;
}

export function getCostTelemetryLock(resultsDirPath) {
  const existing = lockReason(resultsDirPath);
  if (existing) return existing;
  if (!readDaily(resultsDirPath)) return lockCostTelemetry(resultsDirPath, 'daily spend ledger is corrupt');
  return undefined;
}

/** Call before every LLM engine call (phase1, groom). */
export function checkDaily(resultsDirPath, env = process.env) {
  const locked = lockReason(resultsDirPath);
  if (locked) return { blocked: true, reason: locked, telemetryLocked: true };
  const dailyData = readDaily(resultsDirPath);
  if (!dailyData) {
    const reason = lockCostTelemetry(resultsDirPath, 'daily spend ledger is corrupt');
    return { blocked: true, reason, telemetryLocked: true };
  }
  const hard = envFloat(env, 'RADSVINN_DAILY_HARD_USD', DEFAULT_DAILY_HARD_USD);
  const soft = envFloat(env, 'RADSVINN_DAILY_SOFT_USD', DEFAULT_DAILY_SOFT_USD);
  const totalNanos = dailyData.total_nanos;
  const hardNanos = usdToNanodollars(hard);
  const softNanos = usdToNanodollars(soft);
  const total = nanodollarsToUsd(totalNanos);

  if (totalNanos >= hardNanos) {
    return {
      blocked: true,
      reason: `daily spend $${total.toFixed(2)} has met/exceeded the hard cap $${hard.toFixed(2)}`,
      total,
      hard,
      soft,
    };
  }
  if (totalNanos >= softNanos && !warnedSoftThisBoot) {
    warnedSoftThisBoot = true;
    // eslint-disable-next-line no-console
    console.error(
      `[radsvinn] WARNING: daily spend $${total.toFixed(2)} has crossed the soft cap $${soft.toFixed(2)} (hard cap $${hard.toFixed(2)})`,
    );
  }
  return { blocked: false, total, totalNanos, hard, hardNanos, soft, softNanos };
}

/** Call before groom and phase1 bounded-regen calls (B2, cost>0-gated). */
export function checkPlanBudget(plan, env = process.env) {
  const cap = envFloat(env, 'RADSVINN_PLAN_BUDGET_USD', DEFAULT_PLAN_BUDGET_USD);
  const capNanos = usdToNanodollars(cap);
  let costNanos;
  try {
    if (Object.hasOwn(plan, 'cost_nanos')) {
      if (!Number.isSafeInteger(plan.cost_nanos) || plan.cost_nanos < 0) throw new Error('invalid fixed-point plan cost');
      costNanos = plan.cost_nanos;
    } else {
      costNanos = usdToNanodollars(plan.cost_usd === undefined ? 0 : plan.cost_usd);
    }
  } catch {
    return { blocked: true, reason: 'plan spend telemetry is invalid', cap, capNanos };
  }
  const cost = nanodollarsToUsd(costNanos);
  if (costNanos >= capNanos) {
    return {
      blocked: true,
      reason: `plan spend $${cost.toFixed(2)} has met/exceeded the per-plan cap $${cap.toFixed(2)}`,
      cap, capNanos,
    };
  }
  return { blocked: false, cap, capNanos, costNanos };
}

// Every spend mutation is serialized through one in-process
// promise chain. `recordSpend` is a read-modify-write over the daily file;
// without the queue, two concurrent async workers whose read/write halves
// interleave would both read the same starting total and one increment
// would be silently LOST — an undercount on the file that meters the daily
// hard cap. The chain makes each mutation run to completion before the next
// begins, whatever the callers' interleaving. SINGLE-INSTANCE ONLY: this is
// an in-process mutex; two service processes sharing one results dir can
// still interleave at the filesystem; a multi-instance deployment needs a
// database-backed atomic update, not more file locking here.
let spendQueue = Promise.resolve();

/**
 * Adds `costUsd` to today's rolling total, serialized behind every other
 * in-flight spend mutation. Returns a promise of the new total — callers
 * MUST await it (server.mjs workers do) so a later checkDaily can never
 * read a total that is still missing this increment.
 */
export function recordSpendNanos(resultsDirPath, costNanos) {
  if (!Number.isSafeInteger(costNanos) || costNanos < 0) {
    lockCostTelemetry(resultsDirPath, 'invalid cost telemetry');
    return Promise.reject(new Error('refusing to record invalid cost telemetry'));
  }
  const next = spendQueue.then(() => {
    if (lockReason(resultsDirPath)) throw new Error('cost telemetry is locked');
    const current = readDaily(resultsDirPath);
    if (!current) {
      lockCostTelemetry(resultsDirPath, 'daily spend ledger is corrupt');
      throw new Error('daily spend ledger is corrupt');
    }
    current.total_nanos += costNanos;
    if (!Number.isSafeInteger(current.total_nanos)) {
      lockCostTelemetry(resultsDirPath, 'daily spend ledger overflow');
      throw new Error('daily spend ledger overflow');
    }
    current.total_usd = nanodollarsToUsd(current.total_nanos);
    writeDaily(resultsDirPath, current);
    return current.total_usd;
  });
  // The chain must survive a rejected link (fs error): park the next link on
  // a settled continuation so one failed write can never wedge every future
  // spend record. The CALLER still sees the rejection via `next`.
  spendQueue = next.catch(() => {
    lockCostTelemetry(resultsDirPath, 'cost telemetry ledger write failed');
  });
  return next;
}

/** Legacy USD wrapper retained for direct Anthropic/fake engines and callers. */
export function recordSpend(resultsDirPath, costUsd) {
  let nanos;
  try { nanos = usdToNanodollars(costUsd); } catch {
    lockCostTelemetry(resultsDirPath, 'invalid cost telemetry');
    return Promise.reject(new Error('refusing to record invalid cost telemetry'));
  }
  return recordSpendNanos(resultsDirPath, nanos);
}

/** Test-only: resets the "warned once per boot" flag between test cases. */
export function _resetWarnFlagForTests() {
  warnedSoftThisBoot = false;
  telemetryLocks.clear();
}
