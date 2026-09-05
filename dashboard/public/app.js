// Radsvinn dashboard — client renderer (progressive enhancement over the BFF).
// XSS discipline: every plan-derived string becomes a TEXT NODE via el();
// NO innerHTML/insertAdjacentHTML/outerHTML anywhere in this file (CI-guarded).
// All data comes from the same-origin /api/* surface; the BFF holds the planner
// token and never exposes it, the planner URL, or raw planner errors.
'use strict';

let CSRF = '';
let ME = { login: '…', roles: [] };

// ---------------------------------------------------------------- helpers
function el(tag, attrs, ...kids) {
  const n = document.createElement(tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    n.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return n;
}
async function api(path, opts = {}) {
  const res = await fetch(path, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(opts.method === 'POST' ? { 'X-Mercury-CSRF': CSRF } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401 && !opts.noAuthRedirect) {
    // The session expired or never existed — restart the OAuth round-trip,
    // returning to wherever we are now (server validates return_to same-origin).
    location.href = `/auth/login?return_to=${encodeURIComponent(location.pathname + location.search)}`;
    return { status: 401, body: {} };
  }
  let body; try { body = await res.json(); } catch { body = {}; }
  return { status: res.status, body };
}
const id8 = (id) => String(id || '').slice(0, 8);
const usd = (v) => (typeof v === 'number' ? `$${v.toFixed(2)}` : '—');
function ago(iso) {
  if (!iso) return '—';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return `${Math.max(1, Math.round(s))}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}
function announce(msg) { const r = document.getElementById('live'); if (r) r.textContent = msg; }

// ---------------------------------------------------------------- status vocabulary
const STATUS = {
  breaking_down: { g: '◐', label: 'BREAKING DOWN', cls: 'st-working' },
  shape_ready: { g: '◆', label: 'GATE · SHAPE REVIEW', cls: 'st-gate' },
  grooming: { g: '◐', label: 'GROOMING', cls: 'st-working' },
  plan_ready: { g: '◆', label: 'GATE · TICKET REVIEW', cls: 'st-gate' },
  creating: { g: '◐', label: 'CREATING — WRITING TO JIRA', cls: 'st-working' },
  created: { g: '●', label: 'CREATED', cls: 'st-done' },
  rejected: { g: '⊘', label: 'REJECTED', cls: 'st-quiet' },
  failed: { g: '✕', label: 'FAILED', cls: 'st-failed' },
  budget_blocked: { g: '⊗', label: 'BUDGET BLOCKED', cls: 'st-blocked' },
  cancelling: { g: '⟲', label: 'CANCELLING', cls: 'st-working' },
  cancelled: { g: '▤', label: 'CANCELLED', cls: 'st-override' },
};
function stChip(status) {
  const m = STATUS[status] || { g: '?', label: status, cls: 'st-quiet' };
  return el('span', { class: `st ${m.cls}` }, el('span', { class: 'g', 'aria-hidden': 'true' }, m.g), m.label);
}
const GATE_SET = new Set(['shape_ready', 'plan_ready']);
const WORKING_SET = new Set(['breaking_down', 'grooming', 'creating', 'cancelling']);
const BLOCKED_SET = new Set(['failed', 'budget_blocked']);

// ---------------------------------------------------------------- shell
async function bootShell() {
  const s = await api('/api/session');
  CSRF = s.body.csrf; ME = s.body;
  const top = ME.roles.includes('creator') ? 'creator' : ME.roles.includes('approver') ? 'approver'
    : ME.roles.includes('planner') ? 'planner' : 'viewer';
  document.getElementById('role-pill').textContent = `${top} · ${ME.login}`;
  const path = location.pathname;
  for (const a of document.querySelectorAll('[data-nav]')) {
    const target = a.dataset.nav;
    if (path === target || (target === '/plans' && (path === '/' || /^\/plans\/[0-9a-f-]{36}$/.test(path)))) a.classList.add('active');
  }
}
function crumb(...parts) {
  const c = document.getElementById('crumb');
  c.textContent = '';
  parts.forEach((p, i) => {
    if (i) c.append(' / ');
    c.append(i === parts.length - 1 ? el('b', null, p) : p);
  });
}

// ---------------------------------------------------------------- plans registry
function bucketOf(st) {
  if (GATE_SET.has(st)) return 'review';
  if (WORKING_SET.has(st)) return 'working';
  if (BLOCKED_SET.has(st)) return 'blocked';
  return st; // created | rejected | cancelled
}
async function pagePlans(main) {
  crumb('Plan', 'Plans');
  document.title = 'Radsvinn — Plans';
  main.classList.add('enter'); // page furniture animates once; poll updates never re-trigger it
  const state = { bucket: 'all', q: '', mine: false, plans: [] };
  const prevStatus = new Map(); // plan_id -> last seen status, for the update flash

  const rollup = el('div', { class: 'rollup' }, '…');
  const newBtn = ME.roles.includes('planner')
    ? el('button', { class: 't3', onclick: () => { location.href = '/plans/new'; } }, 'New plan')
    : el('span', null, el('button', { class: 't3', disabled: true }, 'New plan'), el('span', { class: 'dis-reason' }, '🔒 requires planner role'));
  const chipsRow = el('div', { class: 'chips-inner' });
  // The filter input is created ONCE and never rebuilt — a poll tick must
  // never steal focus or rewrite the user's half-typed query. state.q keeps
  // the raw value; matching lowercases both
  // sides at compare time so the visible text is never case-mangled.
  const filterInput = el('input', {
    class: 'filter', placeholder: 'Filter by text or requester…', 'aria-label': 'Filter plans',
    oninput: (e) => { state.q = e.target.value; drawRows(); },
  });
  const filterBar = el('div', { class: 'chips' }, chipsRow, filterInput);
  const tbody = el('tbody');
  const stamp = el('div', { class: 'stamp' }, 'updated —');
  const table = el('div', { class: 'tablewrap' }, el('table', null,
    el('caption', { class: 'visually-hidden' }, 'Plans registry'),
    el('thead', null, el('tr', null,
      el('th', null, 'Plan'), el('th', null, 'ID'), el('th', null, 'Status'),
      el('th', { class: 'hide-m' }, 'Requester'), el('th', { class: 'hide-t' }, 'Grounding'),
      el('th', null, 'Cost'), el('th', null, 'Updated'))),
    tbody));
  main.replaceChildren(
    el('div', { class: 'page-head' }, el('h1', null, 'Plans'), rollup, el('div', { class: 'spacer' }), newBtn),
    filterBar, table, stamp,
  );

  function drawChips() {
    const counts = { all: state.plans.length };
    for (const p of state.plans) { const b = bucketOf(p.status); counts[b] = (counts[b] || 0) + 1; }
    const defs = [['all', 'All'], ['review', 'Needs review'], ['working', 'Working'], ['blocked', 'Blocked'],
      ['created', 'Created'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled']];
    chipsRow.replaceChildren(
      ...defs.map(([key, label]) => el('button', {
        class: `chip${state.bucket === key ? ' selected' : ''}`,
        onclick: () => { state.bucket = key; drawChips(); drawRows(); },
      }, label, el('span', { class: 'n' }, String(counts[key] || 0)))),
      el('button', {
        class: `chip${state.mine ? ' selected' : ''}`,
        onclick: () => { state.mine = !state.mine; drawChips(); drawRows(); },
      }, 'Mine'),
    );
  }
  function drawRows() {
    const q = state.q.trim().toLowerCase();
    const rows = state.plans
      .filter((p) => state.bucket === 'all' || bucketOf(p.status) === state.bucket)
      .filter((p) => !state.mine || p.requester_id === ME.login)
      .filter((p) => !q || `${p.description} ${p.requester}`.toLowerCase().includes(q))
      .map((p) => el('tr', {
        class: `rowlink${GATE_SET.has(p.status) ? ' gate' : ''}`,
        onclick: (e) => { if (!e.target.closest('a')) location.href = `/plans/${p.plan_id}`; },
      },
        // The description is a REAL link (middle-click/new-tab/copy-address
        // work); the row onclick is mouse convenience on the whitespace.
        el('td', { class: 'c-desc' },
          el('a', { class: 'rowa', href: `/plans/${p.plan_id}` }, p.description || '(no description)'),
          p.attach_key ? el('span', { class: 'attach' }, `↷ attach ${p.attach_key}`) : null),
        el('td', { class: 'c-id' }, id8(p.plan_id)),
        el('td', { class: prevStatus.has(p.plan_id) && prevStatus.get(p.plan_id) !== p.status ? 'flash' : undefined }, stChip(p.status)),
        el('td', { class: 'hide-m' }, p.requester || '—'),
        el('td', { class: 'c-ground hide-t' }, p.grounding_hint === 'light' ? 'light ⚠' : (p.grounding_hint || 'full')),
        el('td', { class: 'c-cost' }, usd(p.cost_usd)),
        el('td', { title: p.updated_at || '' }, ago(p.updated_at)),
      ));
    tbody.replaceChildren(...(rows.length ? rows : [el('tr', null, el('td', { colspan: '7' }, state.plans.length ? 'No plans match — clear filters.' : 'No plans yet. New plan starts the first Break-Down.'))]));
    const c = { review: 0, working: 0, blocked: 0, created: 0 };
    for (const p of state.plans) { const b = bucketOf(p.status); if (b in c) c[b] += 1; }
    rollup.textContent = `${c.review} need review · ${c.working} working · ${c.blocked} blocked · ${c.created} done`;
  }
  let lastSig = '';
  async function load() {
    const r = await api('/api/plans');
    if (r.status === 200) {
      state.plans = r.body.plans;
      // Unchanged data → zero DOM work (mirror of the detail page's guard).
      const sig = state.plans.map((p) => `${p.plan_id}|${p.status}|${p.updated_at}`).join(';');
      if (sig !== lastSig) {
        drawChips(); drawRows();
        for (const p of state.plans) prevStatus.set(p.plan_id, p.status); // after draw, so changes flashed once
        lastSig = sig;
      }
      stamp.textContent = `updated ${new Date().toLocaleTimeString()}`;
    }
  }
  await load();
  const t = setInterval(() => { if (!document.hidden) load(); }, 5000);
  const onVis = () => { if (!document.hidden) load(); }; // fetch immediately on tab regain
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); });
}

// ---------------------------------------------------------------- new plan form
function radioGrp(name, legendText, defs, def, helpText) {
  return el('fieldset', null,
    el('legend', { class: 'microlabel' }, legendText),
    el('div', { class: 'radios' }, defs.map(([v, label, hint]) =>
      el('label', null, el('input', { type: 'radio', name, value: v, checked: v === def }),
        el('span', null, label),
        hint ? el('span', { class: 'rh' }, hint) : null))),
    helpText ? el('div', { class: 'help' }, helpText) : null);
}
async function pagePlanNew(main) {
  crumb('Plan', 'New plan');
  document.title = 'Radsvinn — New plan';
  const canPlan = ME.roles.includes('planner');
  const desc = el('textarea', { id: 'f-desc', maxlength: '8000' });
  const counter = el('div', { class: 'counter' }, '0 / 8000');
  desc.addEventListener('input', () => { counter.textContent = `${desc.value.length} / 8000`; });
  const errBox = el('div');
  const submit = el('button', { class: 't3', disabled: !canPlan }, 'Start planning');
  const form = el('form', { class: 'form panel', onsubmit: async (e) => {
    e.preventDefault();
    errBox.replaceChildren();
    const val = (n) => (form.querySelector(`input[name=${n}]:checked`) || {}).value;
    submit.disabled = true; submit.textContent = '◐ Submitting…';
    const r = await api('/api/plans', { method: 'POST', body: {
      description: desc.value, role_lens: val('lens'), output_language: val('lang'),
      scope_hint: val('scope'), grounding_hint: val('ground'),
    } });
    if (r.status === 202) { location.href = `/plans/${r.body.plan_id}`; return; }
    submit.disabled = false; submit.textContent = 'Start planning';
    errBox.replaceChildren(el('div', { class: 'field-err' },
      `${r.body.error || 'request failed'}${r.body.details ? ': ' + r.body.details.join('; ') : ''}`));
    announce('The plan was not submitted — check the form errors.');
  } },
    el('section', null, el('label', { class: 'microlabel', for: 'f-desc' }, 'Description'), desc, counter,
      el('div', { class: 'help' }, 'Turkish or English — the output language is chosen below.')),
    el('section', null, el('h2', { class: 'microlabel' }, 'Requester'),
      el('div', { class: 'identity' }, `${ME.display || ME.login} · via your GitHub session`),
      el('div', { class: 'help' }, 'Stamped server-side from your session — a browser cannot spoof it.')),
    el('section', null, radioGrp('lens', 'Role lens',
      [['business', 'Business (default)'], ['tech', 'Tech']], 'business')),
    el('section', null, radioGrp('lang', 'Output language',
      [['en', 'English (default)'], ['tr', 'Türkçe'], ['both', 'Both — English then Türkçe']], 'en',
      'Technical jargon stays English in every mode.')),
    el('section', null, radioGrp('scope', 'How big is this?',
      [['auto', 'Let Radsvinn judge (default)'], ['single', 'One ticket'], ['small', 'A few tickets (2–5)'], ['epic', 'Large — full epic']], 'auto')),
    el('section', null, radioGrp('ground', 'Code grounding',
      [['full', 'Full — read the code (default)'],
        ['light', 'Light — skip deep code reading', 'cheaper and faster, but anchors are not deeply verified — the shape gate will be marked light ⚠']], 'full')),
    el('section', null, errBox,
      el('div', { class: 'form-foot' }, submit,
        canPlan ? el('span', { class: 'help mt0' }, 'Spends planning budget; writes nothing to Jira — both human gates still stand.')
          : el('span', { class: 'dis-reason' }, '🔒 creating plans requires the planner role — you have viewer'))),
  );
  main.classList.add('enter');
  main.replaceChildren(el('div', { class: 'page-head' }, el('h1', null, 'New plan'),
    el('div', { class: 'rollup' }, 'one honest page — no wizard steps')), form);
}

// ---------------------------------------------------------------- plan detail
const TL_STOPS = [['ask', 'ask'], ['breaking_down', '◐ break-down'], ['shape_gate', '◆ shape gate'],
  ['grooming', '◐ groom'], ['ticket_gate', '◆ ticket gate'], ['creating', 'create'], ['created', '● created']];
function tlIndex(st) {
  return { breaking_down: 1, shape_ready: 2, grooming: 3, plan_ready: 4, creating: 5, created: 6,
    cancelling: 6, cancelled: 6 }[st] ?? null;
}
async function pagePlanDetail(main, planId) {
  document.title = `Radsvinn — ${id8(planId)}`;
  crumb('Plan', 'Plans', id8(planId));
  const ui = { editing: false, dialogOpen: false, plan: null, banner: null, firstRender: true, justChanged: false };

  async function act(action, body = {}) {
    ui.banner = null; // a new action always clears a stale error banner
    const r = await api(`/api/plan/${planId}/${action}`, { method: 'POST', body });
    if (r.status === 409) ui.banner = `This plan moved to ${r.body.status} while you were deciding — the view has refreshed.`;
    else if (r.status >= 400) ui.banner = r.body.error || `request failed (${r.status})`;
    if (ui.banner) announce(ui.banner); // failures reach assistive tech, not just the DOM
    ui.bannerShown = false;
    await load(true);
    return r;
  }

  function ceremony({ title, tier, lines, confirmWord, buttonLabel, action }) {
    const p = ui.plan;
    // A11y: remember the opener; focus returns to it when the dialog closes.
    const trigger = document.activeElement;
    const input = el('input', { placeholder: id8(p.plan_id), autocomplete: 'off', spellcheck: 'false',
      'aria-label': 'Type the plan id to confirm' });
    const go = el('button', { class: tier === 5 ? 't5' : 't4', disabled: true }, buttonLabel);
    input.addEventListener('input', () => { go.disabled = input.value.trim() !== id8(p.plan_id); });
    const errLine = el('div');
    // Design §3.4: focus lands on the safe control (Cancel/Keep it) first.
    const cancelBtn = el('button', { class: 't2', autofocus: true, onclick: () => dlg.close() }, tier === 5 ? 'Cancel' : 'Keep it');
    const dlg = el('dialog', { 'aria-label': title },
      el('div', { class: 'dlg-head' }, title, el('span', { class: 'esc' }, 'Esc to cancel · focus trapped')),
      el('div', { class: 'dlg-body' }, ...lines,
        el('div', { class: 'dlg-confirm' },
          el('div', { class: 'mb6' }, 'Type the plan id ', el('span', { class: 'mono' }, id8(p.plan_id)), ' to confirm:'),
          input), errLine),
      el('div', { class: 'dlg-foot' }, cancelBtn, go));
    go.addEventListener('click', async () => {
      go.disabled = true; go.textContent = '◐ …';
      const r = await act(action, { confirm: `${confirmWord} ${id8(p.plan_id)}` });
      if (r.status < 400) { dlg.close(); announce(`${title} submitted.`); }
      else {
        errLine.replaceChildren(el('div', { class: 'field-err' }, r.body.error || 'failed'));
        announce(`${title} failed: ${r.body.error || 'request failed'}`);
        go.textContent = buttonLabel; go.disabled = false;
      }
    });
    dlg.addEventListener('close', () => {
      ui.dialogOpen = false; dlg.remove();
      if (trigger && trigger.isConnected) trigger.focus();
      if (ui.pending) load();
    });
    document.body.append(dlg); ui.dialogOpen = true; dlg.showModal();
  }

  function openCreateCeremony() {
    const p = ui.plan;
    const items = (p.plan && p.plan.items) || [];
    const stories = items.filter((i) => i.type === 'Story').length;
    const subs = items.filter((i) => i.type === 'Sub-task').length;
    const attach = p.skeleton && p.skeleton.epic && p.skeleton.epic.existing_key;
    const n = items.length + (attach ? 0 : 1);
    const dup = p.duplicate_search;
    ceremony({
      title: 'CREATE IN JIRA', tier: 5, action: 'create', confirmWord: 'create-jira-tree', buttonLabel: 'CREATE IN JIRA',
      lines: [
        el('p', null, 'You are about to write ', el('b', null, `${n} issues`),
          ` — ${attach ? `attaches under ${attach}` : '1 epic'} · ${stories} stories · ${subs} sub-tasks — to the configured Jira project as `,
          el('b', null, `@${ME.login}`), '.'),
        el('p', { class: 'warn-line' }, 'This invokes the configured tracker writer. In a live deployment, these are real tickets your team will see and act on. Undo is cancel/transition only — Jira issues are never deleted.'),
        dup && !dup.ok ? el('p', null, '⚠ duplicate search was unavailable for this plan — check the board manually.') :
          dup && dup.output && !/no matches/i.test(dup.output) ? el('p', null, `⚠ possible duplicates — reviewed? ${dup.output.slice(0, 200)}`) :
          el('p', { class: 'mono dup-note' }, `duplicate search: ${dup ? dup.output : 'not run'}`),
      ],
    });
  }
  function openCancelCeremony() {
    const p = ui.plan;
    const keys = (p.created && p.created.keys) || [];
    ceremony({
      title: 'CANCEL TREE — UNDO IN JIRA', tier: 4, action: 'cancel', confirmWord: 'cancel-jira-tree', buttonLabel: 'Cancel tree',
      lines: [
        el('p', null, 'Every ticket in this tree (', el('b', null, `${keys.length} issue${keys.length === 1 ? '' : 's'}: ${keys.join(', ')}`),
          ') will be transitioned to a terminal state (cancelled/closed where available), children before parents — ',
          el('b', null, 'never deleted'), '.'),
        p.created && p.created.attached_epic ? el('p', null, `The pre-existing epic ${p.created.attached_epic.key} is not touched.`) : null,
        el('p', { class: 'warn-line' }, 'This cannot be undone from the dashboard.'),
      ],
    });
  }

  function actionSet() {
    const p = ui.plan; const st = p.status; const out = [];
    const roleGate = (role, node, label) => ME.roles.includes(role) ? node
      : el('span', null, el('button', { class: node.className, disabled: true }, label || node.textContent),
          el('span', { class: 'dis-reason' }, `🔒 requires ${role} role`));
    if (st === 'shape_ready') {
      out.push(roleGate('approver', el('button', { class: 't2 desktop-only', onclick: () => { ui.editing = !ui.editing; if (!ui.editing && ui.pending) { load(); } else { render(); } } }, ui.editing ? 'Close editor' : 'Edit shape')));
      out.push(roleGate('approver', el('button', { class: 't3 desktop-only', onclick: () => act('approve-shape') }, 'Approve shape — generate ticket content')));
      out.push(roleGate('planner', rejectControl()));
    } else if (st === 'plan_ready') {
      out.push(roleGate('creator', el('button', { class: 't5', onclick: openCreateCeremony }, 'CREATE IN JIRA')));
      out.push(roleGate('planner', rejectControl()));
    } else if (st === 'failed' || st === 'budget_blocked') {
      out.push(roleGate('planner', el('button', { class: 't2', onclick: () => act('retry') }, '🔄 Retry')));
      if (ui.plan.created && ui.plan.created.record_path) out.push(roleGate('creator', el('button', { class: 't4', onclick: openCancelCeremony }, '⚠ Cancel tree')));
    } else if (st === 'created') {
      out.push(roleGate('creator', el('button', { class: 't4', onclick: openCancelCeremony }, '⚠ Cancel tree')));
    }
    if (st === 'failed' || st === 'budget_blocked') out.push(el('span', { class: 'dis-reason' }, 'Retry resumes at the phase that failed — completed work is kept'));
    return out;
  }
  function rejectControl() {
    const wrap = el('span');
    const btn = el('button', { class: 't2', onclick: () => {
      const reason = el('input', { class: 'filter', placeholder: 'Reason (optional)', 'aria-label': 'Reject reason' });
      wrap.replaceChildren(reason, el('button', { class: 't2 ml8', onclick: (e) => { e.target.disabled = true; act('reject', { reason: reason.value }); } }, 'Reject'),
        el('button', { class: 't1', onclick: () => wrap.replaceChildren(btn) }, 'keep'));
      reason.focus();
    } }, 'Reject');
    wrap.append(btn);
    return wrap;
  }

  // ---- panels
  function shapePanel() {
    const p = ui.plan; const sk = p.skeleton;
    if (!sk) return null;
    const body = [];
    if (ui.editing) {
      const ta = el('textarea', { class: 'editor-json', 'aria-label': 'Skeleton JSON editor' });
      ta.value = JSON.stringify(sk, null, 2);
      const errLine = el('div');
      body.push(el('div', { class: 'help help-lead' },
        'Prototype editor: raw JSON; a structured editor is future work. Approving submits skeleton_edits — the server stages and re-runs the real deterministic gate; a 422 keeps your edits.'),
        errLine, ta,
        el('div', { class: 'actions mt10' },
          el('button', { class: 't3', onclick: async () => {
            let edits; try { edits = JSON.parse(ta.value); } catch (e) { errLine.replaceChildren(el('div', { class: 'field-err' }, `invalid JSON: ${e.message}`)); return; }
            const r = await api(`/api/plan/${planId}/approve-shape`, { method: 'POST', body: { skeleton_edits: edits } });
            if (r.status === 422) {
              announce('The edited skeleton failed the deterministic gate — findings are shown above the editor.');
              errLine.replaceChildren(el('div', { class: 'field-err' }, 'The edited skeleton failed the deterministic gate:'),
                el('div', { class: 'raw-well' }, JSON.stringify(r.body.gate && r.body.gate.raw, null, 1).slice(0, 1500)));
            } else if (r.status >= 400) { errLine.replaceChildren(el('div', { class: 'field-err' }, r.body.error || 'failed')); }
            else { ui.editing = false; await load(true); }
          } }, 'Approve edited shape — generate ticket content')));
    } else {
      if (sk.epic) body.push(el('div', { class: 'tree-epic' }, el('span', { class: 'typechip' }, 'EPIC'), sk.epic.summary,
        sk.epic.existing_key ? el('span', { class: 'attach' }, ` ↷ attaches to existing ${sk.epic.existing_key}`) : null));
      const byMs = new Map();
      for (const it of sk.items || []) {
        const k = it.milestone_id || '';
        if (!byMs.has(k)) byMs.set(k, []);
        byMs.get(k).push(it);
      }
      for (const [msId, items] of byMs) {
        const ms = (sk.milestones || []).find((m) => m.milestone_id === msId);
        if (ms) body.push(el('div', { class: 'milestone' }, el('span', { class: 'mprefix' }, `Milestone ${ms.order}`), ` — ${ms.name}`));
        for (const it of items) {
          body.push(el('div', { class: 'tree-item' },
            el('span', { class: 'typechip' }, it.type), it.one_line_summary,
            it.depends_on && it.depends_on.length ? el('span', { class: 'dep' }, `→ ${it.depends_on.join(', ')}`) : null,
            el('span', { class: 'size' }, `${(it.size_estimate && it.size_estimate.tier) || it.effort_tier || ''} · ${it.repo}`)));
        }
      }
      if (p.status === 'shape_ready') body.push(el('div', { class: 'gateline' }, 'structure ✅ machine-checked · correctness NOT auto-checked — you are the reviewer'));
    }
    return el('section', null, el('h2', { class: 'microlabel' }, 'Proposed shape'), ...body);
  }
  function ticketsPanel() {
    const p = ui.plan;
    if (!p.plan || !p.plan.items) return null;
    const kids = [];
    const skSummary = new Map(((p.skeleton && p.skeleton.items) || []).map((s) => [s.temp_id, s.one_line_summary]));
    for (const it of p.plan.items) {
      const f = it.fields || {};
      const anchors = (f.related_links && f.related_links.code_anchors) || [];
      kids.push(el('div', { class: 'ticket' },
        el('h3', null, el('span', { class: 'typechip' }, it.type), it.one_line_summary || skSummary.get(it.temp_id) || it.temp_id),
        el('div', { class: 'effort-note' }, `size ${it.effort_tier || '—'} · effort estimate — not money`),
        el('div', { class: 'field-grp' }, el('div', { class: 'flabel' }, 'Why'), el('p', null, f.why || '(none)')),
        el('div', { class: 'field-grp' }, el('div', { class: 'flabel' }, 'Definition of done'), el('p', null, f.definition_of_done || '(none)')),
        el('div', { class: 'field-grp' }, el('div', { class: 'flabel' }, 'Acceptance criteria'),
          el('ul', null, (f.acceptance_criteria || []).map((a) => el('li', null, a)))),
        el('div', { class: 'field-grp' }, el('div', { class: 'flabel' }, 'Technical analysis'),
          el('p', null, (f.technical_analysis && f.technical_analysis.prose) || '(none)')),
        el('div', { class: 'field-grp' }, el('div', { class: 'flabel' }, 'Code anchors'),
          anchors.length ? el('div', { class: 'anchors' }, anchors.map((a) => el('div', null, a)))
            : el('div', { class: 'anchors' }, '⚠ 0 anchors — coupling-zone routing not machine-checkable')),
      ));
    }
    const gate = p.plan_gate;
    const gateline = !gate ? 'plan gate: no result — not checked'
      : gate.skipped ? 'plan gate skipped — not checked'
      : gate.ok ? 'structure ✅ · anchors resolve ✅' : 'plan gate ✕ FAILED';
    kids.push(el('div', { class: 'gateline' }, `${gateline} · correctness NOT auto-checked — you are the reviewer`));
    return el('section', null, el('h2', { class: 'microlabel' }, 'Groomed tickets'), ...kids);
  }
  function gatePanel() {
    const p = ui.plan;
    const blocks = [];
    for (const [name, gate] of [['skeleton gate', p.skeleton_gate], ['plan gate', p.plan_gate]]) {
      if (!gate) continue;
      const rows = [];
      if (gate.skipped) rows.push(el('div', { class: 'checkrow' }, el('span', { class: 'warn' }, '⚠'), `${name} skipped — not checked`));
      else if (gate.raw && gate.raw.checks) {
        for (const [check, r] of Object.entries(gate.raw.checks)) {
          const complaints = (r.complaints || []).join(' · ');
          rows.push(el('div', { class: 'checkrow' },
            el('span', { class: r.pass ? 'ok' : 'warn' }, r.pass ? '✓' : '✕'), check,
            complaints ? el('span', { class: 'warn' }, complaints.startsWith('WARN') ? `⚠ ${complaints}` : complaints) : null));
        }
      }
      if (rows.length) blocks.push(el('div', { class: 'field-grp' }, el('div', { class: 'flabel' }, name), ...rows));
    }
    if (!blocks.length) return null;
    const rc = ui.plan.regen_counts || {};
    blocks.push(el('div', { class: 'checkrow' }, `regens: phase1 ${rc.phase1 || 0}/2 · groom ${rc.groom || 0}/2`));
    blocks.push(el('details', null, el('summary', null, 'view raw gate output'),
      el('div', { class: 'raw-well' }, JSON.stringify({ skeleton_gate: ui.plan.skeleton_gate, plan_gate: ui.plan.plan_gate }, null, 1))));
    return el('section', null, el('h2', { class: 'microlabel' }, 'Deterministic gate findings'), ...blocks);
  }
  function failPanel() {
    const p = ui.plan;
    if (!BLOCKED_SET.has(p.status) || !p.error) return null;
    return el('section', null, el('h2', { class: 'microlabel' }, 'Failure'),
      el('div', { class: 'errbox' }, p.error),
      p.status === 'budget_blocked'
        ? el('p', { class: 'help' },
          /daily spend/i.test(p.error)
            ? 'Retryable — the daily cap resets at UTC midnight; Retry re-checks the caps.'
            : 'Retryable — per-plan spend does not reset at midnight; change the plan budget or reject and submit a smaller plan before retrying.')
        : null);
  }
  function createdPanel() {
    const p = ui.plan;
    if (!p.created) return null;
    const c = p.created;
    return el('section', null, el('h2', { class: 'microlabel' }, 'Created record'),
      ...(c.items || []).map((it) => el('div', { class: 'keyrow' }, `${it.key} · ${it.type} · ${it.summary}`)),
      el('div', { class: 'keyrow' }, `verify ${c.verify_ok ? '✓ tree readable' : '✕ verify failed'} (tree-level)`),
      c.partial ? el('div', { class: 'errbox' }, '⚠ PARTIAL — this record does not represent the full plan; re-creating is blocked.') : null,
      c.attached_epic ? el('div', { class: 'keyrow' }, `↷ attached under ${c.attached_epic.key} [attached — never swept by cancel]`) : null,
      p.status === 'cancelled' ? el('p', { class: 'help' }, '⟲ tree cancelled — every issue transitioned to a terminal state; nothing was deleted.') : null);
  }
  function dupPanel() {
    const p = ui.plan;
    if (p.status !== 'plan_ready' || !p.duplicate_search) return null;
    return el('section', null, el('h2', { class: 'microlabel' }, 'Duplicate search — advisory'),
      el('div', { class: 'checkrow' }, p.duplicate_search.ok ? p.duplicate_search.output : '⚠ duplicate search unavailable — check the board manually before creating'));
  }
  function inspector() {
    const p = ui.plan;
    const facts = el('dl', { class: 'kv' });
    const add = (k, v) => facts.append(el('dt', null, k), el('dd', null, v));
    add('status', p.status); add('cost', usd(p.cost_usd));
    const rc = p.regen_counts || {}; add('regens', `p1 ${rc.phase1 || 0}/2 · groom ${rc.groom || 0}/2`);
    if (p.grounding) add('grounding fetch', p.grounding.ok ? 'ok' : '⚠ failed');
    add('language', p.output_language || 'en'); add('scope', p.scope_hint || 'auto'); add('depth', p.grounding_hint || 'full');
    add('created', p.created_at || '—'); add('updated', p.updated_at || '—');
    if (p.surface && p.surface.type) add('surface', p.surface.type);
    return el('aside', { class: 'inspector', 'aria-label': 'Plan inspector' },
      el('div', { class: 'grp' }, el('h2', { class: 'microlabel' }, 'Facts'), facts),
      el('div', { class: 'grp' }, el('h2', { class: 'microlabel' }, 'Actions'), el('div', { class: 'actions' }, ...actionSet())),
      el('div', { class: 'grp', id: 'insp-audit' }, el('h2', { class: 'microlabel' }, 'Audit'),
        el('div', { class: 'help' }, 'loading…')));
  }
  async function fillAudit() {
    const r = await api('/api/audit');
    const box = document.getElementById('insp-audit');
    if (!box || r.status !== 200) return;
    const mine = r.body.records.filter((a) => a.plan_id === planId).slice(0, 5);
    box.replaceChildren(el('h2', { class: 'microlabel' }, 'Audit'),
      ...(mine.length ? mine.map((a) => el('div', { class: 'checkrow' }, `${a.actor.id} ${a.action} · ${a.outcome.http}`))
        : [el('div', { class: 'help' }, 'no dashboard actions on this plan yet')]),
      el('a', { class: 't1', href: '/audit' }, 'full trail →'));
  }
  function timeline() {
    const p = ui.plan;
    const cur = tlIndex(p.status);
    // Terminal detours branch off the stage they actually occurred at,
    // inferred from which artifacts exist — never appended past `created`.
    let detourAfter = null;
    let detourLabel = null;
    if (p.status === 'rejected') {
      // Rejects happen AT a human gate: shape gate (2) or ticket gate (4).
      detourLabel = `${STATUS[p.status].g} ${STATUS[p.status].label}`;
      detourAfter = p.plan ? 4 : 2;
    } else if (['failed', 'budget_blocked'].includes(p.status)) {
      // Failures happen INSIDE automated phases: break-down (1), groom (3),
      // create (5) — never at a gate (gates run no code that can fail).
      // Gate RESULTS disambiguate: a groomed artifact that FAILED its gate
      // means the failure was still the groom phase, not create.
      detourLabel = `${STATUS[p.status].g} ${STATUS[p.status].label}`;
      const skOk = p.skeleton_gate && p.skeleton_gate.ok === true;
      const plOk = p.plan_gate && p.plan_gate.ok === true;
      detourAfter = p.created ? 5 : (p.plan && plOk) ? 5 : (p.plan || skOk) ? 3 : 1;
    } else if (['cancelling', 'cancelled'].includes(p.status)) {
      detourLabel = `${STATUS[p.status].g} ${STATUS[p.status].label}`;
      detourAfter = 6;
    }
    const stops = [];
    TL_STOPS.forEach(([, label], i) => {
      const done = detourAfter !== null ? i <= detourAfter : (cur !== null && i < cur);
      const current = detourAfter === null && cur === i;
      stops.push(el('div', { class: `tstop${done ? ' done' : ''}${current ? ' current' : ''}` },
        el('span', { class: 'lbl' }, label)));
      if (detourAfter === i && detourLabel) {
        stops.push(el('div', { class: 'tstop detour' }, el('span', { class: 'lbl' }, detourLabel)));
      }
    });
    const human = STATUS[p.status] ? STATUS[p.status].label : p.status;
    return el('div', { class: 'timeline', role: 'img', 'aria-label': `Pipeline position: ${human}${detourLabel ? ' (branched off the main pipeline)' : ''}` }, ...stops);
  }

  function render() {
    const p = ui.plan;
    const flags = [];
    if (p.grounding && p.grounding.ok === false) flags.push('⚠ grounding fetch failed — anchors may validate against stale code');
    if (p.grounding_hint === 'light') flags.push('grounding: light — anchors were NOT deeply verified');
    if (p.skeleton && p.skeleton.epic && p.skeleton.epic.existing_key) flags.push(`↷ attaches to existing ${p.skeleton.epic.existing_key}`);
    if (p.status === 'creating') flags.push('control-plane — no LLM touches Jira');
    // Meta line: only segments that carry real values (the planner read model
    // only render segments that carry a real value (never an empty `lens —`).
    const meta = [p.plan_id, `asked by ${p.requester || p.requester_id || '—'}`];
    if (p.role_lens) meta.push(`lens ${p.role_lens}`);
    meta.push(`lang ${p.output_language || 'en'}`, `scope ${p.scope_hint || 'auto'}`, `grounding ${p.grounding_hint || 'full'}`, usd(p.cost_usd));
    const chip = stChip(p.status);
    if (ui.justChanged) chip.classList.add('flash');
    // Entry animation runs once per page load, never on poll re-renders.
    if (ui.firstRender) main.classList.add('enter'); else main.classList.remove('enter');
    ui.firstRender = false;
    main.replaceChildren(el('div', { class: 'detail' },
      el('div', { class: 'head-band' },
        ui.banner ? el('div', { class: 'banner' }, ui.banner) : null,
        el('h1', null, (p.description || '(no description)')),
        chip,
        el('div', { class: 'metaline' }, meta.join(' · ')),
        ...flags.map((f) => el('div', { class: 'flagline' }, f)),
        el('div', { class: 'actions head-actions' }, ...actionSet()),
        el('div', { class: 'mobile-note' }, 'Create in Jira, Cancel tree, Edit shape and Approve shape require a desktop browser — read, Reject and Retry stay available here.'),
        timeline()),
      el('div', null, el('div', { class: 'panel' },
        shapePanel(), ticketsPanel(), gatePanel(), dupPanel(), failPanel(), createdPanel())),
      inspector(),
    ));
    fillAudit();
    ui.justChanged = false;
    ui.bannerShown = Boolean(ui.banner);
  }

  async function load(force) {
    if (!force && (ui.dialogOpen || ui.editing)) { ui.pending = true; return; }
    ui.pending = false;
    const r = await api(`/api/plan/${planId}`);
    if (r.status !== 200) { main.replaceChildren(el('p', { class: 'loading' }, `Plan not found (${r.status}).`)); return; }
    // Morph-in-place discipline: an unchanged payload never re-renders — the
    // DOM (and the user's focus/hover/selection) survives idle poll ticks.
    // A banner forces exactly ONE render (bannerShown), never a rebuild storm.
    if (!force && ui.plan && r.body.updated_at === ui.plan.updated_at && r.body.status === ui.plan.status
      && (!ui.banner || ui.bannerShown)) {
      return;
    }
    const prev = ui.plan && ui.plan.status;
    ui.plan = r.body;
    if (prev && prev !== r.body.status) {
      announce(`Status: ${STATUS[r.body.status] ? STATUS[r.body.status].label : r.body.status}`);
      ui.banner = null;
      ui.justChanged = true; // one-shot flash on the status chip
    }
    render();
  }
  await load(true);
  // Design cadence: 3s while the machine works, 5s at human gates, 15s at
  // failed/budget_blocked (only a human action changes those), stop at terminal.
  let timer = null;
  function nextDelay() {
    const st = ui.plan && ui.plan.status;
    if (!st || ['created', 'rejected', 'cancelled'].includes(st)) return null;
    if (WORKING_SET.has(st)) return 3000;
    if (GATE_SET.has(st)) return 5000;
    return 15000; // failed | budget_blocked
  }
  function schedule() {
    const d = nextDelay();
    if (d === null) return;
    timer = setTimeout(async () => { if (!document.hidden) await load(); schedule(); }, d);
  }
  schedule();
  const onVis = () => { if (!document.hidden) load(); }; // immediate catch-up on tab regain
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', () => { if (timer) clearTimeout(timer); document.removeEventListener('visibilitychange', onVis); });
}

// ---------------------------------------------------------------- operations
async function pageOperations(main) {
  crumb('Operate', 'Operations');
  document.title = 'Radsvinn — Operations';
  main.classList.add('enter');
  let firstDraw = true;
  async function draw() {
    if (!firstDraw) main.classList.remove('enter');
    firstDraw = false;
    const [h, plans] = await Promise.all([api('/api/health'), api('/api/plans')]);
    const hb = h.body || {};
    const inflight = { breaking_down: 0, grooming: 0, creating: 0, cancelling: 0 };
    for (const p of (plans.body.plans || [])) if (p.status in inflight) inflight[p.status] += 1;
    const lock = hb.cost_telemetry_locked;
    main.replaceChildren(
      el('div', { class: 'page-head' }, el('h1', null, 'Operations'), el('div', { class: 'rollup' }, 'read-only — operator controls stay outside this dashboard')),
      el('div', { class: 'panel' },
        el('section', null, el('h2', { class: 'microlabel' }, 'Planner health'),
          el('div', { class: 'opsrow' },
            el('span', null, `ok: ${hb.ok === true}`), el('span', null, `version ${hb.version || '—'}`),
            el('span', null, `engine: ${hb.engine || '—'}${hb.engine && hb.engine !== 'real' ? '  ⚠ FAKE ENGINE' : ''}`),
            el('span', null, `reachability: ${h.status === 200 ? 'ok' : `✕ ${h.status}`}`))),
        el('section', null, el('h2', { class: 'microlabel' }, 'Spend & telemetry'),
          lock === true
            ? el('div', { class: 'lockband' }, '⊗ COST TELEMETRY LOCKED — all LLM work is blocked until an operator repairs the spend ledger or lock file. Daily spend is unavailable while locked.')
            : el('div', { class: 'bigstat' }, hb.daily_spend_usd === null ? 'unavailable while locked' : `${usd(hb.daily_spend_usd)} today`),
          lock === undefined ? el('div', { class: 'help' }, 'cost telemetry: not reported by the connected planner') : null),
        el('section', null, el('h2', { class: 'microlabel' }, 'Plans in flight'),
          el('div', { class: 'opsrow' },
            el('span', null, `◐ ${inflight.breaking_down} breaking down`), el('span', null, `◐ ${inflight.grooming} grooming`),
            el('span', null, `◐ ${inflight.creating} creating`), el('span', null, `⟲ ${inflight.cancelling} cancelling`)),
          el('div', { class: 'help' }, 'a service restart sweeps in-flight plans to failed (retryable) — never restart while these counts are non-zero.'))));
  }
  await draw();
  const t = setInterval(() => { if (!document.hidden) draw(); }, 5000);
  const onVis = () => { if (!document.hidden) draw(); };
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('pagehide', () => { clearInterval(t); document.removeEventListener('visibilitychange', onVis); });
}

// ---------------------------------------------------------------- audit
async function pageAudit(main) {
  crumb('Govern', 'Audit');
  document.title = 'Radsvinn — Audit';
  main.classList.add('enter');
  const r = await api('/api/audit');
  const rows = (r.body.records || []).map((a) => el('tr', null,
    el('td', { class: 'c-id' }, a.ts), el('td', { class: 'c-id' }, a.actor.id),
    el('td', { class: 'c-id' }, a.action), el('td', { class: 'c-id' }, a.plan_id ? el('a', { href: `/plans/${a.plan_id}`, class: 'c-id' }, id8(a.plan_id)) : '—'),
    el('td', { class: 'c-id' }, `${a.outcome.http}${a.outcome.error ? ` ${a.outcome.error}` : ''}${a.outcome.to_status ? ` → ${a.outcome.to_status}` : ''}`),
    el('td', null, a.detail || '')));
  main.replaceChildren(
    el('div', { class: 'page-head' }, el('h1', null, 'Audit'), el('div', { class: 'rollup' }, 'the planner-side append-only actor ledger — every mutation, newest first')),
    el('div', { class: 'tablewrap' }, el('table', null,
      el('caption', { class: 'visually-hidden' }, 'Actor audit trail'),
      el('thead', null, el('tr', null, el('th', null, 'Time'), el('th', null, 'Actor'), el('th', null, 'Action'),
        el('th', null, 'Plan'), el('th', null, 'Outcome'), el('th', null, 'Detail'))),
      el('tbody', null, ...(rows.length ? rows : [el('tr', null, el('td', { colspan: '6' }, 'No dashboard actions yet — approve, reject or create something.'))])))));
}

// ---------------------------------------------------------------- settings
const ROLE_META = [
  ['viewer', 'Read plans, operations health, and the audit trail.', 'every active org member', true],
  ['planner', 'Start plans; reject and retry them. Spends planning budget, never writes Jira.', 'configured planner team'],
  ['approver', 'Edit and approve the shape — human gate 1. Every edit is deterministically re-gated.', 'configured approver team'],
  ['creator', 'Create and cancel Jira trees — human gate 2. Named, typed-id ceremony; cancel-only undo.', 'configured creator team'],
];
async function pageSettings(main) {
  crumb('Govern', 'Settings');
  document.title = 'Radsvinn — Settings';
  const idFacts = el('dl', { class: 'kvwide' });
  const fact = (k, v, mono) => idFacts.append(el('dt', null, k), el('dd', { class: mono ? 'mono' : undefined }, v));
  fact('Signed in as', `${ME.display}`);
  fact('Login', ME.login, true);
  fact('Authentication', 'GitHub OAuth (organization members only)');
  fact('Session since', ME.since || '—', true);
  fact('Session store', 'in-memory, single instance — a restart signs everyone out');

  const rows = ROLE_META.map(([role, descText, via, locked]) => {
    const active = ME.roles.includes(role);
    const box = el('input', { type: 'checkbox', value: role, checked: active, disabled: true,
      'aria-label': `${role} role`, tabindex: '-1' });
    const row = el('div', { class: `rolerow${active ? '' : ' off'}` }, box,
      el('div', { class: 'rolename' }, role),
      el('div', { class: 'roledesc' }, descText, el('span', { class: 'via' },
        active ? `granted via ${via}` : `would be granted via ${via}`)),
      el('div', { class: 'rolestate' }, active ? '● GRANTED' : '○ NOT GRANTED'));
    return row;
  });

  const aboutFacts = el('dl', { class: 'kvwide' });
  const about = (k, v, mono) => aboutFacts.append(el('dt', null, k), el('dd', { class: mono ? 'mono' : undefined }, v));
  about('Dashboard', 'Radsvinn BFF — the planner credential stays server-side and never reaches this page', false);
  about('Planner', 'reached only by the server-side BFF at its configured planner URL', false);
  about('Design record', 'docs/ARCHITECTURE.md', true);
  about('Visual convention', 'Grayscale Technical Interface Convention', false);

  main.classList.add('enter');
  main.replaceChildren(
    el('div', { class: 'page-head' }, el('h1', null, 'Settings'),
      el('div', { class: 'rollup' }, 'identity · session · about — read-only by design')),
    el('div', { class: 'panel panel-narrow' },
      el('section', null, el('h2', { class: 'microlabel' }, 'Identity'), idFacts),
      el('section', null, el('h2', { class: 'microlabel' }, 'Roles & access'),
        el('div', { class: 'help help-lead' },
          'Roles are server-side facts resolved from your GitHub org team membership at sign-in and re-checked periodically — never a client-side switcher. The BFF enforces them on every request; the table below is read-only.'),
        ...rows),
      el('section', null, el('h2', { class: 'microlabel' }, 'Session'),
        el('div', { class: 'form-foot' },
          el('button', { class: 't2', onclick: async (e) => {
            e.target.disabled = true;
            const r = await api('/auth/logout', { method: 'POST', noAuthRedirect: true });
            location.href = '/';
          } }, 'Sign out'),
          el('span', { class: 'help mt0' }, `signed in via GitHub as ${ME.login}`))),
      el('section', null, el('h2', { class: 'microlabel' }, 'About'), aboutFacts)));
}

// ---------------------------------------------------------------- boot
document.addEventListener('DOMContentLoaded', async () => {
  await bootShell();
  const main = document.getElementById('main');
  const p = location.pathname;
  const detail = p.match(/^\/plans\/([0-9a-f-]{36})$/);
  if (detail) return pagePlanDetail(main, detail[1]);
  if (p === '/plans/new') return pagePlanNew(main);
  if (p === '/operations') return pageOperations(main);
  if (p === '/audit') return pageAudit(main);
  if (p === '/settings') return pageSettings(main);
  return pagePlans(main);
});
