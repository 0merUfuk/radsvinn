// slack.mjs — Slack Socket Mode bridge for the Mercury `POST /plan` service
// (service/server.mjs). Implements the chat surface described in
// docs/ARCHITECTURE.md: `/plan <ask>` -> approval buttons -> tracker tickets, entirely over
// an OUTBOUND WebSocket (Socket Mode) so this process needs no public URL /
// inbound ingress. Zero npm dependencies — Node 22+'s native `WebSocket`
// global + native `fetch` only, matching this repo's no-deps discipline
// (see service/README.md's own header).
//
// -- Protocol (Slack Socket Mode, implemented exactly) ----------------------
// Open:      POST https://slack.com/api/apps.connections.open
//            (Authorization: Bearer SLACK_APP_TOKEN, xapp-...,
//            Content-Type: application/x-www-form-urlencoded) -> {ok,url}
//            -> new WebSocket(url).
// Frames:    JSON text frames. {type:"hello"} on connect; envelopes
//            {envelope_id, type, payload, accepts_response_payload} for
//            slash_commands / interactive / events_api; {type:"disconnect",
//            reason} means Slack is about to drop this connection — open a
//            FRESH one (apps.connections.open again), THEN close the old one.
// Ack:       every envelope MUST be acked within 3s: {envelope_id}, or
//            {envelope_id, payload} when accepts_response_payload is true
//            and an immediate visible response is wanted.
// Reconnect: exponential backoff on an unplanned close/error (1s -> 2s ->
//            4s ... capped at 30s), logged to stderr. A `disconnect` frame
//            reuses the same reconnect path at zero delay (scheduleReconnect).
// Web API:   bot-token (xoxb-...) POSTs to chat.postMessage / chat.update,
//            Authorization: Bearer SLACK_BOT_TOKEN, JSON body; {ok:true,ts,
//            channel} on success.
//
// -- Testability split -------------------------------------------------------
// Every Slack MESSAGE SHAPE (blocks, ack payloads) is pure and lives in
// slack-blocks.mjs — zero IO, fully unit-testable on its own. This file owns
// only PROTOCOL + IO: the envelope dispatcher (`handleEnvelope`), the status
// poller (`pollOnce`), boot-resume, and the socket/reconnect plumbing.
// `createBridge` takes every side-effecting dependency (serviceFetch,
// slackFetch, connect) as a parameter so service/test/slack.test.mjs can
// exercise the dispatcher/poller/resume against simple recorded-calls fakes
// — no sockets, no network. The socket/reconnect state machine itself is
// therefore the one piece of this file NOT exercised by the automated
// suite; deployed Socket Mode connectivity remains an operator smoke check.
//
// -- Protocol decisions made within this build (not explicit in the spec) --
// 1. `description` isn't part of GET /plan/{id}'s response (`toPublicView`
//    in server.mjs never returns it), but the shape_ready message needs it
//    for its header line. This bridge carries it itself: captured verbatim
//    from the slash command at POST /plan time, or — after a bridge restart
//    — recovered (truncated to 80 chars) from the GET /plans endpoint this
//    build adds to server.mjs specifically so boot-resume has something to
//    render.
// 2. The planner service stays Slack-agnostic — it never interprets a
//    channel. Surface persistence uses two CLIENT-owned fields
//    to the plan record, written by this bridge and read back verbatim:
//    an OPAQUE `surface` descriptor ({type:'slack', channel, message_ts?})
//    and an `announced_status` delivery cursor (the last status this bridge
//    successfully announced). Boot-resume re-attaches from the STORE, not
//    RAM: a plan whose surface says slack re-watches WITH its original
//    channel (loss Window A — bridge died mid-plan), and lastStatus seeds
//    from the CURSOR, so a status reached while the bridge was down —
//    including a terminal one — is announced on the first poll (loss
//    Window B). Only a plan with no usable surface on file (legacy, or a
//    foreign surface's) still has no channel; when such a plan's status
//    changes, pollOnce logs a clear stderr warning and skips the Slack post
//    rather than guessing a channel or crashing.
// 3. Both the button-click "success" and "409 conflict" outcomes update the
//    ORIGINAL message the same way (replaceActionsWithContext with
//    different text) — the spec's two bullets read as the same
//    chat.update-the-original-message mechanism with two different outcome
//    strings, not two different update strategies.
// 4. `approve_shape`/`create` clicks get BOTH an immediate inline
//    chat.update ("✔ Approve by @user") AND, later, the poller's own post
//    once the async worker actually finishes (the plan_ready/created
//    message). These carry different information (click acknowledged vs.
//    the actual groomed plan / created ticket keys) and are not redundant.
//    A `reject` click's inline confirm and the poller's later "⚠️ rejected"
//    post overlap more (both just say "rejected") — kept anyway, since the
//    poller must remain the single source of truth for state changes
//    regardless of whether they originated from Slack, the Dashboard, or a
//    direct API call.

import { pathToFileURL } from 'node:url';
import {
  skeletonMessage,
  planReadyMessage,
  renderPlanText,
  createdMessage,
  cancelledMessage,
  terminalMessage,
  preparingMessage,
  ackPayload,
  replaceActionsWithContext,
  buildPlanWizardView,
} from './slack-blocks.mjs';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8090';
const DEFAULT_POLL_MS = 7000;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

// Ephemeral usage hint for `/plan help|?|h`. Only the invoker ever
// sees it (response_type ephemeral via ackPayload). The cost warning is the
// load-bearing line: `/plan help` used to open the wizard with "help"
// prefilled — one click on "Plan it" away from a real ~$1-2 paid planning
// run, just to read usage. The hint replaces that trap.
const HELP_TEXT = [
  '*Mercury* turns a plain-language ask into a Jira ticket tree.',
  '• `/plan <description>` — opens a form to plan that work',
  '• `/plan` — opens the same form, empty',
  '⚠️ Submitting the form (*Plan it*) runs the AI planner and costs money (~$1–2 per run) — only do it for real work.',
].join('\n');

// Statuses that stop `pollOnce` from posting anything further for a plan
// AND drop it from the watch map once handled. `failed`/`budget_blocked` are
// deliberately NOT here: they are retryable, so their watch entry (channel,
// description, messageTs) must survive for a Retry click to re-use — the
// terminalMessage still posts exactly once (a status change is a status
// change), and after that the unchanged status is simply skipped.
// `created` is only watch-terminal, not plan-terminal: its message carries
// the Cancel tree button, and a cancel_tree click re-captures the channel
// into a fresh watch entry (handleBlockAction) so the poller can post the
// eventual `cancelled`. `cancelled` itself is fully terminal — it posts its
// own success message (cancelledMessage, NOT the ⚠️ terminalMessage) and is
// deliberately absent from TERMINAL_NON_SUCCESS_STATUSES below.
const STOP_WATCHING_STATUSES = new Set(['created', 'rejected', 'cancelled']);
const TERMINAL_NON_SUCCESS_STATUSES = new Set(['failed', 'budget_blocked', 'rejected']);

function actionLabel(actionId) {
  if (actionId === 'approve_shape') return 'Approve';
  if (actionId === 'create') return 'Create';
  if (actionId === 'reject') return 'Reject';
  if (actionId === 'retry') return 'Retry';
  if (actionId === 'cancel_tree') return 'Cancel tree';
  return actionId;
}

// Button-click confirmation line, parametrized by action so the old
// static "✔ X by @user" no longer sits mute for the MINUTES grooming/creating
// take (the "looks stalled" perception in the two most expensive phases). It
// names what happens NEXT. Terminal `reject` gets no "working" suffix — there
// is nothing running after it.
//
// DEFERRED (by design): the periodic "still working, Ns" pulse. pollOnce's
// dedup guard (`status === entry.lastStatus`) fires the silent grooming/
// creating branch exactly ONCE per status value, not per tick, so a naive
// pulse doesn't work and needs its own design — out of scope for this cheap
// fix.
function clickConfirmText(actionId, user) {
  if (actionId === 'approve_shape') return `✔ Approved by @${user} — grooming now, this can take a few minutes…`;
  if (actionId === 'create') return `✔ Create started by @${user} — writing to Jira now…`;
  if (actionId === 'retry') return `✔ Retry by @${user} — re-running…`;
  if (actionId === 'reject') return `✔ Rejected by @${user}`;
  if (actionId === 'cancel_tree') return `✔ Cancel by @${user} — cleaning up…`;
  // defensive: unreachable today — handleBlockAction's 5-way action_id routing
  // early-returns before reaching clickConfirmText for any other id (mirrors
  // actionLabel's own untested fallback, the file's established precedent).
  // Kept so a future 6th action wired without a case here degrades to a sane
  // label instead of returning undefined (which would push { text: undefined }
  // into the context block and trip Slack invalid_blocks on chat.update).
  return `✔ ${actionLabel(actionId)} by @${user}`;
}

async function safeJson(res) {
  try {
    const text = await res.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/**
 * @param {object} deps
 * @param {typeof fetch} [deps.serviceFetch] - fetch used for the local planner service (POST /plan, GET /plan/{id}, GET /plans, the gate actions). Defaults to the global fetch.
 * @param {typeof fetch} [deps.slackFetch] - fetch used for every slack.com/api/* call. Defaults to the global fetch.
 * @param {(url: string) => WebSocket} [deps.connect] - WebSocket factory; only required if `start()` is actually called. Defaults to the global WebSocket.
 * @param {NodeJS.ProcessEnv} [deps.env] - defaults to process.env.
 * @param {Console} [deps.log] - defaults to console; every log line this module emits goes through `.error` (stderr) by design — see service/README.md.
 */
export function createBridge({
  serviceFetch = fetch,
  slackFetch = fetch,
  connect = (url) => new WebSocket(url),
  env = process.env,
  log = console,
} = {}) {
  if (!env.SLACK_APP_TOKEN || !env.SLACK_BOT_TOKEN) {
    throw new Error('SLACK_APP_TOKEN and SLACK_BOT_TOKEN are both required');
  }

  const serviceUrl = String(env.MERCURY_SERVICE_URL || DEFAULT_SERVICE_URL).replace(/\/+$/, '');
  const serviceToken = env.MERCURY_SERVICE_TOKEN;
  const pollMs = Number(env.MERCURY_SLACK_POLL_MS) > 0 ? Number(env.MERCURY_SLACK_POLL_MS) : DEFAULT_POLL_MS;

  /** plan_id -> {channel, requester, description, lastStatus, messageTs} */
  const watched = new Map();

  let pollTimer = null;
  let ws = null;
  let reconnectDelay = RECONNECT_BASE_MS;
  let reconnectScheduled = false;
  let stopped = false;

  // -- local planner-service HTTP ---------------------------------------

  function serviceHeaders() {
    const headers = { 'Content-Type': 'application/json' };
    if (serviceToken) headers['Authorization'] = `Bearer ${serviceToken}`;
    return headers;
  }

  async function serviceGet(urlPath) {
    const res = await serviceFetch(`${serviceUrl}${urlPath}`, { headers: serviceHeaders() });
    return { status: res.status, ok: res.ok, body: await safeJson(res) };
  }

  async function servicePost(urlPath, payload) {
    const res = await serviceFetch(`${serviceUrl}${urlPath}`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify(payload || {}),
    });
    return { status: res.status, ok: res.ok, body: await safeJson(res) };
  }

  // Best-effort write of the reply-to surface descriptor
  // and/or the announced_status delivery cursor onto the DURABLE plan record
  // (POST /plan/{id}/surface). NEVER throws — surface persistence is a
  // recovery aid, and no failure here may take down its caller (the submit
  // flow, a click handler, or the poller). Returns whether the store
  // accepted the write, so the poller can decide whether its in-RAM
  // lastStatus is allowed to advance past the durable cursor.
  async function writeSurface(planId, payload) {
    try {
      const res = await servicePost(`/plan/${planId}/surface`, payload);
      if (!res.ok) {
        log.error(`[mercury-slack] surface write for ${planId} refused: ${(res.body && res.body.error) || `HTTP ${res.status}`}`);
      }
      return res.ok;
    } catch (err) {
      log.error(`[mercury-slack] surface write for ${planId} failed: ${err.message}`);
      return false;
    }
  }

  // -- Slack Web API -----------------------------------------------------

  async function slackApi(method, payload) {
    const res = await slackFetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: JSON.stringify(payload),
    });
    const body = await safeJson(res);
    if (!body || body.ok !== true) {
      log.error(`[mercury-slack] Slack API ${method} failed: ${(body && body.error) || res.status}`);
    }
    return body;
  }

  function postMessage(channel, message) {
    if (!channel) return Promise.resolve(undefined);
    return slackApi('chat.postMessage', { channel, ...message });
  }

  function updateMessage(channel, ts, message) {
    if (!channel || !ts) return Promise.resolve(undefined);
    return slackApi('chat.update', { channel, ts, ...message });
  }

  /**
   * Uploads `content` as a Slack text file into the thread of an existing
   * message (the full-truth plan file under the create gate). Uses the
   * CURRENT external-upload flow (`files.upload` is retired):
   *
   *   1. files.getUploadURLExternal — sent as application/x-www-form-urlencoded
   *      via slackFetch directly (not slackApi, which posts JSON). Current
   *      docs (docs.slack.dev, verified 2026-07-10) list BOTH form-encoding
   *      and application/json as accepted for this method; form-encoding is
   *      chosen because it matches the docs' own example and keeps the
   *      deviation self-contained, mirroring how openConnectionUrl already
   *      deviates from slackApi.
   *      `length` is the BYTE length of the utf-8 content (Buffer.byteLength)
   *      — Slack rejects a mismatched length, and JS string .length counts
   *      code units, not bytes (the plan text is full of em-dashes).
   *   2. POST the raw bytes to the returned upload_url (via slackFetch so
   *      tests can intercept).
   *   3. files.completeUploadExternal — accepts JSON, so plain slackApi;
   *      channel_id + thread_ts shares the file into the gate's thread.
   *
   * Requires the `files:write` bot scope — for BOTH Web API calls (steps 1
   * and 3) — AND the bot must be a member of the target channel, or
   * files.completeUploadExternal fails `not_in_channel` (per its docs).
   * Membership is guaranteed here: the same bot just posted the gate
   * message into that channel. NOTE this inference holds only while the
   * app lacks the `chat:write.public` scope — with that scope a PUBLIC-
   * channel chat.postMessage succeeds WITHOUT membership, so a successful
   * gate post would no longer prove the membership this upload needs.
   * Throws on any step's failure — the caller (pollOnce's plan_ready
   * branch) owns graceful degradation.
   */
  async function uploadPlanFile({ channel, threadTs, filename, title, content }) {
    const params = new URLSearchParams({
      filename,
      length: String(Buffer.byteLength(content, 'utf8')),
    });
    const urlRes = await slackFetch('https://slack.com/api/files.getUploadURLExternal', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      },
      body: params.toString(),
    });
    const urlBody = await safeJson(urlRes);
    if (!urlBody || urlBody.ok !== true || !urlBody.upload_url || !urlBody.file_id) {
      throw new Error(`files.getUploadURLExternal failed: ${(urlBody && urlBody.error) || `HTTP ${urlRes.status}`}`);
    }

    const uploadRes = await slackFetch(urlBody.upload_url, { method: 'POST', body: content });
    if (!uploadRes.ok) {
      throw new Error(`upload POST failed: HTTP ${uploadRes.status}`);
    }

    const done = await slackApi('files.completeUploadExternal', {
      files: [{ id: urlBody.file_id, title }],
      channel_id: channel,
      thread_ts: threadTs,
    });
    if (!done || done.ok !== true) {
      throw new Error(`files.completeUploadExternal failed: ${(done && done.error) || 'unknown'}`);
    }
  }

  // -- slash command: `/plan <text>` --------------------------------------

  function buildAck(envelope, payload) {
    if (payload && envelope.accepts_response_payload) {
      return { envelope_id: envelope.envelope_id, payload };
    }
    return { envelope_id: envelope.envelope_id };
  }

  async function handleSlashCommand(envelope, send) {
    const payload = envelope.payload || {};
    const text = String(payload.text || '').trim();
    const requester = payload.user_name || payload.user_id;
    // The stable Slack user id (never the display name) is the only value
    // that renders as a real @-mention downstream. The slash-command
    // payload carries it at `user_id`. Threaded slash → wizard →
    // private_metadata → view_submission → POST /plan as `requester_id`,
    // PARALLEL to `requester` (which still feeds the planner prompt).
    const requesterId = payload.user_id;
    const channel = payload.channel_id;

    // `/plan help|?|h` must NEVER open the wizard. Opening it with "help"
    // prefilled left the user one click on "Plan it" away from burning a real
    // ~$1-2 AI planning run just to read usage. Answer with an EPHEMERAL
    // usage hint via the ack payload (only the invoker sees it —
    // accepts_response_payload is set on slash envelopes) and return.
    // DELIBERATE deviation from the roadmap brief: bare `/plan` (text === '')
    // is NOT intercepted — the empty wizard is the PRIMARY healthy invocation
    // (slack.test.mjs proves that path). Only help/?/h short-circuit.
    if (['help', '?', 'h'].includes(text.toLowerCase())) {
      send(buildAck(envelope, ackPayload(HELP_TEXT)));
      return;
    }

    // Ack the envelope EMPTY within the 3s rule; the wizard is opened via the
    // Web API (views.open), not the ack payload. trigger_id is valid ~3s, so
    // open the modal immediately with no slow work in between.
    send({ envelope_id: envelope.envelope_id });

    const view = buildPlanWizardView({ channel, requester, requesterId, prefillText: text });
    const opened = await slackApi('views.open', { trigger_id: payload.trigger_id, view });
    if (!opened || opened.ok !== true) {
      // views.open already logged the error; nudge the user so a silent
      // failure isn't invisible.
      await postMessage(channel, { text: '⚠️ Could not open the planning form — please try `/plan` again.' });
    }
  }

  // -- interactive view_submission (the wizard's "Plan it") --------------

  // Extracts one wizard radio value from view.state.values with a defensive
  // fallback chain + a MANDATORY stderr trace so selection failures are
  // diagnosable from logs alone. Slack's documented view-state shape for radio_buttons is
  // IDENTICAL to static_select's:
  //   state.values[block_id][action_id] =
  //     { type: 'radio_buttons', selected_option: { text: {…}, value: '…' } }
  // (docs.slack.dev/surfaces/modals — the official view_submission example
  // reads `values[block][action].selected_option.value` off a radio_buttons
  // element.) A block MISSING
  // from state.values entirely is logged loudly and falls back to `fallback`
  // — never a throw (a throw here would eat the submission).
  function extractWizardRadio(values, { blockId, actionId, label, fallback }) {
    const block = (values[blockId] || {})[actionId];
    const raw = block && block.selected_option ? block.selected_option.value : undefined;
    const value = typeof raw === 'string' && raw.length > 0 ? raw : fallback;
    log.error(`[mercury-slack] wizard ${label} extracted: ${raw === undefined ? '(missing)' : raw} (raw block present: ${block ? 'yes' : 'no'}) → using "${value}"`);
    if (!block) {
      log.error(`[mercury-slack] wizard "${blockId}" block MISSING from view.state.values (present keys: ${Object.keys(values).join(', ') || '(none)'}) — falling back to "${fallback}"`);
    }
    return value;
  }

  async function handleViewSubmission(envelope, send) {
    const payload = envelope.payload || {};
    const view = payload.view || {};
    const values = (view.state && view.state.values) || {};
    const description = String(
      (((values.desc || {}).description || {}).value) || '',
    ).trim();
    const outputLanguage = extractWizardRadio(values, { blockId: 'lang', actionId: 'output_language', label: 'language', fallback: 'en' });
    const scopeHint = extractWizardRadio(values, { blockId: 'scope', actionId: 'scope_hint', label: 'scope', fallback: 'auto' });
    // Same defensive extraction + stderr trace as language/scope (FIX 1's
    // diagnosability contract). A missing block falls back to `full` — the
    // safe default: Light must be an explicit choice, never an accident.
    const groundingHint = extractWizardRadio(values, { blockId: 'grounding', actionId: 'grounding_hint', label: 'grounding', fallback: 'full' });

    let meta = {};
    try {
      meta = JSON.parse(view.private_metadata || '{}');
    } catch {
      meta = {};
    }
    const channel = meta.channel;
    const requester = meta.requester
      || (payload.user && (payload.user.username || payload.user.name || payload.user.id))
      || 'someone';
    // Stable id parallel to `requester`. Prefer the value threaded
    // through private_metadata (captured at slash time); fall back to the
    // view_submission payload's own stable id, which Slack carries at
    // `payload.user.id`. Empty string when neither is present — requester_id
    // is OPTIONAL and fail-open (a legacy/foreign metadata blob or a missing
    // user must degrade gracefully, never block the submission).
    const requesterId = meta.requester_id || (payload.user && payload.user.id) || '';

    // Empty description → keep the modal open with an inline error (Slack
    // shows it under the `desc` block). This ack REPLACES the empty ack.
    if (description.length === 0) {
      send({
        envelope_id: envelope.envelope_id,
        payload: { response_action: 'errors', errors: { desc: 'Please describe the work.' } },
      });
      return;
    }

    // Valid → ack empty (closes the modal), then start the plan.
    send({ envelope_id: envelope.envelope_id });

    let res;
    try {
      res = await servicePost('/plan', {
        description,
        requester,
        // Stable @-mention id, parallel to `requester`. Optional and
        // non-validated server-side (fail-open) — a visibility field,
        // not a security control, so a missing/empty id must never block.
        requester_id: requesterId,
        role_lens: 'business',
        output_language: outputLanguage,
        scope_hint: scopeHint,
        grounding_hint: groundingHint,
        // Persist the reply-to surface ON the plan record from
        // the very first write, so a bridge restart at ANY later moment can
        // re-attach this plan to its original channel from the store instead
        // of this process's RAM. Opaque to the service — only this bridge
        // reads it back (resume()).
        ...(channel ? { surface: { type: 'slack', channel } } : {}),
      });
    } catch (err) {
      log.error(`[mercury-slack] POST /plan failed: ${err.message}`);
      await postMessage(channel, { text: `⚠️ Failed to start planning: ${err.message}` });
      return;
    }

    if (!res.ok || !res.body || !res.body.plan_id) {
      const reason = (res.body && res.body.error) || `HTTP ${res.status}`;
      await postMessage(channel, { text: `⚠️ Failed to start planning: ${reason}` });
      return;
    }

    // Instant feedback: post a "Preparing…" placeholder now so the channel is
    // never blank while the agent works. The poller updates THIS message in
    // place into the shape (one message that evolves), so capture its ts.
    const placeholder = await postMessage(channel, preparingMessage({ description, outputLanguage, requesterId }));

    watched.set(res.body.plan_id, {
      channel,
      requester,
      description,
      lastStatus: res.body.status,
      messageTs: placeholder && placeholder.ts ? placeholder.ts : undefined,
      // The placeholder is "unconsumed" until the first real post (shape or a
      // during-phase-1 failure) transforms it in place.
      placeholderActive: Boolean(placeholder && placeholder.ts),
    });

    // Enrich the stored surface with the placeholder's
    // message_ts and plant the INITIAL delivery cursor. `breaking_down` is
    // honest — the placeholder IS this plan's announcement at its starting
    // status — and load-bearing for Window A: without a cursor on file, a
    // bridge that dies before the first real announcement would resume with
    // lastStatus seeded from the plan's CURRENT status (the legacy no-cursor
    // fallback in resume()) and the shape would never post. Best-effort: on
    // failure the plan still runs; its recovery just degrades to the legacy
    // behavior.
    if (channel) {
      await writeSurface(res.body.plan_id, {
        surface: {
          type: 'slack',
          channel,
          ...(placeholder && placeholder.ts ? { message_ts: placeholder.ts } : {}),
        },
        announced_status: 'breaking_down',
      });
    }
  }

  // -- interactive block_actions (button clicks) ------------------------

  async function handleBlockAction(envelope) {
    const payload = envelope.payload || {};
    const action = payload.actions && payload.actions[0];
    if (!action) return;

    const actionId = action.action_id;
    const planId = action.value;
    const channel = payload.channel && payload.channel.id;
    const ts = payload.message && payload.message.ts;
    const originalBlocks = (payload.message && payload.message.blocks) || [];
    const user = (payload.user && (payload.user.user_name || payload.user.username || payload.user.id)) || 'someone';

    if (!planId) {
      log.error(`[mercury-slack] block_action ${actionId} arrived with no plan id value — ignoring`);
      return;
    }

    let res;
    try {
      if (actionId === 'approve_shape') {
        res = await servicePost(`/plan/${planId}/approve-shape`, {});
      } else if (actionId === 'create') {
        res = await servicePost(`/plan/${planId}/create`, {});
      } else if (actionId === 'reject') {
        res = await servicePost(`/plan/${planId}/reject`, { reason: `rejected from Slack by ${user}` });
      } else if (actionId === 'retry') {
        res = await servicePost(`/plan/${planId}/retry`, {});
      } else if (actionId === 'cancel_tree') {
        // Already confirm-guarded on the Slack side (the button carries a
        // `confirm` dialog — this click only arrives after the user
        // confirmed). The service transitions to `cancelling`; the poller
        // posts the eventual `cancelled` / `failed` outcome.
        res = await servicePost(`/plan/${planId}/cancel`, {});
      } else {
        log.error(`[mercury-slack] unknown block_action_id "${actionId}" — ignoring`);
        return;
      }
    } catch (err) {
      log.error(`[mercury-slack] ${actionId} service call failed: ${err.message}`);
      await postMessage(channel, { text: `⚠️ ${actionLabel(actionId)} failed: ${err.message}` });
      return;
    }

    if (res.ok) {
      // Re-capture the channel from THIS click so the poller can post the
      // next stage (grooming→plan_ready, creating→created, retry→shape,
      // cancel_tree→cancelled) even if the watch entry was lost or
      // channel-less after a bridge restart — a created plan's entry is
      // gone (STOP_WATCHING) by the time its Cancel button is clicked, so
      // this re-capture is what lets the poller post the `cancelled`
      // outcome at all. Only `reject` is excluded (terminal, nothing left
      // to post).
      if (actionId !== 'reject') {
        const entry = watched.get(planId) || {};
        watched.set(planId, {
          channel: entry.channel || channel,
          requester: entry.requester || user,
          description: entry.description,
          lastStatus: (res.body && res.body.status) || entry.lastStatus,
          messageTs: entry.messageTs,
          placeholderActive: entry.placeholderActive,
        });
        // The click is a fresh, human-proven reply-to signal —
        // persist it to the STORE too, not just this map (the RAM-only
        // re-capture would otherwise leave a restart-loss gap). A created plan's
        // watch entry is long gone by the time its Cancel button is clicked,
        // and if the bridge restarts between this click and the poller's
        // next post, the store copy is the only thing that lets the outcome
        // reach this channel. Best-effort (writeSurface never throws).
        if (channel) {
          await writeSurface(planId, { surface: { type: 'slack', channel } });
        }
      }
      await updateMessage(channel, ts, replaceActionsWithContext(originalBlocks, clickConfirmText(actionId, user)));
      return;
    }

    if (res.status === 409) {
      const status = (res.body && res.body.status) || 'unknown';
      await updateMessage(channel, ts, replaceActionsWithContext(originalBlocks, `⏳ already ${status}`));
      return;
    }

    // Unknown/finished plan (404) or any other unexpected response: never
    // touch the original message — a lightweight new note is safer than a
    // chat.update that could clobber content for a plan we can't account for.
    const reason = (res.body && res.body.error) || `HTTP ${res.status}`;
    await postMessage(channel, { text: `⚠️ Could not ${actionLabel(actionId).toLowerCase()} — ${reason}` });
  }

  // -- envelope dispatcher -------------------------------------------------

  async function handleEnvelope(envelope, send) {
    if (!envelope || typeof envelope !== 'object') return;
    if (!envelope.envelope_id) return; // hello/disconnect are handled by the frame reader, not here

    if (envelope.type === 'slash_commands') {
      const command = envelope.payload && envelope.payload.command;
      if (command && command !== '/plan') {
        // An unknown/mistyped slash command used to ack empty (a silent
        // no-op that just looked broken). Nudge the user toward the one
        // command that exists — ephemerally (only the invoker sees it, never
        // a channel post).
        send(buildAck(envelope, ackPayload('Mercury only responds to `/plan` — try `/plan help`.')));
        return;
      }
      await handleSlashCommand(envelope, send);
      return;
    }

    if (envelope.type === 'interactive' && envelope.payload) {
      const ptype = envelope.payload.type;
      if (ptype === 'block_actions') {
        send({ envelope_id: envelope.envelope_id }); // ack immediately, no payload
        await handleBlockAction(envelope).catch((err) => {
          log.error(`[mercury-slack] interactive handler error: ${err.message}`);
        });
        return;
      }
      if (ptype === 'view_submission') {
        // handleViewSubmission owns the ack (empty to close, or errors to
        // keep the modal open) — it MUST send within 3s.
        await handleViewSubmission(envelope, send).catch((err) => {
          log.error(`[mercury-slack] view_submission handler error: ${err.message}`);
          send({ envelope_id: envelope.envelope_id });
        });
        return;
      }
    }

    // events_api or anything else this bridge doesn't act on: ack so Slack
    // doesn't retry-storm us, do nothing else.
    send({ envelope_id: envelope.envelope_id });
  }

  // -- poller: GET /plan/{id} for every watched plan, react to status changes

  async function pollOnce() {
    for (const [planId, entry] of [...watched.entries()]) {
      let res;
      try {
        res = await serviceGet(`/plan/${planId}`);
      } catch (err) {
        log.error(`[mercury-slack] poll GET /plan/${planId} failed: ${err.message}`);
        continue;
      }
      if (!res.ok || !res.body) continue;

      const status = res.body.status;
      if (status === entry.lastStatus) continue;

      if (!entry.channel) {
        // No reply-to on file (a legacy or foreign-surface plan — protocol
        // decision 2): advance lastStatus so this warns once per status
        // change instead of on every poll, and never touch the cursor — the
        // client that owns the surface owns the delivery cursor too.
        entry.lastStatus = status;
        log.error(`[mercury-slack] plan ${planId} changed to ${status} but has no Slack channel on file (resumed after a restart) — skipping post`);
        if (STOP_WATCHING_STATUSES.has(status)) watched.delete(planId);
        continue;
      }

      // GET /plan/{id} never returns `description` — carry the one this
      // bridge already knows forward so the message builders can use it.
      const plan = { ...res.body, description: entry.description };

      // Delivery discipline: `announced` records whether THIS
      // status's message actually reached Slack; `silent` marks statuses
      // that post nothing (grooming/creating/cancelling/…). lastStatus — and
      // the durable announced_status cursor — advance only on a delivered
      // announcement (or a silent status), so a failed post is RETRIED on
      // the next poll instead of lost forever, and a bridge restart
      // re-announces exactly what the cursor proves was never delivered.
      let announced = false;
      let silent = false;

      if (status === 'shape_ready') {
        // Transform the "Preparing…" placeholder in place into the shape, so
        // the user sees one message evolve rather than a new post. Falls back
        // to a fresh post if there's no placeholder (e.g. a resumed plan).
        if (entry.placeholderActive && entry.messageTs) {
          const updated = await updateMessage(entry.channel, entry.messageTs, skeletonMessage(plan));
          announced = Boolean(updated && updated.ok);
        } else {
          const posted = await postMessage(entry.channel, skeletonMessage(plan));
          if (posted && posted.ts) entry.messageTs = posted.ts;
          announced = Boolean(posted && posted.ok);
        }
      } else if (status === 'plan_ready') {
        const posted = await postMessage(entry.channel, planReadyMessage(plan));
        if (posted && posted.ts) entry.messageTs = posted.ts;
        // Full-truth leg: attach the complete, untruncated plan text as
        // a file in THIS message's thread (channel stays clean, file visually
        // hangs off the gate). The gate message above always posts first and
        // is never blocked by the upload; any upload failure (missing
        // files:write scope, network, non-ok) degrades to a stderr log plus a
        // visible thread warning — never an exception out of pollOnce.
        if (posted && posted.ts) {
          // The gate itself reached the channel — that IS the announcement.
          // The upload leg's own failure degrades to the thread warning and
          // must not hold the delivery cursor back: re-posting the gate
          // would not fix an upload problem, only duplicate the gate.
          announced = true;
          try {
            await uploadPlanFile({
              channel: entry.channel,
              threadTs: posted.ts,
              filename: `mercury-plan-${String(planId).slice(0, 8)}.txt`,
              title: 'Full plan — read before Create',
              content: renderPlanText(plan),
            });
          } catch (err) {
            log.error(`[mercury-slack] full-plan file upload failed for ${planId}: ${err.message}`);
            // missing_scope is the one failure a re-try can never fix — name
            // the exact scope and who must act, so the warning is actionable
            // instead of a dead generic error. The GET /plan pointer stays in
            // every variant.
            const scopeHint = /missing_scope/.test(String(err.message))
              ? ' — the Slack app is missing the files:write scope — an admin must add it'
              : '';
            await postMessage(entry.channel, {
              thread_ts: posted.ts,
              text: `⚠️ could not attach the full plan file (${err.message})${scopeHint} — full content: GET /plan/${planId}`,
            }).catch((warnErr) => {
              log.error(`[mercury-slack] could not post the upload-failure thread warning for ${planId}: ${warnErr.message}`);
            });
          }
        } else {
          // The gate post itself failed (invalid_blocks, msg_too_long,
          // channel gone…): without a fallback the plan stalls at plan_ready
          // with NOTHING visible in the channel — post a minimal plain-text
          // pointer instead. Best-effort and .catch-guarded: a fallback
          // failure (likely, if the channel itself is the problem) must
          // never take down the poller.
          const reason = (posted && posted.error) || 'no ok/ts from chat.postMessage';
          log.error(`[mercury-slack] plan ${planId} plan_ready message returned no ts (${reason}) — skipping the full-plan file upload`);
          const fallback = await postMessage(entry.channel, {
            text: `⚠️ plan ${planId} is ready for review but its gate message could not be rendered (${reason}) — full content: GET /plan/${planId} on the service host.`,
          }).catch((fallbackErr) => {
            log.error(`[mercury-slack] could not post the plan_ready fallback for ${planId}: ${fallbackErr.message}`);
            return undefined;
          });
          // A DELIVERED fallback counts as the (degraded) announcement: a
          // gate that fails deterministically (invalid_blocks) would
          // otherwise re-post this same fallback on every poll, forever.
          // Only when even the fallback failed (channel gone?) does the plan
          // stay un-announced, so the next poll retries the whole branch.
          announced = Boolean(fallback && fallback.ok);
        }
      } else if (status === 'created') {
        const posted = await postMessage(entry.channel, createdMessage(plan));
        announced = Boolean(posted && posted.ok);
      } else if (status === 'cancelled') {
        // Success-of-cancel gets its own 🚫 message — never the ⚠️
        // terminalMessage (it is deliberately not in
        // TERMINAL_NON_SUCCESS_STATUSES). `cancelling` itself posts nothing
        // (a worker is running — same silence as `creating`/`grooming`):
        // it matches no branch here and advances lastStatus via the `silent`
        // path below, so the eventual cancelled/failed still reads as a
        // change.
        const posted = await postMessage(entry.channel, cancelledMessage(plan));
        announced = Boolean(posted && posted.ok);
      } else if (TERMINAL_NON_SUCCESS_STATUSES.has(status)) {
        // A failure DURING phase 1 (the placeholder is still unconsumed) →
        // transform the placeholder into the ⚠️ message so no stale
        // "Preparing…" lingers. Any later failure posts a fresh message.
        if (entry.placeholderActive && entry.messageTs) {
          const updated = await updateMessage(entry.channel, entry.messageTs, terminalMessage(plan));
          announced = Boolean(updated && updated.ok);
        } else {
          const posted = await postMessage(entry.channel, terminalMessage(plan));
          announced = Boolean(posted && posted.ok);
        }
      } else {
        // Transient statuses (breaking_down/grooming/creating/cancelling)
        // post nothing — there is nothing to deliver.
        silent = true;
      }

      if (silent) {
        // Advance the in-RAM marker only. The durable cursor deliberately
        // does NOT move: it records the last status a human actually SAW,
        // and a silent status shows nothing.
        entry.lastStatus = status;
      } else if (announced) {
        // Advance the DURABLE cursor first, RAM second — RAM mirrors the
        // store. Best-effort by design: if the cursor write fails, lastStatus
        // stays behind, so the next poll RE-ANNOUNCES (a duplicate Slack
        // message) and re-attempts the write — a visible duplicate is the
        // acceptable cost of never silently losing an announcement across
        // the restart window. The placeholder flag
        // flips together with lastStatus so a retried shape lands as a
        // chat.update of the same message, not a duplicate post.
        const cursorOk = await writeSurface(planId, { announced_status: status });
        if (cursorOk) {
          entry.lastStatus = status;
          entry.placeholderActive = false;
        }
      }
      // Neither silent nor announced: the post itself failed — lastStatus
      // and the cursor both stay put, and the next poll retries. That is
      // what makes Window-B-style losses self-heal instead of vanishing.

      // RACE GUARD: during the awaited post above (most acutely the
      // createdMessage), a cancel_tree click can land and re-capture this
      // plan into `watched` as a FRESH entry (handleBlockAction sets a new
      // object with lastStatus 'cancelling'). An unconditional delete here
      // would destroy that entry and the eventual 🚫 cancelled outcome
      // would never post. Only delete when the live map entry is still the
      // one this iteration advanced — its lastStatus matches the status
      // just handled; a re-captured entry's 'cancelling' ≠ 'created' keeps
      // it alive.
      const live = watched.get(planId);
      if (STOP_WATCHING_STATUSES.has(status) && live && live.lastStatus === status) watched.delete(planId);
    }
  }

  // -- boot resume: GET /plans -> re-watch from the DURABLE store ---------

  async function resume() {
    let res;
    try {
      res = await serviceGet('/plans');
    } catch (err) {
      log.error(`[mercury-slack] boot-resume GET /plans failed: ${err.message}`);
      return;
    }
    if (!res.ok || !res.body || !Array.isArray(res.body.plans)) return;

    for (const p of res.body.plans) {
      // The store — not the previous process's RAM — is the
      // recovery source. A plan whose surface descriptor says slack
      // re-attaches to its ORIGINAL channel (Window A); its lastStatus seeds
      // from the announced_status delivery cursor, so anything it reached
      // while the bridge was down is announced on the first poll (Window B).
      // The descriptor is opaque to the SERVICE; this bridge understands
      // only its own {type:'slack'} shape and leaves anything else (legacy
      // plans, a future dashboard's descriptor) channel-less — protocol
      // decision 2's warn-and-skip still owns those.
      const surface = p.surface && typeof p.surface === 'object' ? p.surface : undefined;
      // The channel must be a NON-EMPTY STRING before this bridge will post
      // to it: the descriptor is opaque client-owned data on the store, so a
      // poisoned surface ({channel: 42} / {channel: {…}}) must degrade to
      // the legacy channel-less path (warn-and-skip), never ride into
      // chat.postMessage as garbage on every poll.
      const channel = surface && surface.type === 'slack'
        && typeof surface.channel === 'string' && surface.channel.length > 0
        ? surface.channel
        : undefined;
      const cursor = typeof p.announced_status === 'string' && p.announced_status.length > 0 ? p.announced_status : undefined;

      // Watch-terminal skip, made cursor-aware. STOP_WATCHING semantics are
      // preserved: a plan already ANNOUNCED at a watch-terminal status
      // (cursor === current status) is done — re-watching it would poll
      // forever with nothing left to post. But a plan whose CURRENT status
      // is watch-terminal while its CURSOR is behind reached that status
      // with the bridge down (Window B) — it is watched once more so the
      // first poll can deliver the final message: created/rejected/cancelled
      // all flow through the normal pollOnce branches and then drop out via
      // the stop-watching delete. The retryable non-watch-terminal statuses
      // (failed/budget_blocked) never hit this skip and re-watch as always —
      // an un-announced failure gets its ⚠️+Retry on the first poll, an
      // announced one just sits watched with nothing to repost. A legacy
      // plan (no cursor) cannot prove what was announced; assume the current
      // status was — exactly the pre-Step-1 behavior, never a duplicate.
      const announcedAtCurrent = cursor ? cursor === p.status : true;
      if (STOP_WATCHING_STATUSES.has(p.status) && announcedAtCurrent) continue;

      watched.set(p.plan_id, {
        channel,
        requester: undefined,
        description: p.description,
        // The cursor is what the humans actually SAW. Falling back to the
        // CURRENT status happens ONLY for legacy cursor-less plans — which
        // therefore never re-announce (the pre-Step-1 behavior, kept
        // deliberately quiet rather than risking duplicate posts).
        lastStatus: cursor || p.status,
        messageTs: undefined,
        // A resumed plan has no live placeholder to transform — even when
        // the stored surface carries a message_ts, that message is a
        // consumed or stale fossil; announcements post fresh.
        placeholderActive: false,
      });
    }
  }

  // -- Socket Mode connection lifecycle ------------------------------------

  async function openConnectionUrl() {
    // NO request body. An empty-string body ('') with a form content-type makes
    // undici (Node's fetch) hang and return 408 "stream timeout" on some
    // networks — apps.connections.open takes no parameters, so omit the body
    // (and the content-type) entirely. Proven: with `body:''` → 408; without → 200.
    const res = await slackFetch('https://slack.com/api/apps.connections.open', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_APP_TOKEN}`,
      },
    });
    const body = await safeJson(res);
    return { ok: Boolean(body && body.ok), url: body && body.url, error: body && body.error };
  }

  function scheduleReconnect({ immediate = false } = {}) {
    if (stopped || reconnectScheduled) return;
    reconnectScheduled = true;
    const delay = immediate ? 0 : reconnectDelay;
    setTimeout(() => {
      reconnectScheduled = false;
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
      openSocket().catch((err) => log.error(`[mercury-slack] reconnect attempt failed: ${err.message}`));
    }, delay);
  }

  async function handleFrame(raw, socket) {
    let envelope;
    try {
      envelope = JSON.parse(raw);
    } catch {
      log.error('[mercury-slack] received a non-JSON frame — ignoring');
      return;
    }
    if (!envelope || typeof envelope !== 'object') return;

    if (envelope.type === 'hello') {
      log.error('[mercury-slack] Socket Mode connection established');
      return;
    }
    if (envelope.type === 'disconnect') {
      log.error(`[mercury-slack] Slack requested a disconnect (${envelope.reason || 'unknown reason'}) — opening a fresh connection`);
      scheduleReconnect({ immediate: true });
      return;
    }

    await handleEnvelope(envelope, (ack) => {
      try {
        socket.send(JSON.stringify(ack));
      } catch (err) {
        log.error(`[mercury-slack] failed to send envelope ack: ${err.message}`);
      }
    });
  }

  async function openSocket() {
    if (stopped) return;
    if (typeof connect !== 'function') {
      throw new Error('createBridge({ connect }) is required to open a Socket Mode connection');
    }

    const opened = await openConnectionUrl();
    if (!opened.ok || !opened.url) {
      log.error(`[mercury-slack] apps.connections.open failed: ${opened.error || 'no url returned'}`);
      scheduleReconnect();
      return;
    }

    const socket = connect(opened.url);
    const previous = ws;
    ws = socket;

    socket.addEventListener('open', () => {
      reconnectDelay = RECONNECT_BASE_MS; // reset backoff on a successful connect
    });
    socket.addEventListener('message', (event) => {
      handleFrame(String(event.data), socket).catch((err) => log.error(`[mercury-slack] frame handling error: ${err.message}`));
    });
    socket.addEventListener('close', () => {
      if (ws === socket) scheduleReconnect();
    });
    socket.addEventListener('error', (event) => {
      log.error(`[mercury-slack] socket error: ${(event && event.message) || 'unknown'}`);
    });

    // Open-then-close (never the reverse), so a disconnect frame can never
    // leave the bridge with zero live connections in between.
    if (previous && previous !== socket) {
      try {
        previous.close();
      } catch {
        // already closing/closed — nothing to do
      }
    }
  }

  // -- public surface ----------------------------------------------------

  return {
    handleEnvelope,
    pollOnce,
    resume,
    watched,
    async start() {
      await resume();
      // Reentrancy guard: pollOnce AWAITS its Slack posts, so one slow post
      // can outlive the poll interval — an overlapping tick would re-read a
      // lastStatus that has not advanced yet and double-post the same
      // transition (reviewer-proven regression). `polling` guards TICK
      // OVERLAP within this process; duplicate announcements across
      // RESTARTS are guarded by the durable delivered-cursor discipline
      // (announced_status via writeSurface), not by this flag.
      let polling = false;
      pollTimer = setInterval(() => {
        if (polling) return;
        polling = true;
        pollOnce()
          .catch((err) => log.error(`[mercury-slack] poll error: ${err.message}`))
          .finally(() => { polling = false; });
      }, pollMs);
      await openSocket();
    },
    stop() {
      stopped = true;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      if (ws) {
        try {
          ws.close();
        } catch {
          // already closed
        }
        ws = null;
      }
    },
  };
}

// -- auto-start when run directly: `node service/slack.mjs` -----------------

async function main() {
  let bridge;
  try {
    bridge = createBridge({ env: process.env, log: console });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[mercury-slack] ${err.message} — exiting.`);
    process.exit(1);
    return;
  }
  await bridge.start();
  // eslint-disable-next-line no-console
  console.error(`[mercury-slack] bridge started (service=${process.env.MERCURY_SERVICE_URL || DEFAULT_SERVICE_URL})`);
}

const isMain = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMain) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(`[mercury-slack] fatal: ${err.message}`);
    process.exit(1);
  });
}
