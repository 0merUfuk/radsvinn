// score-agreement.mjs — read a FILLED labels.csv, join it against the RUN DIR
// artifacts, and compute the DoD numbers.
//
//   node score-agreement.mjs --run results/<run> [--labels <csv>] [--dod] [--no-verify]
//
// TRUST MODEL: judge totals/verdicts are ALWAYS read from the run dir
// (tree-score.json / ticket-score.<temp_id>.json), joined on ask_id + temp_id.
// The csv's judge columns are display-only, may legitimately be EMPTY (blind
// labeling), and are never used for scoring — only cross-checked for tampering.
//
// --verify is ON BY DEFAULT (disable with --no-verify or --verify false).
// It REFUSES to print a DoD verdict when the instrument is compromised:
//   (a) metas across asks carry more than one distinct prompt-hash set
//       (prompts changed mid-run),
//   (b) internal/checks/thresholds.yaml's hash NOW differs from the hash
//       stamped into the metas at run time (the freeze rule), or
//   (c) any csv judge column is non-empty but mismatches the run dir.
//
// Reported (all also emitted into agreement.json):
//   1. hand-to-dev rate + Wilson 95% CI          bar: >= 16/20
//   2. tree judge-vs-human agreement + Cohen's kappa + marginals   bar: >= 80%
//      (ADVISORY — printed but excluded from the DoD verdict — when the run
//       has fewer than 10 big-stratum asks)
//   3. ticket judge-vs-human agreement + Cohen's kappa + marginals bar: >= 80%
//   plus soft_disagreements (judge FLAG where the human said y).
//
// --dod additionally hard-gates the held-out preconditions and WITHHOLDS the
// verdict unless: exactly 20 asks; every big-stratum ask carries an explicit
// y/n tree label; every ticket row (csv AND run dir) is labeled y/n.

import path from 'node:path';
import fs from 'node:fs';
import { loadConfig, loadJson, readText, writeJson, parseArgs, sha256File, safeKey, HARNESS_DIR, MERCURY_ROOT } from './lib.mjs';

const HAND_TO_DEV_BAR = 16; // out of 20 (held-out DoD set)
const HELD_OUT_N = 20;
const AGREEMENT_BAR = 0.8;
const MIN_BIG_ASKS_FOR_TREE_GATE = 10; // below this the tree agreement is advisory-only

function resolveRun(runArg) {
  if (!runArg) { console.error('usage: node score-agreement.mjs --run results/<run> [--labels <csv>] [--dod] [--no-verify]'); process.exit(2); }
  const cands = [
    path.isAbsolute(runArg) ? runArg : path.resolve(process.cwd(), runArg),
    path.resolve(HARNESS_DIR, runArg),
    path.resolve(MERCURY_ROOT, runArg),
  ];
  for (const dir of cands) if (fs.existsSync(dir)) return dir;
  console.error(`run dir not found: ${runArg}`); process.exit(2);
}

// ───────────────────────────── csv parsing ────────────────────────────────

// splitCsvFields splits one CSV line with minimal RFC4180 quoting support: a
// field wrapped in double quotes may contain commas, and an embedded quote is
// doubled (""). Newlines inside quoted fields are NOT supported — the caller
// splits the file on newlines first (labels are one row per line by design).
function splitCsvFields(line) {
  const fields = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else { inQuotes = false; }
      } else {
        cur += ch;
      }
    } else if (ch === '"' && cur === '') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

// headerIndex maps column names to indices from the actual header line, so
// both the current csv shape (with stratum) and the legacy shape (without)
// parse correctly. Unknown layouts fall back to the current positional order.
function headerIndex(headerLine) {
  const cols = splitCsvFields(headerLine).map((c) => c.trim().toLowerCase());
  const find = (pred, fallback) => {
    const i = cols.findIndex(pred);
    return i >= 0 ? i : fallback;
  };
  const hasStratum = cols.includes('stratum');
  const shift = hasStratum ? 1 : 0;
  return {
    ask_id: find((c) => c === 'ask_id', 0),
    level: find((c) => c === 'level', 1),
    stratum: hasStratum ? find((c) => c === 'stratum', 2) : -1,
    item_temp_id: find((c) => c === 'item_temp_id', 2 + shift),
    judge_total: find((c) => c === 'judge_total', 3 + shift),
    judge_verdict: find((c) => c === 'judge_verdict', 4 + shift),
    human_dev_ready: find((c) => c.startsWith('human_dev_ready'), 5 + shift),
    human_breakdown_good: find((c) => c.startsWith('human_breakdown_good'), 6 + shift),
    notes: find((c) => c === 'notes', 7 + shift),
  };
}

// parseCsvLine splits a label row (quote-aware). Hand-typed notes may still
// contain UNquoted commas, so any extra trailing fields are folded back into
// the notes column.
function parseCsvLine(line, ix) {
  const p = splitCsvFields(line);
  const g = (i) => (i >= 0 && i < p.length ? p[i] : '');
  return {
    ask_id: g(ix.ask_id).trim(),
    level: g(ix.level).trim(),
    stratum: ix.stratum >= 0 ? g(ix.stratum).trim().toLowerCase() : '',
    item_temp_id: g(ix.item_temp_id).trim(),
    judge_total: g(ix.judge_total).trim(),
    judge_verdict: g(ix.judge_verdict).trim(),
    human_dev_ready: g(ix.human_dev_ready).trim().toLowerCase(),
    human_breakdown_good: g(ix.human_breakdown_good).trim().toLowerCase(),
    notes: p.slice(ix.notes).join(',').trim(),
  };
}

// ─────────────────────────── run-dir truth ────────────────────────────────

function readOptional(p) {
  return fs.existsSync(p) ? loadJson(p) : null;
}

// loadRunTruth loads the authoritative judge outcomes per ask from the run
// dir: meta.json (status/stratum/provenance/prompt hashes), tree-score.json
// and every ticket-score.<temp_id>.json named by the meta.
function loadRunTruth(runDir) {
  const truth = new Map();
  for (const e of fs.readdirSync(runDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(runDir, e.name);
    const meta = readOptional(path.join(dir, 'meta.json'));
    if (!meta) continue; // e.g. bin/
    const tree = readOptional(path.join(dir, 'tree-score.json'));
    const tickets = new Map();
    for (const ts of meta.ticket_scores || []) {
      const f = readOptional(path.join(dir, `ticket-score.${safeKey(ts.temp_id)}.json`));
      if (f) tickets.set(ts.temp_id, f);
    }
    truth.set(meta.ask_id || e.name, {
      meta, tree, tickets,
      stratum: meta.stratum === 'big' ? 'big' : 'small',
    });
  }
  return truth;
}

// ───────────────────────────── statistics ─────────────────────────────────

// wilson computes the 95% Wilson score interval for a binomial proportion.
function wilson(successes, n, z = 1.96) {
  if (!n) return null;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
  return {
    low: Math.max(0, Math.round((center - half) * 1e4) / 1e4,),
    high: Math.min(1, Math.round((center + half) * 1e4) / 1e4),
  };
}

// kappa2x2 computes Cohen's kappa over the judge-accept vs human-accept 2x2
// table. a=both yes, b=judge yes/human no, c=judge no/human yes, d=both no.
// Returns kappa=null when chance agreement is 1 (degenerate marginals).
function kappa2x2(a, b, c, d) {
  const n = a + b + c + d;
  const table = { judge_yes_human_yes: a, judge_yes_human_no: b, judge_no_human_yes: c, judge_no_human_no: d };
  const marginals = { judge_yes: a + b, judge_no: c + d, human_yes: a + c, human_no: b + d };
  if (!n) return { kappa: null, po: null, pe: null, table, marginals };
  const po = (a + d) / n;
  const pe = ((a + b) * (a + c) + (c + d) * (b + d)) / (n * n);
  const kappa = pe === 1 ? null : Math.round(((po - pe) / (1 - pe)) * 1e4) / 1e4;
  return { kappa, po: Math.round(po * 1e4) / 1e4, pe: Math.round(pe * 1e4) / 1e4, table, marginals };
}

// ─────────────────────────────── verify ───────────────────────────────────

// runVerify enforces instrument integrity (see file header). Returns
// { enabled, ok, violations, thresholds_sha256_now, prompt_hash_sets }.
function runVerify(cfg, truth, rows) {
  const violations = [];

  // (a) exactly ONE distinct prompt-hash set across metas.
  const sets = new Map();
  for (const [askId, t] of truth) {
    const ph = t.meta.prompt_sha256;
    const key = ph ? JSON.stringify(Object.keys(ph).sort().map((k) => [k, ph[k]])) : 'MISSING';
    if (!sets.has(key)) sets.set(key, []);
    sets.get(key).push(askId);
  }
  if (sets.has('MISSING')) {
    violations.push(`asks missing prompt_sha256 in meta.json: ${sets.get('MISSING').join(', ')}`);
  }
  if (sets.size > 1) {
    violations.push(`metas carry ${sets.size} distinct prompt-hash sets — prompts changed mid-run (asks per set: ${[...sets.values()].map((v) => v.join('+')).join(' | ')})`);
  }

  // (b) thresholds freeze: the hash NOW must equal the hash stamped at run time.
  const nowHash = sha256File(cfg.absPaths.thresholds);
  const unstamped = [];
  const stamped = new Set();
  for (const [askId, t] of truth) {
    const h = t.meta.provenance?.thresholds_sha256;
    if (!h) unstamped.push(askId);
    else stamped.add(h);
  }
  if (unstamped.length) {
    violations.push(`asks without a thresholds-hash stamp (pre-hardening run?): ${unstamped.join(', ')} — the freeze rule cannot be verified`);
  }
  for (const h of stamped) {
    if (h !== nowHash) {
      violations.push(`thresholds.yaml changed between run and scoring: stamped ${h.slice(0, 12)}… ≠ current ${nowHash.slice(0, 12)}… — the freeze rule is violated (weights/cutoffs no longer match the run)`);
    }
  }

  // (c) csv judge columns: non-empty values must match the run dir exactly.
  for (const r of rows) {
    const rowId = `${r.ask_id}${r.item_temp_id ? '/' + r.item_temp_id : ''} (${r.level})`;
    const t = truth.get(r.ask_id);
    if (!t) { violations.push(`csv row ${rowId} references an ask that is not in the run dir`); continue; }
    const truthScore = r.level === 'tree' ? t.tree : t.tickets.get(r.item_temp_id);
    if (r.level === 'ticket' && !truthScore) {
      violations.push(`csv row ${rowId} has no ticket-score artifact in the run dir`);
      continue;
    }
    if ((r.judge_total !== '' || r.judge_verdict !== '') && !truthScore) {
      violations.push(`csv row ${rowId} carries judge values but the run dir has no score artifact for it`);
      continue;
    }
    if (r.judge_total !== '' && truthScore && Number(r.judge_total) !== Number(truthScore.total)) {
      violations.push(`csv judge_total mismatch for ${rowId}: csv=${r.judge_total} run-dir=${truthScore.total}`);
    }
    if (r.judge_verdict !== '' && truthScore && r.judge_verdict !== truthScore.verdict) {
      violations.push(`csv judge_verdict mismatch for ${rowId}: csv=${r.judge_verdict} run-dir=${truthScore.verdict}`);
    }
  }

  return {
    enabled: true, ok: violations.length === 0, violations,
    thresholds_sha256_now: nowHash,
    prompt_hash_sets: sets.size,
  };
}

// ─────────────────────────────────  main  ─────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRun(args.run);
  const labelsPath = args.labels
    ? (path.isAbsolute(args.labels) ? args.labels : path.resolve(process.cwd(), args.labels))
    : path.join(runDir, 'labels.csv');
  if (!fs.existsSync(labelsPath)) { console.error(`labels csv not found: ${labelsPath}`); process.exit(2); }

  const dodMode = !!args.dod;
  const verifyEnabled = !(args['no-verify'] === true
    || String(args.verify).toLowerCase() === 'false'
    || String(args.verify) === '0'
    || String(args.verify).toLowerCase() === 'off');

  const cfg = loadConfig();
  const passMin = cfg.thresholds.verdicts.pass_min;

  const lines = readText(labelsPath).split(/\r?\n/).filter((l) => l.trim().length);
  if (lines.length < 2) { console.error(`labels csv has no data rows: ${labelsPath}`); process.exit(2); }
  const ix = headerIndex(lines[0]);
  const rows = lines.slice(1).map((l) => parseCsvLine(l, ix));

  const truth = loadRunTruth(runDir);

  const byAsk = new Map();
  for (const r of rows) {
    if (!byAsk.has(r.ask_id)) byAsk.set(r.ask_id, { tree: null, tickets: [] });
    if (r.level === 'tree') byAsk.get(r.ask_id).tree = r;
    else if (r.level === 'ticket') byAsk.get(r.ask_id).tickets.push(r);
  }
  const askIds = [...byAsk.keys()];
  const stratumOf = (askId) => {
    const t = truth.get(askId);
    if (t) return t.stratum; // run dir meta is authoritative
    const g = byAsk.get(askId);
    return (g?.tree?.stratum === 'big' || g?.tickets.some((x) => x.stratum === 'big')) ? 'big' : 'small';
  };

  // ── verify (default ON) ──
  const verify = verifyEnabled
    ? runVerify(cfg, truth, rows)
    : { enabled: false, ok: true, violations: [], thresholds_sha256_now: sha256File(cfg.absPaths.thresholds), prompt_hash_sets: null };

  // ── 1. hand-to-dev rate (+ Wilson 95% CI) ──
  // An ask hands to dev iff every ticket row is labeled y AND the tree is not
  // disavowed: big-stratum asks REQUIRE an explicit tree y; small asks fail
  // only on an explicit tree n.
  let handToDev = 0;
  const handDetail = [];
  for (const id of askIds) {
    const { tree, tickets } = byAsk.get(id);
    const stratum = stratumOf(id);
    const allTicketsReady = tickets.length > 0 && tickets.every((t) => t.human_dev_ready === 'y');
    const treeLabel = tree ? tree.human_breakdown_good : '';
    const treeOk = stratum === 'big' ? treeLabel === 'y' : treeLabel !== 'n';
    const ok = allTicketsReady && treeOk;
    if (ok) handToDev++;
    handDetail.push({ ask_id: id, stratum, hand_to_dev: ok, all_tickets_ready: allTicketsReady, tree_label: treeLabel || null, tree_ok: treeOk });
  }
  const handRatio = askIds.length ? handToDev / askIds.length : 0;
  const handCI = wilson(handToDev, askIds.length);

  // ── 2. tree-level agreement (asks with an explicit y/n tree label) ──
  // Judge-accept is the RUN DIR verdict === PASS (computed in code from the
  // unrounded total, floors and forced verdicts included) — never csv numbers.
  let tA = 0, tB = 0, tC = 0, tD = 0;
  let softTree = 0;
  let judgeFailedTrees = 0;
  for (const id of askIds) {
    const tree = byAsk.get(id).tree;
    if (!tree) continue;
    const hb = tree.human_breakdown_good;
    if (hb !== 'y' && hb !== 'n') continue; // skip 'na'/blank
    const truthTree = truth.get(id)?.tree;
    if (!truthTree || !truthTree.verdict) continue; // escalated before grading
    if (truthTree.verdict === 'JUDGE_FAILED') {
      // Judge never produced a score — the human label stands, but there is no
      // judge opinion to agree with. Excluded from the agreement pair count.
      judgeFailedTrees++;
      continue;
    }
    const judgeAccept = truthTree.verdict === 'PASS';
    const humanAccept = hb === 'y';
    if (judgeAccept && humanAccept) tA++;
    else if (judgeAccept && !humanAccept) tB++;
    else if (!judgeAccept && humanAccept) tC++;
    else tD++;
    if (truthTree.verdict === 'FLAG' && humanAccept) softTree++;
  }
  const treeMatch = tA + tD;
  const treeCount = tA + tB + tC + tD;
  const treeAgreement = treeCount ? treeMatch / treeCount : null;
  const treeKappa = kappa2x2(tA, tB, tC, tD);
  const bigAskCount = askIds.filter((id) => stratumOf(id) === 'big').length;
  const treeAdvisory = bigAskCount < MIN_BIG_ASKS_FOR_TREE_GATE;

  // ── 3. ticket-level agreement ──
  let kA = 0, kB = 0, kC = 0, kD = 0;
  let softTicket = 0;
  let judgeFailedTickets = 0;
  for (const id of askIds) {
    for (const t of byAsk.get(id).tickets) {
      const hr = t.human_dev_ready;
      if (hr !== 'y' && hr !== 'n') continue;
      const truthTicket = truth.get(id)?.tickets.get(t.item_temp_id);
      if (!truthTicket || !truthTicket.verdict) continue;
      if (truthTicket.verdict === 'JUDGE_FAILED' || truthTicket.judge_failed) {
        judgeFailedTickets++;
        continue; // no judge opinion — excluded from agreement, surfaced below
      }
      const judgeAccept = truthTicket.verdict === 'PASS';
      const humanAccept = hr === 'y';
      if (judgeAccept && humanAccept) kA++;
      else if (judgeAccept && !humanAccept) kB++;
      else if (!judgeAccept && humanAccept) kC++;
      else kD++;
      if (truthTicket.verdict === 'FLAG' && humanAccept) softTicket++;
    }
  }
  const tkMatch = kA + kD;
  const tkCount = kA + kB + kC + kD;
  const ticketAgreement = tkCount ? tkMatch / tkCount : null;
  const ticketKappa = kappa2x2(kA, kB, kC, kD);

  // ── --dod hard gates ──
  const dodProblems = [];
  if (dodMode) {
    if (askIds.length !== HELD_OUT_N) {
      dodProblems.push(`ask count is ${askIds.length} — the DoD requires exactly ${HELD_OUT_N} held-out asks`);
    }
    if (judgeFailedTrees > 0 || judgeFailedTickets > 0) {
      dodProblems.push(
        `run is judge-incomplete: ${judgeFailedTrees} tree + ${judgeFailedTickets} ticket JUDGE_FAILED — re-run the failed judges (--rejudge) before a DoD verdict`,
      );
    }
    for (const id of askIds) {
      const g = byAsk.get(id);
      if (stratumOf(id) === 'big') {
        const lbl = g.tree?.human_breakdown_good;
        if (lbl !== 'y' && lbl !== 'n') dodProblems.push(`big ask '${id}' has no explicit y/n tree label`);
      }
      for (const t of g.tickets) {
        if (t.human_dev_ready !== 'y' && t.human_dev_ready !== 'n') {
          dodProblems.push(`ticket ${id}/${t.item_temp_id} is unlabeled (needs y/n)`);
        }
      }
    }
    // Every run-dir ticket must appear (labeled) in the csv — missing rows are
    // unlabeled work, not a smaller denominator.
    for (const [askId, t] of truth) {
      for (const tid of t.tickets.keys()) {
        const has = byAsk.get(askId)?.tickets.some((r) => r.item_temp_id === tid);
        if (!has) dodProblems.push(`run-dir ticket ${askId}/${tid} is missing from labels.csv`);
      }
    }
  }

  // ── DoD verdict assembly ──
  const handPass = handRatio >= HAND_TO_DEV_BAR / HELD_OUT_N; // 16/20 == 0.8
  const treePass = treeAgreement !== null && treeAgreement >= AGREEMENT_BAR;
  const ticketPass = ticketAgreement !== null && ticketAgreement >= AGREEMENT_BAR;
  const gatedTreePass = treeAdvisory ? true : treePass; // advisory tree never gates
  const withheldReasons = [];
  if (verify.enabled && !verify.ok) withheldReasons.push('verify failed — instrument integrity is compromised');
  if (dodMode && dodProblems.length) withheldReasons.push('DoD preconditions unmet');
  const dod = withheldReasons.length
    ? `WITHHELD (${withheldReasons.join('; ')})`
    : (handPass && gatedTreePass && ticketPass ? 'PASS' : 'FAIL');

  const pct = (x) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const report = {
    run_id: path.basename(runDir),
    labels_csv: labelsPath,
    pass_min: passMin,
    judge_accept_source: 'run-dir verdict === PASS (tree-score.json / ticket-score.*.json; csv judge columns are never used for scoring)',
    dod_mode: dodMode,
    verify,
    dod_problems: dodProblems,
    hand_to_dev: {
      count: handToDev, total_asks: askIds.length, ratio: handRatio,
      wilson_ci_95: handCI,
      bar: `>= ${HAND_TO_DEV_BAR}/${HELD_OUT_N}`, pass: handPass, detail: handDetail,
    },
    tree_agreement: {
      matches: treeMatch, count: treeCount, ratio: treeAgreement,
      kappa: treeKappa.kappa, po: treeKappa.po, pe: treeKappa.pe,
      table: treeKappa.table, marginals: treeKappa.marginals,
      big_ask_count: bigAskCount, advisory: treeAdvisory,
      bar: `>= ${AGREEMENT_BAR * 100}%`, pass: treePass,
    },
    ticket_agreement: {
      matches: tkMatch, count: tkCount, ratio: ticketAgreement,
      kappa: ticketKappa.kappa, po: ticketKappa.po, pe: ticketKappa.pe,
      table: ticketKappa.table, marginals: ticketKappa.marginals,
      bar: `>= ${AGREEMENT_BAR * 100}%`, pass: ticketPass,
    },
    soft_disagreements: { tree: softTree, ticket: softTicket, total: softTree + softTicket },
    judge_failed: { trees: judgeFailedTrees, tickets: judgeFailedTickets },
    dod,
  };
  writeJson(path.join(runDir, 'agreement.json'), report);

  console.log('\nMercury DoD — judge-vs-human agreement');
  console.log('══════════════════════════════════════');
  console.log(`pass_min: ${passMin}  (judge-accept = run-dir verdict PASS; csv judge columns are never trusted)`);
  console.log(`verify:   ${verify.enabled ? (verify.ok ? 'OK' : 'FAILED') : 'DISABLED (--no-verify)'}`);
  for (const v of verify.violations) console.log(`  ✗ ${v}`);
  console.log(`1. hand-to-dev rate:  ${handToDev}/${askIds.length} (${pct(handRatio)})  Wilson95 [${handCI ? pct(handCI.low) : 'n/a'}, ${handCI ? pct(handCI.high) : 'n/a'}]   bar: >= ${HAND_TO_DEV_BAR}/${HELD_OUT_N}   ${handPass ? 'PASS' : 'FAIL'}`);
  console.log(`2. tree agreement:    ${treeMatch}/${treeCount} (${pct(treeAgreement)})  kappa=${treeKappa.kappa ?? 'n/a'}   bar: >= 80%   ${treePass ? 'PASS' : 'FAIL'}${treeAdvisory ? `   [ADVISORY — ${bigAskCount} big ask(s) < ${MIN_BIG_ASKS_FOR_TREE_GATE}; excluded from the DoD verdict]` : ''}`);
  console.log(`3. ticket agreement:  ${tkMatch}/${tkCount} (${pct(ticketAgreement)})  kappa=${ticketKappa.kappa ?? 'n/a'}   bar: >= 80%   ${ticketPass ? 'PASS' : 'FAIL'}`);
  console.log(`soft disagreements (judge FLAG, human y): tree=${softTree} ticket=${softTicket}`);
  if (judgeFailedTrees || judgeFailedTickets) {
    console.log(`judge-failed (excluded from agreement; --rejudge to fill): trees=${judgeFailedTrees} tickets=${judgeFailedTickets}`);
  }
  if (dodMode && dodProblems.length) {
    console.log('\nDoD preconditions UNMET:');
    for (const p of dodProblems) console.log(`  ✗ ${p}`);
  }
  console.log(`\nDoD${dodMode ? '' : ' (advisory — run with --dod for the gated verdict)'}: ${dod}`);
  if (!dodMode && askIds.length < HELD_OUT_N) {
    console.log(`(note: ${askIds.length} ask(s) present; the DoD bars are calibrated for the ${HELD_OUT_N}-ask held-out set)`);
  }
  console.log(`agreement.json written to ${runDir}`);

  if (withheldReasons.length) process.exit(1);
}

main();
