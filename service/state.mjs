// state.mjs — in-memory plan store + file persistence + crash-resume.
//
// One JSON file per plan under `${resultsRoot}/service/plans/<plan_id>.json`,
// written atomically (tmp file + rename) on every mutation. On boot, `load()`
// replays those files into memory; any plan caught in a TRANSIENT status
// (still in-flight when the process died) is honestly reloaded as `failed`
// with `error: "interrupted by restart"` — no zombie workers, no silent
// resume of a call that never actually finished.
//
// `RADSVINN_RESULTS_DIR` (relative to the radsvinn repo root, or an absolute
// path) overrides where all of this lives — tests set it to a fresh tmp
// directory per run for isolation.
//
// IMPORTANT — `State` snapshots its results root ONCE, at construction time
// (`new State()` reads `RADSVINN_RESULTS_DIR` right then and never again).
// It does NOT re-read `process.env` on every load/persist call. This isn't
// stylistic: a fire-and-forget worker (server.mjs never awaits
// `runXWorker(...)`) can still be running after its HTTP response was sent;
// if persistence re-read `readEnv('RADSVINN_RESULTS_DIR')` on every write, a
// *different*, concurrently-running test/request that resets or deletes that
// env var (e.g. in its own teardown) could redirect an in-flight worker's
// writes into the wrong directory — concretely, into this repo's own real
// `results/` instead of an isolated tmp dir. Capturing the root once per
// `State` instance makes that instance immune to later env mutations by
// anything else.

import { readEnv } from '../dashboard/lib/env.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RADSVINN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Statuses that mean "a worker was actively running this" — never valid to
// find on disk at boot time, since nothing is running yet.
// `cancelling` (cancel flow) belongs here too: a cancel interrupted by a crash reloads
// honestly as `failed`. That is SAFE, not just honest — the plan's `created`
// marker survives the reload untouched, so the failed message re-offers the
// Cancel button (re-clicking re-runs the idempotent --cleanup sweep) and a
// Retry click routes through retry write guard's verify-only guard (case A or B by the
// marker's `partial` flag; both read, never write) — neither path can
// re-create or lose the tree's cleanup handle.
export const TRANSIENT_STATUSES = new Set(['breaking_down', 'grooming', 'creating', 'cancelling']);

/** Reads RADSVINN_RESULTS_DIR from the environment RIGHT NOW. Callers that
 * need a value stable for a whole server/State lifetime should call this
 * once and hold onto the result, not call it repeatedly. */
export function resultsDir() {
  const dir = readEnv('RADSVINN_RESULTS_DIR') || 'results';
  return path.isAbsolute(dir) ? dir : path.join(RADSVINN_ROOT, dir);
}

export function plansDir(root = resultsDir()) {
  return path.join(root, 'service', 'plans');
}

export function agentRunDir(planId, root = resultsDir()) {
  return path.join(root, 'agent', `svc-${planId}`);
}

function atomicWriteJson(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, filePath);
}

export class State {
  /** @param {string} [root] results-root override; defaults to snapshotting `resultsDir()` once, now. */
  constructor(root) {
    this.root = root || resultsDir();
    this.plans = new Map();
  }

  /**
   * Boot-time load: replay every persisted plan file into memory. Plans
   * stuck in a transient (in-flight) status are corrected to `failed` both
   * in memory and back out to disk — honest, no zombie workers.
   *
   * Client-owned record fields (the `surface` reply-to
   * descriptor and `announced_status` delivery cursor) ride this reload
   * UNTOUCHED — the sweep rewrites only status/error/updated_at. That is
   * load-bearing for Window B: a plan swept to `failed` here still carries
   * its cursor, so a surface client that also restarted can see the failure
   * is PAST what it last announced and deliver the ⚠️ (with its Retry
   * button) instead of losing it.
   */
  load() {
    const dir = plansDir(this.root);
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.json') || file.includes('.tmp-')) continue;
      const full = path.join(dir, file);
      let plan;
      try {
        plan = JSON.parse(fs.readFileSync(full, 'utf8'));
      } catch {
        continue; // corrupt/partial file — skip, never crash boot over it
      }
      if (!plan || typeof plan.plan_id !== 'string') continue;
      if (TRANSIENT_STATUSES.has(plan.status)) {
        plan.status = 'failed';
        plan.error = 'interrupted by restart';
        plan.updated_at = new Date().toISOString();
        atomicWriteJson(full, plan);
      }
      this.plans.set(plan.plan_id, plan);
    }
  }

  create(plan) {
    this.plans.set(plan.plan_id, plan);
    this._persist(plan);
    return plan;
  }

  get(planId) {
    return this.plans.get(planId);
  }

  /** Shallow-merges `patch` onto the existing plan and persists the result. */
  update(planId, patch) {
    const existing = this.plans.get(planId);
    if (!existing) return undefined;
    const next = { ...existing, ...patch };
    this.plans.set(planId, next);
    this._persist(next);
    return next;
  }

  /**
   * Compare-and-swap status transition — the ONLY safe way to change a
   * plan's status from a request handler. Entirely synchronous (check and
   * write with no await in between), so two handlers racing on the same
   * plan cannot both win: the second CAS sees the first one's status and
   * misses. Added after an adversarial review empirically reproduced (a) a
   * reject being silently overridden by an in-flight create and (b) a
   * double approve-shape running groom twice (TOCTOU between a status
   * check and a later `update` separated by `await readJsonBody`).
   */
  transition(planId, expectedStatuses, patch) {
    const existing = this.plans.get(planId);
    if (!existing) return { ok: false, reason: 'not_found' };
    if (!expectedStatuses.includes(existing.status)) {
      return { ok: false, reason: 'conflict', status: existing.status };
    }
    const next = { ...existing, ...patch };
    this.plans.set(planId, next);
    this._persist(next);
    return { ok: true, plan: next };
  }

  _persist(plan) {
    atomicWriteJson(path.join(plansDir(this.root), `${plan.plan_id}.json`), plan);
  }
}
