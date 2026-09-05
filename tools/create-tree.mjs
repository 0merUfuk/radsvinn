#!/usr/bin/env node
// radsvinn/tools/create-tree.mjs
// -----------------------------------------------------------------------------
// Radsvinn Phase-0 — planner-output (plan.json) -> a Jira ticket tree.
//
// Proves a Radsvinn plan becomes a real Jira ticket tree through the proven
// api.atlassian.com gateway. DEFAULT = dry-run (prints exactly what --live
// would do, ZERO network). --live actually calls the Jira REST v3 API.
//
// Node 20+ (global fetch), no dependencies.
//
// Gateway ops — write set proven LIVE in Phase 0:
//   POST /issue                 create Epic / L0 / Sub-task
//   POST /issueLink             Blocks link (inward=dependent, outward=prerequisite)
//   POST /issue/{key}/comment   verifier comment (ADF body)
//   GET  /project/{PROJECT}?expand=issueTypes   resolve issuetype name->id + subtask id
//   GET  /issue/{key}/transitions + POST  cleanup = transition-to-cancelled (never DELETE)
// Read operations used by duplicate checks and verification. Validate these
// issue fields against your live Jira project before first production use:
//   GET  /search/jql                      --search: JQL duplicate search over the project
//   GET  /issue/{key}                     --verify: read back a created issue by key.
//                                         Also the attach-verification read: --live with
//                                         plan.epic.existing_key set (see epicExistingKey)
//
// Env:
//   RADSVINN_JIRA_TOKEN     required for --live / --cleanup / --search / --verify (scoped SA
//                          token). Falls back to the trimmed contents of
//                          ~/.config/radsvinn/jira-token when env resolves empty/unset,
//                          then ~/.config/mercury/jira-token only if absent. Never
//                          logged, printed, or echoed.
//   RADSVINN_JIRA_CLOUD_ID  REQUIRED for any network op — no default; the tool
//                          dies clearly if unset (your Atlassian Cloud ID).
//   RADSVINN_JIRA_PROJECT   default PROJ
//   RADSVINN_JIRA_SITE_URL  your Jira site (e.g. https://your-domain.atlassian.net);
//                          browse links are ${RADSVINN_JIRA_SITE_URL}/browse/<KEY>.
// -----------------------------------------------------------------------------

import { readEnv } from '../dashboard/lib/env.mjs';
import { readFileSync, writeFileSync, existsSync, mkdirSync, statSync, lstatSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ------------------------------- config --------------------------------------
// No baked-in cloudId: it is the per-site write target and MUST be configured.
// Empty when unset — requireCloudId() below fails clearly before any network op
// (dry-run / --show-adf / --help stay usable without it).
const CLOUD_ID = readEnv('RADSVINN_JIRA_CLOUD_ID') || '';
const PROJECT = readEnv('RADSVINN_JIRA_PROJECT') || 'PROJ';
// Token resolution: resolved nonempty env first; canonical file wins by presence.
// Never logged, printed, or echoed anywhere.
function resolveToken() {
  if (readEnv('RADSVINN_JIRA_TOKEN')) return readEnv('RADSVINN_JIRA_TOKEN');
  for (const brand of ['radsvinn', 'mercury']) { // Legacy path is read-only compatibility fallback.
    const tokenFile = join(homedir(), '.config', brand, 'jira-token');
    try {
      if (!lstatSync(tokenFile, { throwIfNoEntry: false })) continue;
      // Docs promise chmod 600 — warn (to stderr, without the value) if looser.
      if (statSync(tokenFile).mode & 0o077) {
        console.error(`WARN: ${tokenFile} is readable by group/other — run: chmod 600 ${tokenFile}`);
      }
      return readFileSync(tokenFile, 'utf8').trim();
    } catch (err) {
      // A-Info2: never the content, only the path + error — the file may
      // hold the live token, so the failure message must stay content-free.
      console.error(`WARN: could not read ${tokenFile}: ${err.code}`);
      return '';
    }
  }
  return '';
}
const TOKEN = resolveToken();
const SUMMARY_PREFIX = ''; // no tag on titles (product decision: clean summaries)

// A Jira summary should read like a title, not a sentence. Trim to a concise
// title: cut at the first strong break (em-dash / colon / semicolon) when that
// leaves a reasonable title, else truncate at a word boundary (~90 chars).
function conciseTitle(s) {
  let t = String(s || '').trim();
  const brk = t.search(/\s[—–-]\s|:\s|;\s/);
  if (brk > 24 && brk < 90) t = t.slice(0, brk).trim();
  if (t.length > 90) {
    const cut = t.slice(0, 90);
    t = cut.slice(0, cut.lastIndexOf(' ') > 40 ? cut.lastIndexOf(' ') : 90).trim() + '…';
  }
  return t;
}
// Browse links come from RADSVINN_JIRA_SITE_URL (the operator's Jira site); no
// hardcoded site. Example: https://your-domain.atlassian.net → browse base
// https://your-domain.atlassian.net/browse.
const JIRA_SITE_URL = (readEnv('RADSVINN_JIRA_SITE_URL') || 'https://your-domain.atlassian.net').replace(/\/+$/, '');
const BROWSE_BASE = `${JIRA_SITE_URL}/browse`;
// Terminal-transition preference for cleanup: true cancel states first, then
// closed states, then done as a last resort. Transition/status names arrive in
// the SA account's LOCALE (observed live: English + Chinese mix, e.g.
// transition "Closed" → status 已关闭, "完成" → 已完成), so localized variants
// are included. First regex with a match wins.
const CANCEL_RES = [
  /cancel|iptal|reddedil/i,
  /closed|kapat|已关闭|关闭/i,
  /\bdone\b|完成|\btamam\b/i,
];

const GATEWAY = `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3`;
const HERE = dirname(new URL(import.meta.url).pathname);
const RESULTS_DIR = resolve(HERE, '..', 'results'); // gitignored per .gitignore

// ------------------------------- utils ---------------------------------------
function die(msg) {
  console.error(`\nFATAL: ${msg}`);
  process.exit(1);
}
// Every network mode targets the gateway, which is keyed by cloudId. No default
// is baked in, so a network op with an unset RADSVINN_JIRA_CLOUD_ID must fail
// clearly rather than build a malformed gateway URL and 404.
function requireCloudId(mode) {
  if (!CLOUD_ID) {
    die(`RADSVINN_JIRA_CLOUD_ID is unset — required for ${mode}. Set your Atlassian Cloud ID (no default is baked in); find it at https://<your-domain>.atlassian.net/_edgeProxy/tenantInfo`);
  }
}
function readJSON(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    die(`could not read/parse JSON: ${path}\n  ${e.message}`);
  }
}
function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// ------------------------------ arg parsing ----------------------------------
// A-Min3: a value-taking flag whose value looks like another flag (missing,
// or starts with '--') is almost certainly a forgotten value, not a real
// value — e.g. `--cleanup --live` used to silently set cleanup="--live".
const looksLikeFlag = (v) => v === undefined || v.startsWith('--');

function parseArgs(argv) {
  const a = {
    plan: null,
    scope: 'smoke',
    live: false,
    cleanup: null,
    search: null,
    verify: null,
    out: null,
    showAdf: undefined, // undefined = off; '' = default target; '<tid>' = that issue
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    const next = () => argv[++i];
    switch (t) {
      case '--plan':
        if (looksLikeFlag(argv[i + 1])) die('--plan requires a value');
        a.plan = next();
        break;
      case '--scope': a.scope = (next() || 'smoke'); break;
      case '--live': a.live = true; break;
      case '--cleanup':
        if (looksLikeFlag(argv[i + 1])) die('--cleanup requires a value');
        a.cleanup = next();
        break;
      case '--out':
        if (looksLikeFlag(argv[i + 1])) die('--out requires a file path');
        a.out = next();
        break;
      case '--search':
        if (looksLikeFlag(argv[i + 1])) die('--search requires a value');
        a.search = next();
        break;
      case '--verify':
        if (looksLikeFlag(argv[i + 1])) die('--verify requires a value');
        a.verify = next();
        break;
      case '--show-adf': {
        const v = argv[i + 1];
        if (v && !v.startsWith('--')) { a.showAdf = next(); } else { a.showAdf = ''; }
        break;
      }
      case '-h': case '--help': a.help = true; break;
      default: die(`unknown argument: ${t}`);
    }
  }
  if (!['smoke', 'full'].includes(a.scope)) die(`--scope must be smoke|full (got "${a.scope}")`);
  return a;
}

function usage() {
  console.log(`Radsvinn Phase-0 — plan.json -> a Jira tree

Usage:
  node tools/create-tree.mjs --plan <path> [--scope smoke|full] [--live]
  node tools/create-tree.mjs --plan <path> --show-adf [tempId]
  node tools/create-tree.mjs --cleanup <record.json> --live
  node tools/create-tree.mjs --search "<text>"
  node tools/create-tree.mjs --verify <record.json>

Flags:
  --plan <path>        Radsvinn plan.json (item summaries come from sibling skeleton.json).
                       When plan.epic.existing_key is set, the tree ATTACHES under that
                       existing board epic: --live verifies the key (must exist, must be
                       an Epic — dies otherwise) and creates no epic of its own.
  --scope smoke|full   smoke (default) = epic + first Task + first Story + first Sub-task
                       + Blocks links among them + one verifier comment on the Story.
                       full = the whole tree.
  --live               actually call the Jira API. DEFAULT is dry-run (no network).
  --out <path>         (--live only) write the created-record JSON to this exact path
                       instead of the default results/phase0-created-<ts>.json —
                       lets callers (e.g. the planner service) keep records plan-scoped.
  --cleanup <rec>      transition every recorded issue to a cancelled/terminal state
                       (children before parents; never DELETE). Requires --live.
  --search <text>      duplicate search over the project. <text> is ALWAYS treated as a plain
                       search term (JQL metacharacters escaped) and wrapped as project =
                       <PROJECT> AND (summary ~ "<text>" OR text ~ "<text>") ORDER BY created
                       DESC. Raw JQL is deliberately not supported (untrusted-input surface).
                       Requires a token (env or token file).
  --verify <record>    re-read every issue in a --live create record and print its current
                       summary/status/type/parent; exits 1 if any issue fails to read.
                       Requires a token (env or token file).
  --show-adf [tempId]  print the full create request body (incl. ADF description) for
                       one issue and exit (dry, no network). Default target: comment Story.

Env: RADSVINN_JIRA_TOKEN (required for --live/--cleanup/--search/--verify; falls back to
     ~/.config/radsvinn/jira-token when empty/unset; only if absent,
     ~/.config/mercury/jira-token), RADSVINN_JIRA_CLOUD_ID (required, no default),
     RADSVINN_JIRA_PROJECT (default PROJ), RADSVINN_JIRA_SITE_URL (browse links)`);
}

// ------------------------------- ADF builders --------------------------------
// Minimal, correct ADF v3. Text nodes must never be empty.
function txt(s, marks) {
  let str = (s == null) ? '' : String(s);
  if (str.length === 0) str = '—';
  return marks && marks.length ? { type: 'text', text: str, marks } : { type: 'text', text: str };
}
const STRONG = { type: 'strong' };
const EM = { type: 'em' };
const CODE = { type: 'code' };
const linkMark = (href) => ({ type: 'link', attrs: { href } });

const heading = (level, s) => ({ type: 'heading', attrs: { level }, content: [txt(s)] });
const paragraph = (...inline) => ({ type: 'paragraph', content: inline });
const listItem = (inline) => ({ type: 'listItem', content: [{ type: 'paragraph', content: inline }] });
const bulletList = (rows) => ({ type: 'bulletList', content: rows.map(listItem) });
const doc = (content) => ({ type: 'doc', version: 1, content });
// Structural / colour helpers for a scannable, tastefully-styled description.
// panelType ∈ info(blue) | note(purple) | success(green) | warning(yellow) | error(red).
const rule = () => ({ type: 'rule' });
const panel = (panelType, content) => ({ type: 'panel', attrs: { panelType }, content });
// status = a small coloured lozenge. color ∈ neutral|purple|blue|red|yellow|green.
const status = (text, color) => ({ type: 'status', attrs: { text, color, style: '' } });
const EFFORT_COLOR = { low: 'green', medium: 'blue', high: 'yellow', max: 'red' };

// external link may be a URL or free text
function externalInline(e) {
  const s = String(e || '');
  if (/^https?:\/\//i.test(s)) return [txt(s, [linkMark(s)])];
  return [txt(s)];
}

// Prose -> ADF block nodes: a multi-paragraph prose field must not render as
// ONE unbroken ADF paragraph. Structure the groomer is instructed to emit
// survives here:
//   - blank lines split the text into separate paragraphs;
//   - within a block, lines starting with `- ` or `• ` become a bulletList
//     (consecutive bullet lines group into one list);
//   - single newlines within a paragraph become hardBreak nodes, so
//     intentional line structure survives.
// Degrades IDENTICALLY for single-paragraph input (no newline at all →
// exactly the old one-paragraph render, byte-for-byte); whitespace-only
// input keeps the old behavior too (one paragraph, txt() renders '—').
function proseToADF(text) {
  // CRLF-normalize FIRST: every split below keys on bare '\n', so Windows/
  // groomer-emitted '\r\n' would otherwise leak — '\r\n\r\n' never matches
  // the blank-line splitter /\n[ \t]*\n+/ ('\r' is neither space nor tab),
  // collapsing intended paragraphs into one, and the stray '\r' rides into
  // ADF text nodes as an invisible control character.
  const raw = String(text ?? '').replace(/\r\n?/g, '\n');
  if (!raw.includes('\n')) return [paragraph(txt(raw))];

  const nodes = [];
  for (const block of raw.split(/\n[ \t]*\n+/)) {
    // Whitespace-only lines inside a block would render as txt()'s '—'
    // placeholder — drop them (they carry no prose).
    const lines = block.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;
    let para = [];
    let bullets = [];
    const flushPara = () => {
      if (para.length) { nodes.push({ type: 'paragraph', content: para }); para = []; }
    };
    const flushBullets = () => {
      if (bullets.length) { nodes.push(bulletList(bullets.map((b) => [txt(b)]))); bullets = []; }
    };
    for (const line of lines) {
      if (/^\s*[-•]\s+/.test(line)) {
        flushPara();
        bullets.push(line.replace(/^\s*[-•]\s+/, ''));
      } else {
        flushBullets();
        if (para.length) para.push({ type: 'hardBreak' });
        para.push(txt(line));
      }
    }
    flushPara();
    flushBullets();
  }
  // Defensive: input that was ALL whitespace/newlines produced no nodes —
  // fall back to the old single-paragraph render rather than an empty doc
  // fragment (ADF rejects empty content arrays in some containers).
  if (nodes.length === 0) return [paragraph(txt(raw))];
  return nodes;
}

// A routing badge row: coloured status lozenges for at-a-glance metadata.
function routingBadges(item) {
  const ta = (item.fields && item.fields.technical_analysis) || {};
  const repos = ta.affected_repos && ta.affected_repos.length ? ta.affected_repos : [item.repo].filter(Boolean);
  const zones = ta.coupling_zones && ta.coupling_zones.length ? ta.coupling_zones : ['none'];
  const inZone = zones.some((z) => z && z !== 'none');
  const effort = item.effort_tier || '—';
  const badges = [];
  for (const r of repos) { badges.push(status(r, 'blue'), txt(' ')); }
  badges.push(status(`EFFORT · ${String(effort).toUpperCase()}`, EFFORT_COLOR[effort] || 'neutral'), txt(' '));
  badges.push(status(inZone ? `⚠ ZONE · ${zones.join(', ')}` : 'ZONE · none', inZone ? 'red' : 'green'), txt(' '));
  if (ta.tier1_decomposition) badges.push(status(ta.tier1_decomposition, ta.tier1_decomposition === 'needs-human' ? 'purple' : 'neutral'));
  return paragraph(...badges);
}

// Render the 5 planner fields as a scannable, tastefully-styled ADF doc:
// a badge row on top, emoji-anchored sections, subtle panels for the two
// contract sections (DoD = green, Technical Analysis = blue), rule dividers.
// Section LABELS are English (structure); field CONTENT keeps the plan's language.
// Prose fields (why / DoD / TA prose) go through proseToADF so the structure
// the groomer emits (blank-line paragraphs, dash lists) survives to Jira.
function renderItemDescriptionADF(item) {
  const f = item.fields || {};
  const ta = f.technical_analysis || {};
  const rl = f.related_links || {};
  const anchors = rl.code_anchors || [];
  const external = rl.external || [];
  // A-Min2-JS: filter to non-blank entries before rendering — a whitespace-
  // only criterion must not render as an empty bullet.
  const ac = (f.acceptance_criteria || []).filter((c) => (c || '').trim());
  const content = [routingBadges(item), rule()];

  if ((f.why || '').trim()) content.push(heading(3, '🎯 Why'), ...proseToADF(f.why));
  if ((f.definition_of_done || '').trim()) {
    content.push(heading(3, '✅ Definition of Done'), panel('success', proseToADF(f.definition_of_done)));
  }
  // Code anchors render INSIDE the Technical Analysis panel (product
  // decision 2026-07-10): Related Links is the business-attachment surface —
  // external docs/Figma/screenshots/PDFs a business-side PO could upload —
  // while code anchors are engineering grounding and live with the technical
  // analysis. The SCHEMA keeps `related_links.code_anchors` untouched (the
  // deterministic gate's anchor/zone checks and the zero-anchor flag
  // depend on it) — this is a RENDERING move only. The panel renders when
  // either prose or anchors exist, so anchors can never be silently dropped
  // on a (contract-violating) prose-less item.
  if ((ta.prose || '').trim() || anchors.length) {
    const taContent = (ta.prose || '').trim() ? proseToADF(ta.prose) : [];
    if (anchors.length) {
      taContent.push(paragraph(txt('Code anchors', [STRONG])));
      taContent.push(bulletList(anchors.map((anc) => [txt(anc, [CODE])])));
    }
    content.push(heading(3, '🔧 Technical Analysis'), panel('info', taContent));
  }
  if (ac.length) {
    content.push(heading(3, '🧪 Acceptance Criteria'), bulletList(ac.map((c) => [txt(c)])));
  }
  // Related Links = business/external ONLY (see the anchor note above);
  // the whole section is omitted when there are no external links.
  if (external.length) {
    content.push(rule(), heading(3, '🔗 Related Links'));
    content.push(bulletList(external.map((ext) => externalInline(ext))));
  }
  return doc(content);
}

// Epic carries only summary/why — a lean, badge-topped description. The why
// is a prose field like the items' — same proseToADF structuring.
function renderEpicDescriptionADF(epic) {
  const content = [paragraph(status('EPIC', 'purple')), rule()];
  if (epic.why) content.push(heading(3, '🎯 Why'), ...proseToADF(epic.why));
  return doc(content);
}

// Verifier comment from a ticket-score.<tid>.json (judge output).
function renderScoreCommentADF(score) {
  const content = [];
  const total = score.total != null ? score.total : '—';
  const verdict = score.verdict || '—';
  content.push(heading(3, `🤖 Radsvinn ticket-score: ${total}/100 — ${verdict}`));

  const byField = score.by_field || {};
  const just = score.justifications_tr || {};
  const rows = [];
  for (const [field, val] of Object.entries(byField)) {
    const inline = [txt(`${field}: `, [STRONG]), txt(`${val}/10`)];
    const j = just[field];
    if (j) inline.push(txt(` — ${j}`));
    rows.push(inline);
  }
  if (rows.length) content.push(bulletList(rows));
  content.push(paragraph(txt('Planned & scored by Radsvinn.', [EM])));
  return doc(content);
}

// Synthetic comment when no score file sits next to the plan.
function synthCommentADF(tempId) {
  return doc([paragraph(txt(`Planned by Radsvinn (${tempId})`))]);
}

// ------------------------------ gateway --------------------------------------
function authHeaders() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}
async function api(method, path, body) {
  const res = await fetch(GATEWAY + path, {
    method,
    headers: authHeaders(),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status} on ${method} ${path}\n${text.slice(0, 1000)}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }
  return text ? JSON.parse(text) : {};
}

// ------------------------------ summaries ------------------------------------
function loadSkeleton(planPath) {
  const p = join(dirname(planPath), 'skeleton.json');
  if (!existsSync(p)) return { path: p, found: false, map: new Map() };
  const sk = readJSON(p);
  const map = new Map();
  for (const it of (sk.items || [])) {
    if (it.temp_id && it.one_line_summary) map.set(it.temp_id, it.one_line_summary);
  }
  return { path: p, found: true, map };
}
function summaryForItem(item, summaryMap) {
  const s = summaryMap.get(item.temp_id);
  if (s) return conciseTitle(s);
  // Fallback: first sentence of `why`, as a concise title. Skeleton is the source.
  const why = (item.fields && item.fields.why) || item.temp_id;
  const first = String(why).split(/(?<=[.!?])\s/)[0] || String(why);
  return conciseTitle(first);
}

// ------------------------------ selection ------------------------------------
function selectScope(plan, scope) {
  const epic = plan.epic || null;
  const epicTempId = epic ? epic.temp_id : null;
  const items = plan.items || [];
  const isL0 = (it) => it.parent_temp_id === epicTempId || it.parent_temp_id == null;
  const l0All = items.filter(isL0);

  let l0, subtasks, commentTargets;
  if (scope === 'full') {
    l0 = l0All;
    subtasks = items.filter((it) => !isL0(it));
    commentTargets = items.filter((it) => it.type === 'Story');
  } else {
    const firstTask = l0All.find((it) => it.type === 'Task');
    const firstStory = l0All.find((it) => it.type === 'Story');
    // A-M3: a plan whose L0 items are all Feature/Request/Bug/Test (no Task,
    // no Story) used to select nothing. Fall back to the first L0 item of
    // ANY type so smoke scope always has a single L0 to exercise. commentTargets
    // stays governed by firstStory alone — if no Story exists, it is simply
    // empty (fine: there is nothing to attach a verifier comment to).
    const fallbackL0 = (!firstTask && !firstStory) ? l0All[0] : undefined;
    const firstSub = firstStory
      ? items.find((it) => it.parent_temp_id === firstStory.temp_id && it.type === 'Sub-task')
      : undefined;
    l0 = [firstTask, firstStory, fallbackL0].filter(Boolean);
    subtasks = firstSub ? [firstSub] : [];
    commentTargets = firstStory ? [firstStory] : [];
  }

  const createdSet = new Set();
  if (epic) createdSet.add(epic.temp_id);
  for (const it of l0) createdSet.add(it.temp_id);
  for (const it of subtasks) createdSet.add(it.temp_id);

  // Blocks links among created items only. dependent = the item, prerequisite = the dep.
  const links = [];
  const seen = new Set();
  for (const it of [...l0, ...subtasks]) {
    for (const dep of (it.depends_on || [])) {
      if (!createdSet.has(dep)) continue;
      const key = `${it.temp_id}<-${dep}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ dependent: it.temp_id, prerequisite: dep });
    }
  }

  return { epic, l0, subtasks, links, commentTargets, createdSet };
}

// Attach-to-existing-epic: plan.epic.existing_key means "add this tree under an
// epic ALREADY on the board". The decomposer contract has always advertised
// it (prompts/decomposer.md: epic = `{temp_id, summary, why,
// existing_key|null}`), but this tool ignored the field and unconditionally
// POSTed a fresh epic, which could duplicate a byte-identical Epic. A non-empty
// string → ATTACH mode: --live verifies
// the key exists AND is an Epic (dies loudly on any mismatch — a typo'd key
// must never silently become a fresh epic), creates nothing for the epic,
// and maps the epic's temp_id to the existing key so every L0 parents
// under it.
// The legal shape of an existing_key, enforced HERE at the tool boundary
// (security): the raw value lands unencoded in the GET path
// (`/issue/${attachKey}?...`), so an agent-influenced string like
// "PROJ-1/../../whatever?x=" would otherwise steer the request at a different
// gateway endpoint. Deliberately the GENERAL Jira issue-key shape
// (PROJECT-123: uppercase alnum project key starting with a letter, dash,
// digits) rather than a project-pinned `^KEY-[0-9]+$`: this tool honors
// RADSVINN_JIRA_PROJECT, so pinning one project here would break any other
// deployment while adding zero safety — the charset is what keeps the
// path (and the record/Slack renders downstream) inert.
const JIRA_KEY_RE = /^[A-Z][A-Z0-9]*-[0-9]+$/;

function epicExistingKey(plan) {
  const raw = plan && plan.epic && plan.epic.existing_key;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  const key = raw.trim();
  if (!JIRA_KEY_RE.test(key)) {
    // A malformed key must die LOUDLY — never fall back to creating a fresh
    // epic (the duplicate-epic incident's exact failure direction),
    // and never reach the request path raw (see JIRA_KEY_RE above).
    die(`epic.existing_key ${JSON.stringify(key)} is not a legal Jira issue key (expected e.g. PROJ-451) — refusing to proceed`);
  }
  return key;
}

// ------------------------------ body builders --------------------------------
function issueBody({ issuetype, parentKey, summary, description }) {
  const fields = { project: { key: PROJECT }, issuetype, summary, description };
  if (parentKey) fields.parent = { key: parentKey };
  return { fields };
}
function epicBody(epic) {
  return issueBody({
    issuetype: { name: 'Epic' },
    parentKey: null,
    summary: conciseTitle(epic.summary),
    description: renderEpicDescriptionADF(epic),
  });
}
function l0Body(item, epicKey, summaryMap) {
  return issueBody({
    issuetype: { name: item.type },
    parentKey: epicKey,
    summary: SUMMARY_PREFIX + summaryForItem(item, summaryMap),
    description: renderItemDescriptionADF(item),
  });
}
function subtaskBody(item, parentKey, subtaskId, summaryMap) {
  return issueBody({
    issuetype: { id: subtaskId },
    parentKey,
    summary: SUMMARY_PREFIX + summaryForItem(item, summaryMap),
    description: renderItemDescriptionADF(item),
  });
}

// ------------------------------ dry-run print --------------------------------
function itemSectionLabels(item) {
  const f = item.fields || {};
  const ta = f.technical_analysis || {};
  const rl = f.related_links || {};
  const out = [];
  if (f.why) out.push('Why');
  if (f.definition_of_done) out.push('Definition of Done');
  // Mirrors renderItemDescriptionADF: anchors render inside the TA panel
  // (2026-07-10), and Related Links carries EXTERNAL links only.
  const anchorCount = (rl.code_anchors || []).length;
  if (ta.prose || anchorCount) out.push(`Technical Analysis${anchorCount ? `(+${anchorCount} anchors)` : ''}`);
  const ac = f.acceptance_criteria || [];
  if (ac.length) out.push(`Acceptance Criteria(${ac.length})`);
  const n = (rl.external || []).length;
  if (n) out.push(`Related Links(${n})`);
  out.push('routing');
  return out;
}
function clip(s, n = 92) {
  s = String(s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
function typeOf(sel, tempId) {
  if (sel.epic && sel.epic.temp_id === tempId) return 'Epic';
  const it = [...sel.l0, ...sel.subtasks].find((x) => x.temp_id === tempId);
  return it ? it.type : '?';
}

function printDryRun(plan, sel, skel, opts, planPath) {
  const planDir = dirname(planPath);
  // Attach mode (existing_key): the epic is NOT created, so it is excluded
  // from the create count and printed as an attach line instead.
  const attachKey = epicExistingKey(plan);
  const n = (sel.epic && !attachKey ? 1 : 0) + sel.l0.length + sel.subtasks.length;

  console.log('Radsvinn Phase-0 · planner-output → Jira tree');
  console.log(`mode: DRY-RUN (no network)   scope: ${opts.scope}`);
  console.log(`plan:     ${planPath}`);
  console.log(`skeleton: ${skel.path} ${skel.found ? '(summaries)' : '(MISSING — summaries fall back to why)'}`);
  console.log(`gateway:  ${GATEWAY}`);
  console.log(`project:  ${PROJECT}   cloudId: ${CLOUD_ID || '(unset — required for --live; set RADSVINN_JIRA_CLOUD_ID)'}`);
  console.log('');

  console.log(`ISSUES TO CREATE (${n})`);
  if (sel.epic && attachKey) {
    console.log(`  EPIC: attach to existing ${attachKey} (no create) — ${sel.epic.temp_id} maps to ${attachKey}; every L0 below parents under it`);
  } else if (sel.epic) {
    console.log(`  [Epic]      ${sel.epic.temp_id.padEnd(4)} parent: —            issuetype:{name:"Epic"}`);
    console.log(`       summary: ${clip(conciseTitle(sel.epic.summary))}`);
    console.log(`       desc:    Why, routing`);
  }
  const epicRef = sel.epic ? (attachKey ? `${attachKey} (attached)` : `${sel.epic.temp_id} (Epic)`) : '—';
  for (const it of sel.l0) {
    console.log(`  [${it.type}]${' '.repeat(Math.max(1, 10 - it.type.length))}${it.temp_id.padEnd(4)} parent: ${epicRef.padEnd(12)} issuetype:{name:"${it.type}"}`);
    console.log(`       summary: ${SUMMARY_PREFIX}${clip(summaryForItem(it, skel.map))}`);
    console.log(`       desc:    ${itemSectionLabels(it).join(', ')}`);
  }
  for (const it of sel.subtasks) {
    const pType = typeOf(sel, it.parent_temp_id);
    console.log(`  [Sub-task]  ${it.temp_id.padEnd(4)} parent: ${(`${it.parent_temp_id} (${pType})`).padEnd(12)} issuetype:{id:<subtask-type-id @live>}`);
    console.log(`       summary: ${SUMMARY_PREFIX}${clip(summaryForItem(it, skel.map))}`);
    console.log(`       desc:    ${itemSectionLabels(it).join(', ')}`);
  }
  console.log('');

  console.log(`BLOCKS LINKS (${sel.links.length})   POST /issueLink  type:{name:"Blocks"}`);
  if (sel.links.length === 0) console.log('  (none among the selected issues)');
  for (const l of sel.links) {
    console.log(`  ${l.prerequisite} blocks ${l.dependent}   inwardIssue: ${l.dependent} (dependent) · outwardIssue: ${l.prerequisite} (prerequisite)`);
    console.log(`       (${l.dependent} depends_on ${l.prerequisite})`);
  }
  console.log('');

  console.log(`VERIFIER COMMENT (${sel.commentTargets.length})   POST /issue/{story}/comment`);
  for (const st of sel.commentTargets) {
    const scorePath = join(planDir, `ticket-score.${st.temp_id}.json`);
    if (existsSync(scorePath)) {
      const sc = readJSON(scorePath);
      const nf = Object.keys(sc.by_field || {}).length;
      console.log(`  target: ${st.temp_id} (Story)   source: ticket-score.${st.temp_id}.json → ${sc.total}/100 ${sc.verdict} (${nf} fields)`);
    } else {
      console.log(`  target: ${st.temp_id} (Story)   source: synthetic ("🤖 Radsvinn planned this ticket …")`);
    }
  }
  console.log('');

  console.log('--live would additionally:');
  if (attachKey) {
    console.log(`  · GET /issue/${attachKey} FIRST to verify it exists and is an Epic — dies loudly otherwise, before any write`);
  }
  console.log('  · GET /project/' + PROJECT + '?expand=issueTypes to resolve issuetype ids (subtask id)');
  console.log(`  · write record → results/phase0-created-<ts>.json (gitignored) for cleanup`);
  console.log(`  · print browse URLs: ${BROWSE_BASE}/<key>`);
  if (opts.cleanup) {
    console.log('');
    printCleanupDry(opts.cleanup);
  }
  console.log('\nNo network calls were made.');
}

function printCleanupDry(recordPath) {
  console.log(`CLEANUP DRY-RUN — record: ${recordPath}`);
  if (!existsSync(recordPath)) {
    console.log('  (record not found — nothing to cancel)');
    return;
  }
  const rec = readJSON(recordPath);
  const order = cancelOrder(rec.created || []);
  console.log(`  would transition ${order.length} issue(s) to a terminal state (children → parents), never DELETE:`);
  for (const c of order) {
    console.log(`    ${c.key} [${c.type}]  GET /issue/${c.key}/transitions → pick first cancel|closed|done match (prioritized, locale-aware) → POST transition`);
  }
  // attached_epic sits OUTSIDE created[] by design (see buildRecord in
  // runLive): the sweep above derives from created[] only, so an epic
  // Radsvinn did not create is structurally excluded — surfaced here so the
  // dry-run listing says so out loud.
  if (rec.attached_epic && rec.attached_epic.key) {
    console.log(`  (attached epic ${rec.attached_epic.key} is NOT swept — Radsvinn did not create it)`);
  }
}

// ------------------------------ show-adf -------------------------------------
function showAdf(plan, sel, skel, target) {
  // default target = the (first) comment Story, else first L0, else epic.
  let tid = target;
  if (!tid) {
    tid = (sel.commentTargets[0] && sel.commentTargets[0].temp_id)
      || (sel.l0[0] && sel.l0[0].temp_id)
      || (sel.epic && sel.epic.temp_id);
  }
  if (!tid) die('nothing to show');

  // Attach mode labeling: an attached epic has NO create request body, and
  // L0 bodies show the real existing key as parent (known statically).
  const attachKey = epicExistingKey(plan);

  let body, kind;
  if (sel.epic && sel.epic.temp_id === tid) {
    if (attachKey) {
      console.log(`# ${tid} (Epic) ATTACHES to existing ${attachKey} — no create request body (epic.existing_key set; --live verifies the key and parents every L0 under it)`);
      return;
    }
    body = epicBody(sel.epic); kind = 'Epic';
  } else {
    const it = [...sel.l0, ...sel.subtasks].find((x) => x.temp_id === tid);
    if (!it) die(`temp_id "${tid}" is not in the selected ${'' + '' }scope (try --scope full or another id)`);
    if (it.type === 'Sub-task') { body = subtaskBody(it, `${it.parent_temp_id}@live`, '<subtask-type-id @live>', skel.map); kind = 'Sub-task'; }
    else { body = l0Body(it, sel.epic ? (attachKey || `${sel.epic.temp_id}@live`) : '@live', skel.map); kind = it.type; }
  }
  console.log(`# ADF create request body for ${tid} (${kind}) — dry, no network`);
  console.log(`# POST ${GATEWAY}/issue`);
  console.log(JSON.stringify(body, null, 2));
}

// ------------------------------ live create ----------------------------------
function cancelOrder(created) {
  // children before parents: Sub-task (0) → L0 (1) → Epic (2)
  // NOTE (attach mode, 2026-07-10): this receives rec.created ONLY. An
  // attached epic (rec.attached_epic — a pre-existing board epic Radsvinn
  // merely parented new items under) is deliberately NOT in created[], so
  // no cleanup/cancel sweep can ever transition an epic Radsvinn did not
  // create — the existing cancel-order logic is safe unchanged. Do not
  // "fix" a sweep to include it.
  const rank = (t) => (t === 'Sub-task' ? 0 : t === 'Epic' ? 2 : 1);
  return [...created].sort((a, b) => rank(a.type) - rank(b.type));
}

// Pick the most cancel-like available transition: first CANCEL_RES regex with a
// match wins (transition name OR target-status name, trimmed — some boards have
// a leading-space " On Hold" in the wild).
function findCancelTransition(list) {
  for (const re of CANCEL_RES) {
    const match = list.find((t) => re.test((t.name || '').trim()) || re.test(((t.to && t.to.name) || '').trim()));
    if (match) return match;
  }
  return null;
}

async function runLive(plan, sel, skel, opts, planPath) {
  // --out: caller-scoped record path (e.g. the planner service passes a
  // per-plan path so concurrent creates can never misattribute records);
  // default stays the timestamped results/ file.
  const recordPath = opts.out ? resolve(opts.out) : join(RESULTS_DIR, `phase0-created-${nowStamp()}.json`);

  // Refuse to overwrite an existing record that may be a real tree's ONLY
  // cleanup handle — the WAL init below would otherwise destroy it on any
  // direct CLI invocation aimed at an existing non-empty record. The
  // service path is already covered by engine.mjs's guardExistingRecord
  // (throws before this process is even spawned, same semantics); this
  // guard protects direct `--live --out` calls. The interactive no-`--out`
  // path uses timestamped unique names, so the check is a no-op there.
  // Deliberately FIRST — before the token check and any network — so an
  // operator hits this guard even with no token configured. The one safe
  // case to overwrite: a record that parses clean with created:[] (zero
  // ACKNOWLEDGED writes — see the WAL-init note below for the residue).
  if (existsSync(recordPath)) {
    let existing;
    try { existing = JSON.parse(readFileSync(recordPath, 'utf8')); } catch { existing = undefined; }
    const existingCreated = existing != null && Array.isArray(existing.created) ? existing.created : null;
    if (existingCreated === null || existingCreated.length > 0) {
      const what = existingCreated === null
        ? 'is unreadable (unparseable, or no created[] list)'
        : `holds ${existingCreated.length} recorded issue(s)`;
      die(`record already exists at ${recordPath} and ${what} — refusing to overwrite the cleanup handle; run: node tools/create-tree.mjs --cleanup ${recordPath} --live first, or move the file aside`);
    }
    // clean-empty ({created:[]}) — a previous attempt died before its first
    // acknowledged write; safe to overwrite and proceed.
  }

  if (!TOKEN) die('RADSVINN_JIRA_TOKEN is unset — required for --live');
  requireCloudId('--live');
  const planDir = dirname(planPath);

  console.log('Radsvinn Phase-0 · LIVE create');
  console.log(`scope: ${opts.scope}   project: ${PROJECT}   cloudId: ${CLOUD_ID}`);

  // 0. attach-to-existing-epic verification (see epicExistingKey) — FIRST,
  // before the WAL init and before ANY write, so a typo'd key dies with
  // zero side effects. It must never silently fall back to creating a
  // fresh epic — that is exactly the live duplicate-epic incident.
  const attachKey = sel.epic ? epicExistingKey(plan) : null;
  let attachedEpic = null;
  if (attachKey) {
    let existing;
    try {
      existing = await api('GET', `/issue/${attachKey}?fields=summary,issuetype`);
    } catch (err) {
      die(`plan.epic.existing_key = "${attachKey}" could not be read (${String(err.message).split('\n')[0]}) — refusing to create anything: a typo'd key must never silently become a fresh epic. Fix the key (or set existing_key to null to create a new epic) and re-run.`);
    }
    const typeName = ((existing.fields || {}).issuetype || {}).name;
    if (typeName !== 'Epic') {
      die(`plan.epic.existing_key = "${attachKey}" exists but its issuetype is "${typeName || '?'}", not Epic — refusing to parent the tree under it. Fix the key and re-run.`);
    }
    attachedEpic = { temp_id: sel.epic.temp_id, key: attachKey, summary: (existing.fields || {}).summary || '' };
    console.log(`  ↷ Epic     ${attachKey}  (${sel.epic.temp_id}) — attaching to existing, NOT creating`);
    // The service-path advisory dup-search is engine-side and untouched;
    // here the point is moot by construction: attaching, not creating.
    console.log('  · duplicate-search is moot for the epic: attaching, not creating');
  }

  // 1. resolve issue types
  const project = await api('GET', `/project/${PROJECT}?expand=issueTypes`);
  let subtaskId = null;
  for (const it of (project.issueTypes || [])) {
    if (it.subtask === true) { subtaskId = it.id; break; }
  }
  if (sel.subtasks.length && !subtaskId) die(`no sub-task issue type found in project ${PROJECT}`);

  const tempToKey = new Map();
  const created = [];
  const links = [];
  // WRITE-AHEAD record (recordPath resolved at the top of this function,
  // before the existing-record guard). The record must reflect every ACKNOWLEDGED
  // Jira write AT ALL TIMES, because the planner service's retry guard
  // (service/server.mjs, retry write guard) uses its existence/content to decide whether
  // re-creating is safe — and this process can be SIGKILLed at any moment
  // (the service's create timeout kills without giving us a chance to run
  // any handler). So writeRecord() runs once at the top of the try (before
  // the first POST) and again after EVERY acknowledged write below, not
  // just in the catch / at success. Plain writeFileSync is deliberate: a
  // SIGKILL mid-write can leave a truncated file, which parses as garbage —
  // and the retry guard fails CLOSED on unparseable records, which is the
  // safe direction.
  // attached_epic sits OUTSIDE created[] on purpose: cleanup/cancel sweep
  // cancelOrder(rec.created) and must NEVER transition an epic Radsvinn did
  // not create — excluding it here keeps the existing cancel logic safe
  // unchanged, while --verify still reads the key back (labeled [attached]).
  const buildRecord = () => ({
    cloudId: CLOUD_ID,
    project: PROJECT,
    created,
    links,
    ...(attachedEpic ? { attached_epic: attachedEpic } : {}),
    ts: new Date().toISOString(),
  });
  const writeRecord = () => {
    mkdirSync(dirname(recordPath), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(buildRecord(), null, 2));
  };

  try {
    // WAL init — an empty record proving "a --live create started". A
    // SIGKILL landing before the first acknowledged POST leaves this
    // clean-empty record behind, which the retry guard correctly treats as
    // proof of zero ACKNOWLEDGED writes (retryable fall-through). Not proof
    // of zero writes, full stop: a POST that committed server-side but
    // whose response never arrived is invisible to this journal — the
    // documented irreducible residue.
    writeRecord();

    // 2. epic — attach (map temp_id → the existing, verified key so every
    // L0 below parents under it; the WAL init above already journaled the
    // attachment via attached_epic) or create.
    if (sel.epic && attachedEpic) {
      tempToKey.set(sel.epic.temp_id, attachedEpic.key);
    } else if (sel.epic) {
      const res = await api('POST', '/issue', epicBody(sel.epic));
      tempToKey.set(sel.epic.temp_id, res.key);
      created.push({ temp_id: sel.epic.temp_id, key: res.key, type: 'Epic', summary: conciseTitle(sel.epic.summary) });
      writeRecord(); // WAL: journal every acknowledged write immediately
      console.log(`  ✓ Epic     ${res.key}  (${sel.epic.temp_id})`);
    }
    const epicKey = sel.epic ? tempToKey.get(sel.epic.temp_id) : null;

    // 3. L0 items
    for (const it of sel.l0) {
      const res = await api('POST', '/issue', l0Body(it, epicKey, skel.map));
      tempToKey.set(it.temp_id, res.key);
      created.push({ temp_id: it.temp_id, key: res.key, type: it.type, summary: SUMMARY_PREFIX + summaryForItem(it, skel.map) });
      writeRecord(); // WAL
      console.log(`  ✓ ${it.type.padEnd(8)} ${res.key}  (${it.temp_id})`);
    }

    // 4. sub-tasks
    for (const it of sel.subtasks) {
      const parentKey = tempToKey.get(it.parent_temp_id);
      if (!parentKey) throw new Error(`sub-task ${it.temp_id}: parent ${it.parent_temp_id} was not created`);
      const res = await api('POST', '/issue', subtaskBody(it, parentKey, subtaskId, skel.map));
      tempToKey.set(it.temp_id, res.key);
      created.push({ temp_id: it.temp_id, key: res.key, type: 'Sub-task', summary: SUMMARY_PREFIX + summaryForItem(it, skel.map) });
      writeRecord(); // WAL
      console.log(`  ✓ Sub-task ${res.key}  (${it.temp_id})`);
    }

    // 5. Blocks links
    for (const l of sel.links) {
      const inwardKey = tempToKey.get(l.dependent);
      const outwardKey = tempToKey.get(l.prerequisite);
      await api('POST', '/issueLink', {
        type: { name: 'Blocks' },
        inwardIssue: { key: inwardKey },
        outwardIssue: { key: outwardKey },
      });
      links.push({ blocks: `${outwardKey} blocks ${inwardKey}`, inwardIssue: inwardKey, outwardIssue: outwardKey });
      writeRecord(); // WAL
      console.log(`  ✓ Link     ${outwardKey} blocks ${inwardKey}`);
    }

    // 6. verifier comment(s)
    for (const st of sel.commentTargets) {
      const key = tempToKey.get(st.temp_id);
      if (!key) continue;
      const scorePath = join(planDir, `ticket-score.${st.temp_id}.json`);
      const body = existsSync(scorePath) ? renderScoreCommentADF(readJSON(scorePath)) : synthCommentADF(st.temp_id);
      await api('POST', `/issue/${key}/comment`, { body });
      console.log(`  ✓ Comment  on ${key} (${st.temp_id})`);
    }
  } catch (err) {
    // With the write-ahead journaling above, this writeRecord() mostly
    // re-persists truth already on disk — kept because it is the path that
    // prints the cleanup command, and it still freshens `ts`.
    // A-Min1: writeRecord() itself can throw (disk full, permission denied,
    // etc.) — an unguarded call here would crash before the created Jira
    // keys are ever surfaced, orphaning them with no record to clean up.
    try {
      writeRecord();
      console.error('\nCREATE FAILED — stopping to avoid orphaning a half-tree.');
      console.error(err.message);
      console.error(`\nPartial tree recorded → ${recordPath}`);
      console.error(`Clean it up with:  node tools/create-tree.mjs --cleanup ${recordPath} --live`);
    } catch (writeErr) {
      console.error('\nCREATE FAILED — stopping to avoid orphaning a half-tree.');
      console.error(err.message);
      console.error(`\nFATAL: could not write the partial-tree record to ${recordPath} — ${writeErr.message}`);
      console.error('Printing the record below so the created Jira keys are not lost:');
      console.log(JSON.stringify(buildRecord(), null, 2));
    }
    process.exit(1);
  }

  // 7. record + browse urls
  writeRecord();
  console.log(`\nRecord → ${recordPath}`);
  if (attachedEpic) console.log(`Attached:  ${attachedEpic.key.padEnd(10)} Epic     ${BROWSE_BASE}/${attachedEpic.key} (pre-existing — cleanup never touches it)`);
  console.log('Created:');
  for (const c of created) console.log(`  ${c.key.padEnd(10)} ${c.type.padEnd(8)} ${BROWSE_BASE}/${c.key}`);
  console.log(`\nCleanup:  node tools/create-tree.mjs --cleanup ${recordPath} --live`);
}

// ------------------------------ cleanup --------------------------------------
async function runCleanup(recordPath, live) {
  if (!existsSync(recordPath)) die(`cleanup record not found: ${recordPath}`);
  const rec = readJSON(recordPath);
  const order = cancelOrder(rec.created || []);

  if (!live) {
    printCleanupDry(recordPath);
    console.log('\n(dry-run — pass --live to actually transition. No network calls were made.)');
    return;
  }
  if (!TOKEN) die('RADSVINN_JIRA_TOKEN is unset — required for --cleanup --live');
  requireCloudId('--cleanup --live');

  console.log(`Radsvinn Phase-0 · cleanup (transition-to-cancelled, never DELETE)`);
  console.log(`record: ${recordPath}   issues: ${order.length}`);
  // See cancelOrder's note: an attached epic is structurally outside the
  // sweep (created[] only) — say so out loud in the live output too.
  if (rec.attached_epic && rec.attached_epic.key) {
    console.log(`  (attached epic ${rec.attached_epic.key} excluded — Radsvinn did not create it; never transitioned)`);
  }
  // HARD failures only: a transitions-read error (⚠ below) or a
  // transition-POST failure (✗ below) — network down, revoked token,
  // board-wide 429; issues the sweep tried and could NOT act on. The
  // "no cancel/terminal transition matched" skip further down is
  // deliberately NOT counted: an issue already in a terminal state
  // typically offers no matching transition, and that benign exit-0 skip
  // is exactly what keeps re-running cleanup over already-cancelled
  // issues idempotent (the Slack re-click recovery depends on it).
  let hardFailures = 0;
  for (const c of order) {
    let trs;
    try {
      trs = await api('GET', `/issue/${c.key}/transitions`);
    } catch (err) {
      hardFailures += 1;
      console.error(`  ⚠ ${c.key}: could not read transitions — ${err.message}`);
      continue;
    }
    const list = trs.transitions || [];
    const match = findCancelTransition(list);
    if (!match) {
      console.log(`  ⚠ ${c.key} [${c.type}]: no cancel/terminal transition matched. Available:`);
      for (const t of list) console.log(`       id=${t.id}  name="${t.name}"  → ${t.to && t.to.name}`);
      continue;
    }
    try {
      await api('POST', `/issue/${c.key}/transitions`, { transition: { id: match.id } });
      console.log(`  ✓ ${c.key} [${c.type}] → "${match.to ? match.to.name : match.name}" (transition ${match.id})`);
    } catch (err) {
      hardFailures += 1;
      console.error(`  ✗ ${c.key}: transition failed — ${err.message}`);
    }
  }
  if (hardFailures > 0) {
    console.error(`\n${hardFailures} issue(s) failed hard during cleanup — re-run cleanup for the remainder or handle manually.`);
    // process.exitCode, NOT process.exit(): let the per-issue lines above
    // flush before the process ends (exit() can truncate piped stdio
    // mid-write). Exit 0 now truthfully means "the sweep ran with zero
    // hard failures" — the planner service's engine.cleanup keys ok:false
    // off this, so a network-down/revoked-token sweep can never land a
    // plan in a false `cancelled`.
    process.exitCode = 1;
  }
}

// ------------------------------ search / verify -------------------------------
// Standalone duplicate search over the project. No --plan needed.
async function runSearch(text) {
  if (!TOKEN) die('RADSVINN_JIRA_TOKEN is unset — required for --search');
  requireCloudId('--search');
  // The search term can originate in untrusted ask content (jira-planner.md
  // §Gate Integrity), so it is ALWAYS treated as a plain term: control chars
  // stripped, JQL string-literal metacharacters escaped (\ first, then "),
  // and the query always constrained to the project. No raw-JQL mode.
  // Unicode note (2026-07-10, the Turkish dup-search fix): the service's
  // searchTerms() now emits Unicode-letter terms ("özel"/"müşteri" survive).
  // This escaper is Unicode-clean by construction — it strips CONTROL chars
  // only and escapes backslash/quote; \p{L} letters pass through untouched,
  // and encodeURIComponent below percent-encodes them for the request URL.
  const term = String(text)
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .trim();
  if (!term) die('--search requires a non-empty search term');
  const jql = `project = ${PROJECT} AND (summary ~ "${term}" OR text ~ "${term}") ORDER BY created DESC`;

  console.log('Radsvinn Phase-0 · duplicate search');
  console.log(`project: ${PROJECT}   jql: ${jql}`);
  console.log('');

  const res = await api('GET', `/search/jql?jql=${encodeURIComponent(jql)}&maxResults=15&fields=summary,status,issuetype,parent`);
  const issues = res.issues || [];
  if (issues.length === 0) {
    console.log('no matches');
    return;
  }
  for (const it of issues) {
    const f = it.fields || {};
    const type = (f.issuetype && f.issuetype.name) || '?';
    const stat = (f.status && f.status.name) || '?';
    console.log(`${it.key.padEnd(10)} ${type.padEnd(10)} ${stat.padEnd(14)} ${f.summary || ''}`);
  }
  console.log(`\n${issues.length} match(es)`);
}

// Standalone post-create verification. Re-reads every issue in a --live record. No --plan needed.
async function runVerify(recordPath) {
  if (!TOKEN) die('RADSVINN_JIRA_TOKEN is unset — required for --verify');
  requireCloudId('--verify');
  if (!existsSync(recordPath)) die(`verify record not found: ${recordPath}`);
  const rec = readJSON(recordPath);
  const created = rec.created || [];
  // The attached epic (attach mode) is read back too — a readable parent is
  // part of the post-create contract — but labeled [attached]: Radsvinn did
  // not create it, and cleanup deliberately never touches it.
  const attached = rec.attached_epic && rec.attached_epic.key ? rec.attached_epic : null;

  console.log(`Radsvinn Phase-0 · verify — record: ${recordPath}   issues: ${created.length}${attached ? ' (+1 attached epic)' : ''}`);
  if (created.length === 0 && !attached) {
    console.log('  (record has no created issues — nothing to verify)');
    return;
  }
  let anyFail = false;
  for (const c of created) {
    try {
      const res = await api('GET', `/issue/${c.key}?fields=summary,status,issuetype,parent`);
      const f = res.fields || {};
      const type = (f.issuetype && f.issuetype.name) || c.type || '?';
      const stat = (f.status && f.status.name) || '?';
      const parentKey = (f.parent && f.parent.key) || '—';
      console.log(`  ✓ ${c.key} [${type}] status="${stat}" parent=${parentKey} ${f.summary || ''}`);
    } catch (err) {
      anyFail = true;
      console.log(`  ✗ ${c.key}: ${err.message}`);
    }
  }
  if (attached) {
    try {
      const res = await api('GET', `/issue/${attached.key}?fields=summary,status,issuetype,parent`);
      const f = res.fields || {};
      const stat = (f.status && f.status.name) || '?';
      console.log(`  ✓ ${attached.key} [attached] status="${stat}" ${f.summary || ''}`);
    } catch (err) {
      anyFail = true;
      console.log(`  ✗ ${attached.key} [attached]: ${err.message}`);
    }
  }
  if (anyFail) process.exit(1);
}

// ------------------------------- main ----------------------------------------
async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { usage(); return; }

  // cleanup mode is standalone (needs a record, not a plan)
  if (opts.cleanup) {
    await runCleanup(opts.cleanup, opts.live);
    return;
  }

  // search mode is standalone (duplicate search, no plan needed)
  if (opts.search) {
    await runSearch(opts.search);
    return;
  }

  // verify mode is standalone (re-reads a --live create record, no plan needed)
  if (opts.verify) {
    await runVerify(opts.verify);
    return;
  }

  if (!opts.plan) { usage(); die('--plan <path> is required'); }
  const planPath = resolve(opts.plan);
  if (!existsSync(planPath)) die(`plan not found: ${planPath}`);
  const plan = readJSON(planPath);
  const skel = loadSkeleton(planPath);
  const sel = selectScope(plan, opts.scope);

  if (opts.showAdf !== undefined) { showAdf(plan, sel, skel, opts.showAdf); return; }

  if (opts.live) {
    await runLive(plan, sel, skel, opts, planPath);
  } else {
    printDryRun(plan, sel, skel, opts, planPath);
  }
}

main().catch((e) => die(e && e.stack ? e.stack : String(e)));
