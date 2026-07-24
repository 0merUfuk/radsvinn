// render-sheet.mjs — turn a calibration run into a human review sheet + label csv.
//
//   node render-sheet.mjs --run results/<run> [--unblind] [--force]
//
// BLIND BY DEFAULT: the sheet and labels.csv omit ALL judge output (scores,
// verdicts, justifications, critical improvements) so human labels cannot be
// anchored by the judge. `--unblind` opts out — for comparison AFTER labels
// are locked in, never before. score-agreement.mjs reads judge numbers from
// the RUN DIR artifacts, never from the csv, so blind labeling loses nothing.
//
// An existing labels.csv is NEVER overwritten without `--force` — a filled
// label sheet is irreplaceable human work.
//
// Emits:
//   results/<run>/review-sheet.md  — per ask: the ask text; the skeleton as an
//        approval tree view (milestone grouping, "⟵ after <temp_id>" arrows, type
//        tags, size tiers); the TREE human-label line (label from the tree view
//        alone, BEFORE reading the tickets); per groomed ticket the 5 fields +
//        a ticket human-label line. Judge scores appear only under --unblind.
//   results/<run>/labels.csv       — one level=tree row per ask + one level=ticket
//        row per item; human columns left blank for a human to fill. judge_total
//        and judge_verdict stay EMPTY in blind mode.

import path from 'node:path';
import fs from 'node:fs';
import { loadJson, readText, writeText, parseArgs, safeKey, HARNESS_DIR, MERCURY_ROOT } from './lib.mjs';

function resolveRun(runArg) {
  if (!runArg) { console.error('usage: node render-sheet.mjs --run results/<run> [--unblind] [--force]'); process.exit(2); }
  const cands = [
    path.isAbsolute(runArg) ? runArg : path.resolve(process.cwd(), runArg),
    path.resolve(HARNESS_DIR, runArg),
    path.resolve(MERCURY_ROOT, runArg),
  ];
  for (const dir of cands) {
    if (fs.existsSync(path.join(dir, 'summary.json'))) return dir;
  }
  console.error(`no summary.json under any of:\n  ${cands.join('\n  ')}`);
  process.exit(2);
}

function readOptional(p) {
  return fs.existsSync(p) ? loadJson(p) : null;
}

// csvField quotes a field RFC4180-style when it contains a comma, quote, or
// newline (embedded quotes doubled); csvRow renders one labels.csv line.
function csvField(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function csvRow(fields) {
  return fields.map(csvField).join(',');
}

// renderTree draws the skeleton as an approval tree view.
function renderTree(skeleton) {
  const lines = [];
  if (skeleton.epic) {
    lines.push(`Epic ${skeleton.epic.temp_id}: ${skeleton.epic.summary}`);
    lines.push(`      neden: ${skeleton.epic.why}`);
  } else {
    lines.push('(no epic — standalone ask)');
  }

  const item = (it, indent) => {
    const se = it.size_estimate || {};
    const dep = (it.depends_on && it.depends_on.length)
      ? `  ⟵ after ${it.depends_on.join(', ')}` : '';
    const cost = se.predicted_cost_usd != null ? `$${se.predicted_cost_usd}` : '';
    const tier = se.tier ? `${se.tier}${cost ? '/' + cost : ''}` : cost;
    lines.push(`${indent}[${it.type}] ${it.temp_id} (${it.repo}${tier ? ', ' + tier : ''}) — ${it.one_line_summary}${dep}`);
  };

  const items = skeleton.items || [];
  const milestones = (skeleton.milestones || []).slice().sort((a, b) => a.order - b.order);

  if (milestones.length === 0) {
    for (const it of items) item(it, '  ');
    return lines.join('\n');
  }

  for (const ms of milestones) {
    lines.push('');
    lines.push(`Milestone ${ms.order}: ${ms.name} — ${ms.goal}`);
    const inMs = items.filter((it) => it.milestone_id === ms.milestone_id);
    for (const it of inMs) item(it, '  ');
  }
  const orphan = items.filter((it) => !it.milestone_id);
  if (orphan.length) {
    lines.push('');
    lines.push('(no milestone)');
    for (const it of orphan) item(it, '  ');
  }
  return lines.join('\n');
}

function renderTreeScore(treeScore) {
  if (!treeScore) return '_(no tree score — ask escalated before grading)_';
  const reason = treeScore.verdict_reason ? ` (${treeScore.verdict_reason})` : '';
  if (treeScore.verdict === 'JUDGE_FAILED') {
    return `**Tree score: — → JUDGE_FAILED${reason}**\n\n_(the judge call failed — label the tree anyway; \`--rejudge\` fills the judge side later)_`;
  }
  const lines = [`**Tree score: ${treeScore.total}/100 → ${treeScore.verdict}${reason}**`, ''];
  for (const [dim, sc] of Object.entries(treeScore.by_dimension)) {
    const just = (treeScore.justifications_tr || {})[dim] || '';
    lines.push(`- \`${dim}\`: **${sc}/10** — ${just}`);
  }
  if (treeScore.critical_improvements_tr && treeScore.critical_improvements_tr.length) {
    lines.push('', 'En kritik iyileştirmeler:');
    for (const c of treeScore.critical_improvements_tr) lines.push(`  - ${c}`);
  }
  return lines.join('\n');
}

// asList coerces a field to an array for safe rendering. A groomer can emit a
// schema-violating scalar (e.g. coupling_zones: "none" instead of ["none"]) —
// the Go gate BLOCKs it, but the raw value still lands in plan.json and the
// sheet must render it without crashing (never let a bad ticket break the whole
// sheet). Array → itself; scalar → [scalar]; null/undefined → [].
function asList(x) {
  if (Array.isArray(x)) return x;
  if (x === null || x === undefined) return [];
  return [x];
}

// renderTicket renders one groomed ticket. Pass score=null (blind mode) to
// omit every trace of the judge.
function renderTicket(item, score) {
  const f = item.fields || {};
  const ta = f.technical_analysis || {};
  const lines = [];
  // A verdict_reason means the verdict was FORCED (M3: deterministic precheck
  // hard-fail overrides the LLM total) — surface it next to the verdict.
  const reason = score && score.verdict_reason ? ` (${score.verdict_reason})` : '';
  const header = score
    ? `#### Ticket ${item.temp_id} — ${score.total === null ? '—' : `${score.total}/100`} → ${score.verdict}${reason}`
    : `#### Ticket ${item.temp_id}`;
  lines.push(header);
  lines.push(`- **repo**: ${item.repo}  **type**: ${item.type}  **effort**: ${item.effort_tier} ($${item.predicted_cost_usd})`);
  lines.push('');
  lines.push(`**1. why (Neden?)**  \n${f.why || ''}`);
  lines.push('');
  lines.push('**2. related_links**');
  lines.push(`  - external: ${asList(f.related_links?.external).join(' · ') || '—'}`);
  lines.push(`  - code_anchors: ${asList(f.related_links?.code_anchors).map((a) => '`' + a + '`').join(' · ') || '—'}`);
  lines.push('');
  lines.push(`**3. definition_of_done**  \n${f.definition_of_done || ''}`);
  lines.push('');
  lines.push('**4. technical_analysis**');
  lines.push(`  - prose: ${ta.prose || ''}`);
  lines.push(`  - affected_repos: ${asList(ta.affected_repos).join(', ') || '—'}`);
  lines.push(`  - coupling_zones: ${asList(ta.coupling_zones).join(', ') || '—'}`);
  lines.push(`  - tier1_decomposition: ${ta.tier1_decomposition || '—'}`);
  lines.push(`  - read_only_repos: ${asList(ta.read_only_repos).join(', ') || '—'}`);
  if (ta.inferred_repos_flagged !== undefined) lines.push(`  - inferred_repos_flagged: ${ta.inferred_repos_flagged}`);
  lines.push('');
  lines.push('**5. acceptance_criteria**');
  for (const c of asList(f.acceptance_criteria)) lines.push(`  - ${c}`);
  lines.push('');
  if (score) {
    lines.push('**Judge (per-field):**');
    for (const [k, v] of Object.entries(score.by_field || {})) {
      const just = (score.justifications_tr || {})[k] || '';
      lines.push(`  - \`${k}\`: **${v}/10** — ${just}`);
    }
    if (score.critical_improvements_tr && score.critical_improvements_tr.length) {
      lines.push('', '  En kritik iyileştirmeler:');
      for (const c of score.critical_improvements_tr) lines.push(`    - ${c}`);
    }
    lines.push('');
  }
  lines.push('> **HUMAN LABEL (ticket)** — hand to a developer without edits? human_dev_ready_without_edits(y/n): ______   notes: ____________________');
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runDir = resolveRun(args.run);
  const blind = !args.unblind; // BLIND is the default; --blind is accepted as an explicit no-op
  const summary = loadJson(path.join(runDir, 'summary.json'));

  const labelsPath = path.join(runDir, 'labels.csv');
  if (fs.existsSync(labelsPath) && !args.force) {
    console.error(`REFUSING to overwrite existing ${labelsPath} — it may already carry human labels.`);
    console.error('Re-run with --force to overwrite BOTH review-sheet.md and labels.csv.');
    process.exit(2);
  }

  const md = [];
  const csv = ['ask_id,level,stratum,item_temp_id,judge_total,judge_verdict,human_dev_ready_without_edits(y/n),human_breakdown_good(y/n|na),notes'];

  md.push('# Mercury Calibration — Review Sheet', '');
  md.push(`**Run**: ${summary.run_id}  |  **Mode**: ${summary.dry_run ? 'dry-run' : 'live'}  |  **Labeling**: ${blind ? 'BLIND (judge output hidden)' : 'UNBLINDED'}  |  **Generated**: ${summary.generated_at}`);
  md.push(`**Generator**: ${summary.models.generator} (${summary.efforts.generator})  |  **Judge**: ${summary.models.judge} (${summary.efforts.judge})`, '');
  md.push('> **Labeling protocol**: (1) read the ask; (2) label the TREE from the tree view ALONE — BEFORE reading the groomed tickets below it; (3) label each ticket: would you hand it to a developer WITHOUT EDITS? Then transcribe your calls into `labels.csv` and run `score-agreement.mjs`.', '');
  if (blind) {
    md.push('> **Note**: blind mode — judge scores/verdicts are hidden and the `judge_total`/`judge_verdict` csv columns are left EMPTY so your labels stay uncontaminated (`score-agreement.mjs` reads judge numbers from the run dir, not the csv). After your labels are locked, re-render with `--unblind --force` to compare — but copy your filled labels.csv elsewhere first.', '');
  }
  md.push('---', '');

  for (const askRow of summary.asks) {
    const askId = askRow.ask_id;
    const askDir = path.join(runDir, askId);
    const askText = fs.existsSync(path.join(askDir, 'ask.md')) ? readText(path.join(askDir, 'ask.md')).trim() : '(ask text unavailable)';
    const skeleton = readOptional(path.join(askDir, 'skeleton.json'));
    const treeScore = readOptional(path.join(askDir, 'tree-score.json'));
    const plan = readOptional(path.join(askDir, 'plan.json'));
    const meta = readOptional(path.join(askDir, 'meta.json'));
    const stratum = askRow.stratum || meta?.stratum || '';

    md.push(`## Ask: \`${askId}\`  —  stratum: **${stratum || '?'}**  —  status: **${askRow.status}**`, '');
    md.push('### The ask', '', '> ' + askText.replace(/\n/g, '\n> '), '');

    if (skeleton) {
      md.push('### Break-Down (approval tree view)', '', '```', renderTree(skeleton), '```', '');
    } else {
      md.push('### Break-Down', '', '_(no skeleton — escalated)_', '');
    }

    if (!blind) {
      md.push('### Tree judge', '', renderTreeScore(treeScore), '');
    }
    md.push('> **HUMAN LABEL (tree)** — label from the tree view ALONE, before reading the tickets below. human_breakdown_good(y/n|na): ______   notes: ____________________', '');

    // labels.csv — tree row (judge columns EMPTY in blind mode; run dir is the truth)
    csv.push(csvRow([
      askId, 'tree', stratum, '',
      !blind && treeScore ? treeScore.total : '',
      !blind && treeScore ? treeScore.verdict : '',
      '', '', '',
    ]));

    if (plan && plan.items) {
      md.push('### Groomed tickets', '');
      for (const item of plan.items) {
        const score = readOptional(path.join(askDir, `ticket-score.${safeKey(item.temp_id)}.json`));
        md.push(renderTicket(item, blind ? null : score), '');
        csv.push(csvRow([
          askId, 'ticket', stratum, item.temp_id,
          !blind && score ? score.total : '',
          !blind && score ? score.verdict : '', // a precheck hard-fail arrives here already forced to BLOCK (M3)
          '', 'na', '',
        ]));
      }
    }
    md.push('---', '');
  }

  writeText(path.join(runDir, 'review-sheet.md'), md.join('\n') + '\n');
  writeText(labelsPath, csv.join('\n') + '\n');

  console.log(`review-sheet.md + labels.csv written to ${runDir} (${blind ? 'BLIND' : 'UNBLINDED'})`);
  console.log(`  ${summary.asks.length} ask(s), ${csv.length - 1} label rows`);
}

main();
