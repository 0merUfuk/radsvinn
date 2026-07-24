// reprecheck.mjs — re-derive the deterministic prechecks + verdicts over a
// COMPLETED calibration run, WITHOUT re-spending on any model call.
//
//   node reprecheck.mjs <runDir> [--only <ask-id>] [--dry-run]
//
// Why this exists
// ───────────────
// The harness fell OPEN on any plan treecheck could not parse: a contract
// failure returns ok:false with NO per-item verdicts, so `precheckHardFail` was
// false for every ticket and the whole plan fell through to LLM-only scoring —
// the deterministic gate (anchors / single-repo / coupling-zone routing
// protection / sizing) was BYPASSED for the run.
//
// After the Go FlexStrings fix (scalar-or-array string fields) and the harness
// fail-CLOSED guard, this tool RE-RUNS treecheck on every stored plan.json and
// re-derives each ticket's verdict against the now-correct precheck result:
//
//   verdict = precheckHardFail ? 'BLOCK' : <the floored LLM verdict>
//
// The LLM per-field scores, weighted total, and justifications ALREADY on disk
// are PRESERVED verbatim — only `verdict` / `verdict_reason` are recomputed,
// using the SAME (frozen) thresholds + floors the run scored against. NO model
// is called. Tree scores are untouched. Everything else is preserved.
//
// --dry-run   compute + report the verdict delta, write NOTHING (preview).
// --only ID   restrict to a single ask dir.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {
  loadConfig, loadJson, writeJson, buildTreecheck, runTreecheck,
  verdictFor, applyVerdictFloors, parseArgs, safeKey, HARNESS_DIR, MERCURY_ROOT,
} from './lib.mjs';

const CONTRACT_REASON = 'plan failed the deterministic contract gate (treecheck could not parse the plan)';

// metaTicketScore mirrors run-calibration.mjs: the compact per-ticket entry
// stored under meta.json `ticket_scores`.
function metaTicketScore(s) {
  return {
    temp_id: s.temp_id, total: s.total, verdict: s.verdict,
    ...(s.verdict_reason ? { verdict_reason: s.verdict_reason } : {}),
    ...(s.judge_failed ? { judge_failed: true } : {}),
  };
}

// refloorTicket recomputes ONE ticket's verdict + verdict_reason from its
// preserved LLM scores and the now-correct precheck result. It NEVER touches
// the LLM per-field scores, weighted total, llm_total, or justifications.
//
//   precheckHardFail === true  -> BLOCK (a failed deterministic gate always wins)
//   otherwise                  -> the floored LLM verdict, re-derived from the
//                                 stored unrounded total + by_field scores
//   judge never produced a score -> preserve the JUDGE_FAILED outcome
function refloorTicket(stored, { precheckHardFail, planContractFailed, cutoffs, floors }) {
  const out = { ...stored };
  delete out.verdict_reason; // re-added below only when one applies

  if (precheckHardFail) {
    out.verdict = 'BLOCK';
    out.verdict_reason = planContractFailed ? CONTRACT_REASON : 'deterministic precheck hard-fail';
    return out;
  }

  const judgeFailed = stored.judge_failed === true || stored.total_raw == null || stored.by_field == null;
  if (judgeFailed) {
    out.verdict = 'JUDGE_FAILED';
    if (stored.verdict_reason) out.verdict_reason = stored.verdict_reason; // preserve the judge-failure detail
    return out;
  }

  const base = verdictFor(stored.total_raw, cutoffs);
  const { verdict, floorReasons } = applyVerdictFloors('ticket', stored.by_field, base, floors);
  out.verdict = verdict;
  if (floorReasons.length) out.verdict_reason = `verdict floor: ${floorReasons.join('; ')}`;
  return out;
}

// reprecheckAsk re-derives one ask dir. Returns a summary row (or null if the
// dir has no reusable plan.json — an escalated ask).
function reprecheckAsk(askDir, askId, ctx) {
  const planPath = path.join(askDir, 'plan.json');
  if (!fs.existsSync(planPath)) return null;
  const plan = loadJson(planPath);
  if (!plan || !Array.isArray(plan.items) || plan.items.length === 0) return null;

  // 1. Re-run treecheck on the stored plan (parses now, after the Go fix).
  const tc = runTreecheck(ctx.bin, 'plan', JSON.stringify(plan), ctx.tcOpts);
  const planItems = tc.verdict.items || {};
  const planContractFailed = tc.verdict.ok === false && Object.keys(planItems).length === 0;

  const planHardFails = [];
  for (const [tid, v] of Object.entries(planItems)) {
    if (v.hard_fail) planHardFails.push({ temp_id: tid, regen_complaint: v.regen_complaint });
  }
  const planPrecheck = { ok: tc.verdict.ok, contract_failed: planContractFailed, hard_fails: planHardFails };

  // 2. Re-floor each ticket, preserving its LLM score.
  const metaPath = path.join(askDir, 'meta.json');
  const meta = fs.existsSync(metaPath) ? loadJson(metaPath) : null;
  const newMetaTicketScores = [];
  const changes = [];
  let unexpectedRefloor = 0;

  for (const item of plan.items) {
    const tid = item.temp_id;
    const scorePath = path.join(askDir, `ticket-score.${safeKey(tid)}.json`);
    if (!fs.existsSync(scorePath)) {
      console.warn(`  WARN ${askId}/${tid}: no ticket-score file — skipped`);
      continue;
    }
    const stored = loadJson(scorePath);
    const itemVerdict = planItems[tid] || null;
    const precheckHardFail = planContractFailed || !!(itemVerdict && itemVerdict.hard_fail);
    const reflored = refloorTicket(stored, {
      precheckHardFail, planContractFailed, cutoffs: ctx.cutoffs, floors: ctx.floors,
    });

    // Integrity check: when precheck passes, re-flooring must reproduce the
    // stored verdict (frozen thresholds/floors). A mismatch here means the
    // freeze assumption was violated — surfaced loudly, never silently applied.
    if (!precheckHardFail && reflored.verdict !== stored.verdict) unexpectedRefloor++;

    if (reflored.verdict !== stored.verdict) {
      changes.push({ tid, from: stored.verdict, to: reflored.verdict });
    }
    if (!ctx.dryRun) writeJson(scorePath, reflored);
    newMetaTicketScores.push(metaTicketScore(reflored));
  }

  // 1b + 3. Persist treecheck-plan.json + meta.json (plan_precheck + mirror).
  if (!ctx.dryRun) {
    writeJson(path.join(askDir, 'treecheck-plan.json'), tc.verdict);
    if (meta) {
      meta.plan_precheck = planPrecheck;
      meta.ticket_scores = newMetaTicketScores;
      writeJson(metaPath, meta);
    }
  }

  const verdictCounts = { PASS: 0, FLAG: 0, BLOCK: 0, JUDGE_FAILED: 0 };
  for (const s of newMetaTicketScores) {
    if (verdictCounts[s.verdict] !== undefined) verdictCounts[s.verdict]++;
  }
  return {
    askId,
    ticketCount: newMetaTicketScores.length,
    contractFailed: planContractFailed,
    planOk: tc.verdict.ok,
    hardFails: planHardFails.length,
    verdictCounts,
    changes,
    unexpectedRefloor,
    firstComplaint: planContractFailed
      ? (tc.verdict.checks?.contract_valid?.complaints?.[0] ?? '(contract failure)')
      : null,
  };
}

// rebuildSummary re-derives summary.json `asks` rows + totals from the updated
// meta.json files (a pure derivation of what we just rewrote), preserving every
// other summary field. Skipped on --dry-run.
function rebuildSummary(runDir) {
  const summaryPath = path.join(runDir, 'summary.json');
  if (!fs.existsSync(summaryPath)) return;
  const summary = loadJson(summaryPath);
  const rows = [];
  for (const e of fs.readdirSync(runDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const mp = path.join(runDir, e.name, 'meta.json');
    if (!fs.existsSync(mp)) continue;
    const meta = loadJson(mp);
    const vc = { PASS: 0, FLAG: 0, BLOCK: 0, JUDGE_FAILED: 0 };
    for (const t of meta.ticket_scores || []) if (vc[t.verdict] !== undefined) vc[t.verdict]++;
    rows.push({
      ask_id: meta.ask_id,
      stratum: meta.stratum === 'big' ? 'big' : 'small',
      status: meta.status,
      tree_total: meta.tree_score ? meta.tree_score.total : null,
      tree_verdict: meta.tree_score ? meta.tree_score.verdict : null,
      ticket_count: (meta.ticket_scores || []).length,
      ticket_verdicts: vc,
      plan_precheck_hard_fails: meta.plan_precheck?.hard_fails?.length ?? 0,
      regen_attempts: Math.max(0, (meta.regen?.decompose_attempts ?? 1) - 1),
      cost_usd: meta.cost_usd ?? 0,
    });
  }
  rows.sort((a, b) => a.ask_id.localeCompare(b.ask_id));
  summary.asks = rows;
  summary.reprecheck = {
    at: new Date().toISOString(),
    note: 'verdicts re-derived from stored plan.json + LLM scores; NO model re-spend',
  };
  writeJson(summaryPath, summary);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = !!args['dry-run'];
  const target = args._[0];
  if (!target) {
    console.error('usage: node reprecheck.mjs <runDir> [--only <ask-id>] [--dry-run]');
    process.exit(2);
  }

  // Resolve the run dir against cwd, the harness dir, and the mercury root
  // (same resolution order as run-calibration --rejudge).
  const cands = [
    path.isAbsolute(target) ? target : path.resolve(process.cwd(), target),
    path.resolve(HARNESS_DIR, target),
    path.resolve(MERCURY_ROOT, target),
  ];
  const runDir = cands.find((c) => fs.existsSync(c) && fs.statSync(c).isDirectory());
  if (!runDir) {
    console.error(`reprecheck: run dir not found: ${target}`);
    process.exit(2);
  }

  const cfg = loadConfig();
  const ctx = {
    dryRun,
    cutoffs: cfg.thresholds.verdicts,
    floors: cfg.verdict_floors,
    tcOpts: {
      thresholds: cfg.absPaths.thresholds,
      couplingMap: cfg.absPaths.coupling_map,
      reposRoot: cfg.absPaths.repos_root,
    },
    // Build treecheck once into a throwaway temp dir — never touch the run's
    // own bin/ (that would mutate a preserved artifact).
    bin: buildTreecheck(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'reprecheck-')), 'treecheck')),
  };

  const askDirs = fs.readdirSync(runDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(runDir, d.name, 'plan.json')))
    .map((d) => d.name)
    .filter((n) => !args.only || n === args.only)
    .sort();

  console.log(`reprecheck ${runDir} — ${dryRun ? 'DRY-RUN (no writes)' : 'APPLYING'} — ${askDirs.length} ask(s) with plan.json`);
  console.log(`  thresholds: pass>=${ctx.cutoffs.pass_min} flag>=${ctx.cutoffs.flag_min}  repos_root: ${ctx.tcOpts.reposRoot}\n`);

  const rows = [];
  const totalBefore = { PASS: 0, FLAG: 0, BLOCK: 0, JUDGE_FAILED: 0 };
  const totalAfter = { PASS: 0, FLAG: 0, BLOCK: 0, JUDGE_FAILED: 0 };
  let flips = 0;
  let unexpected = 0;

  for (const name of askDirs) {
    const row = reprecheckAsk(path.join(runDir, name), name, ctx);
    if (!row) {
      console.log(`  ${name}: no reusable plan.json — skipped`);
      continue;
    }
    rows.push(row);
    for (const c of row.changes) {
      if (totalBefore[c.from] !== undefined) totalBefore[c.from]++;
      // "after" tally is done from verdictCounts below; here we only count flips
    }
    flips += row.changes.length;
    unexpected += row.unexpectedRefloor;
    for (const k of Object.keys(totalAfter)) totalAfter[k] += row.verdictCounts[k];

    const tag = row.contractFailed ? `CONTRACT_FAIL(${row.firstComplaint})` : `parsed ok=${row.planOk} hardfails=${row.hardFails}`;
    const flipStr = row.changes.length
      ? '  flips: ' + row.changes.map((c) => `${c.tid} ${c.from}->${c.to}`).join(', ')
      : '  (no verdict change)';
    console.log(`  ${name}: n=${row.ticketCount} -> P/F/B/J=${row.verdictCounts.PASS}/${row.verdictCounts.FLAG}/${row.verdictCounts.BLOCK}/${row.verdictCounts.JUDGE_FAILED}  [${tag}]${flipStr}`);
  }

  if (!dryRun) rebuildSummary(runDir);

  const afterTotal = Object.values(totalAfter).reduce((a, b) => a + b, 0);
  console.log(`\n── TOTALS (${dryRun ? 'preview' : 'applied'}) ─────────────────────────────`);
  console.log(`  tickets re-derived: ${afterTotal}   verdict flips: ${flips}`);
  console.log(`  AFTER  P/F/B/J = ${totalAfter.PASS}/${totalAfter.FLAG}/${totalAfter.BLOCK}/${totalAfter.JUDGE_FAILED}`);
  console.log(`  contract-failed plans: ${rows.filter((r) => r.contractFailed).length} / ${rows.length}`);
  if (unexpected > 0) {
    console.log(`  ⚠ ${unexpected} precheck-passing ticket(s) changed verdict on re-floor — thresholds/floors may have drifted from the run (freeze violated).`);
  }
  console.log(dryRun ? '\n  DRY-RUN: no files written.' : `\n  Written back into: ${runDir}`);
}

main();
