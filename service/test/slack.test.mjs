// slack.test.mjs — zero-network tests for the Slack Socket Mode bridge.
//
// Every test here uses simple recorded-calls fake `serviceFetch`/`slackFetch`
// functions (see makeRecordingFetch/fakeResponse below) — no real sockets,
// no real HTTP, matching slack.mjs's testability split (pure blocks in
// slack-blocks.mjs, protocol/IO dispatch tested here against fakes). These
// tests drive `handleEnvelope`, `pollOnce`, and `resume` directly, exactly
// as slack.mjs exposes them for this purpose — with ONE deliberate
// exception: the poller-reentrancy test calls `start()` (against a fake
// `connect` and a real short interval), because the tick-overlap guard
// lives in start()'s setInterval closure and nowhere else.

import test from 'node:test';
import assert from 'node:assert/strict';
import { createBridge } from '../slack.mjs';
import { ackPayload, renderSkeletonTree, skeletonMessage, planReadyMessage, createdMessage, cancelledMessage, terminalMessage, replaceActionsWithContext, preparingMessage, requesterAttributionLine } from '../slack-blocks.mjs';

const FAKE_ENV = { SLACK_APP_TOKEN: 'xapp-test-token', SLACK_BOT_TOKEN: 'xoxb-test-token' };
const SILENT_LOG = { error() {}, log() {} };

function fakeResponse(status, body) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  };
}

/** Records every call ({url, method, body}) and delegates to `responder`. */
function makeRecordingFetch(responder) {
  const calls = [];
  async function fn(url, options = {}) {
    const record = { url: String(url), method: options.method || 'GET', headers: options.headers || {}, body: options.body };
    calls.push(record);
    return responder(record, calls.length - 1);
  }
  fn.calls = calls;
  return fn;
}

function jsonCalls(fetchFn, methodFilter = 'POST') {
  return fetchFn.calls
    .filter((c) => c.method === methodFilter && typeof c.body === 'string')
    .flatMap((c) => {
      // The content-visible gate file-upload leg POSTs RAW plan text (not JSON) to the
      // upload_url — skip non-JSON bodies instead of crashing the helper.
      try {
        return [{ url: c.url, body: JSON.parse(c.body) }];
      } catch {
        return [];
      }
    });
}

// ---------------------------------------------------------------------------
// createBridge construction
// ---------------------------------------------------------------------------

test('createBridge throws a clear error when SLACK_APP_TOKEN or SLACK_BOT_TOKEN is missing', () => {
  const noopFetch = async () => fakeResponse(200, {});
  assert.throws(
    () => createBridge({ serviceFetch: noopFetch, slackFetch: noopFetch, env: {} }),
    /SLACK_APP_TOKEN/,
  );
  assert.throws(
    () => createBridge({ serviceFetch: noopFetch, slackFetch: noopFetch, env: { SLACK_APP_TOKEN: 'xapp-1' } }),
    /SLACK_BOT_TOKEN/,
  );
  assert.doesNotThrow(() => createBridge({ serviceFetch: noopFetch, slackFetch: noopFetch, env: FAKE_ENV }));
});

// ---------------------------------------------------------------------------
// envelope dispatch: slash commands
// ---------------------------------------------------------------------------

// Extract the single views.open call's {trigger_id, view} from slackFetch.
function viewsOpenCall(slackFetch) {
  const call = slackFetch.calls.find((c) => c.url.endsWith('/views.open'));
  return call ? JSON.parse(call.body) : undefined;
}

test('envelope dispatch: /plan <text> acks empty immediately and opens the wizard modal pre-filled', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, { error: 'service must not be called before submit' }));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'env-1',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: 'add a widget to the dashboard', channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 'trig-1' },
    },
    (ack) => acks.push(ack),
  );

  // Empty ack (the modal is opened via the Web API, not the ack payload).
  assert.equal(acks.length, 1);
  assert.equal(acks[0].envelope_id, 'env-1');
  assert.equal(acks[0].payload, undefined, 'the slash ack must be empty — the modal is opened via views.open');

  const opened = viewsOpenCall(slackFetch);
  assert.ok(opened, 'views.open must be called');
  assert.equal(opened.trigger_id, 'trig-1');
  assert.equal(opened.view.callback_id, 'plan_wizard');
  const meta = JSON.parse(opened.view.private_metadata);
  assert.equal(meta.channel, 'C100', 'the channel must ride through private_metadata');
  assert.equal(meta.requester, 'test-requester');
  // C0: the STABLE user id rides through parallel to the display name.
  assert.equal(meta.requester_id, 'U1', 'the stable user id (user_id) threads into private_metadata as requester_id');
  // Description pre-filled from the slash text.
  const descBlock = opened.view.blocks.find((b) => b.block_id === 'desc');
  assert.equal(descBlock.element.initial_value, 'add a widget to the dashboard');
  // No plan started, nothing watched yet — that happens on submit.
  assert.equal(serviceFetch.calls.length, 0, 'the service must not be called until the wizard is submitted');
  assert.equal(bridge.watched.size, 0);
});

test('wizard view: language is a TWO-option radio (en initial, tr) — "both" is gone from the UI; scope is a FOUR-option radio (auto initial)', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(
    {
      envelope_id: 'env-wiz',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: '', channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 'trig-w' },
    },
    () => {},
  );

  const opened = viewsOpenCall(slackFetch);
  assert.ok(opened, 'views.open must be called');

  // FIX 1 (2026-07-10): the language leg is rebuilt as radio_buttons — the
  // static_select value was not reliably reaching the POST in the live
  // pilot — with EXACTLY two options; "both" is a product removal from the
  // UI (the API still accepts it for direct callers).
  const langBlock = opened.view.blocks.find((b) => b.block_id === 'lang');
  assert.equal(langBlock.element.type, 'radio_buttons');
  assert.equal(langBlock.element.action_id, 'output_language', 'the action_id is unchanged');
  assert.deepEqual(langBlock.element.options.map((o) => o.value), ['en', 'tr'], 'exactly two options, en then tr');
  assert.equal(langBlock.element.initial_option.value, 'en', 'English is the initial option');
  assert.equal(JSON.stringify(opened.view).includes('"both"'), false, 'no "both" value anywhere in the wizard');

  // FIX 2 (2026-07-10): the scope control — the requester owns the
  // epic-ization decision.
  const scopeBlock = opened.view.blocks.find((b) => b.block_id === 'scope');
  assert.ok(scopeBlock, 'the scope input block must exist');
  assert.equal(scopeBlock.label.text, 'How big is this?');
  assert.equal(scopeBlock.element.type, 'radio_buttons');
  assert.equal(scopeBlock.element.action_id, 'scope_hint');
  assert.deepEqual(scopeBlock.element.options.map((o) => o.value), ['auto', 'single', 'small', 'epic']);
  assert.equal(scopeBlock.element.initial_option.value, 'auto', 'Let Radsvinn judge is the default');
});

test('envelope dispatch: bare /plan (no text) still opens the wizard, without a pre-fill', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'env-2',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: '   ', channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 'trig-2' },
    },
    (ack) => acks.push(ack),
  );

  assert.equal(acks[0].payload, undefined);
  const opened = viewsOpenCall(slackFetch);
  assert.ok(opened, 'views.open must be called even with empty text');
  const descBlock = opened.view.blocks.find((b) => b.block_id === 'desc');
  assert.equal(descBlock.element.initial_value, undefined, 'no pre-fill when there was no text');
  assert.equal(serviceFetch.calls.length, 0);
});

test('C0: requester_id threads slash -> wizard private_metadata -> view_submission -> POST /plan', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-00000000000c', status: 'breaking_down' });
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '1.1', channel: 'C100' }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  // Slash: the stable user_id must land in private_metadata as requester_id.
  await bridge.handleEnvelope(
    {
      envelope_id: 'c0-slash',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: 'do the thing', channel_id: 'C100', user_id: 'U777', user_name: 'test-requester', trigger_id: 'trig-c0' },
    },
    () => {},
  );
  const opened = viewsOpenCall(slackFetch);
  assert.equal(JSON.parse(opened.view.private_metadata).requester_id, 'U777', 'user_id rides into private_metadata');

  // Submit the SAME private_metadata Slack echoes back -> POST /plan carries it.
  await bridge.handleEnvelope(
    {
      envelope_id: 'c0-submit',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester', id: 'U777' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: opened.view.private_metadata,
          state: { values: { lang: { output_language: { selected_option: { value: 'en' } } }, desc: { description: { value: 'do the thing' } } } },
        },
      },
    },
    () => {},
  );
  const posts = jsonCalls(serviceFetch).filter((c) => c.url.endsWith('/plan'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.requester_id, 'U777', 'the stable id reaches POST /plan parallel to requester');
  assert.equal(posts[0].body.requester, 'test-requester', 'the display-name requester is untouched');
});

test('C0 adversarial: handleViewSubmission with NEITHER private_metadata.requester_id NOR payload.user.id -> "" (never throws)', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-00000000000d', status: 'breaking_down' });
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await assert.doesNotReject(() => bridge.handleEnvelope(
    {
      envelope_id: 'c0-neither',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        // No `id` field on payload.user at all — the fallback chain's SECOND
        // link is also absent, not just the first.
        user: { username: 'test-requester' },
        view: {
          callback_id: 'plan_wizard',
          // No requester_id in private_metadata either (a legacy/foreign
          // metadata blob).
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: { values: { lang: { output_language: { selected_option: { value: 'en' } } }, desc: { description: { value: 'do a thing' } } } },
        },
      },
    },
    () => {},
  ));

  const posts = jsonCalls(serviceFetch).filter((c) => c.url.endsWith('/plan'));
  assert.equal(posts.length, 1, 'the submission still starts a plan even with no id anywhere');
  assert.equal(posts[0].body.requester_id, '', 'both fallback links are absent -> degrades to empty string, never a throw');
});

test('C0 adversarial: private_metadata with a NON-STRING requester_id (poisoned/legacy) falls back to payload.user.id, not the junk value', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-00000000000f', status: 'breaking_down' });
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await assert.doesNotReject(() => bridge.handleEnvelope(
    {
      envelope_id: 'c0-poisoned-meta',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester', id: 'U-real' },
        view: {
          callback_id: 'plan_wizard',
          // A truthy but non-string requester_id (e.g. tampered/legacy JSON) —
          // `meta.requester_id || fallback` treats any truthy value as "use
          // this", so a non-string here rides straight through un-degraded.
          // This test PINS the current fallback-chain behavior rather than
          // asserting an opinion about it — see the report for the nuance.
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester', requester_id: 42 }),
          state: { values: { lang: { output_language: { selected_option: { value: 'en' } } }, desc: { description: { value: 'do a thing' } } } },
        },
      },
    },
    () => {},
  ));

  const posts = jsonCalls(serviceFetch).filter((c) => c.url.endsWith('/plan'));
  assert.equal(posts.length, 1);
  // `meta.requester_id || (payload.user && payload.user.id) || ''` — a
  // truthy 42 short-circuits the `||` chain, so it rides through as a NUMBER
  // rather than falling back to the string 'U-real'. Server-side this still
  // fails open (typeof body.requester_id === 'string' ? … : '' degrades it
  // to '' — see http-e2e.test.mjs's object/null coverage), but the bridge
  // itself does not coerce or validate before the POST.
  assert.equal(posts[0].body.requester_id, 42, 'a truthy non-string requester_id in metadata rides through un-degraded (fail-open is enforced server-side, not here)');
});

test('C1: /plan help|?|h -> ephemeral usage hint, wizard NOT opened (the cost trap is closed)', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  for (const text of ['help', 'HELP', '?', 'h']) {
    const acks = [];
    await bridge.handleEnvelope(
      {
        envelope_id: `help-${text}`,
        type: 'slash_commands',
        accepts_response_payload: true,
        payload: { command: '/plan', text, channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 't' },
      },
      (ack) => acks.push(ack),
    );
    assert.equal(acks.length, 1);
    assert.ok(acks[0].payload, `"${text}" must get an ephemeral hint payload`);
    assert.equal(acks[0].payload.response_type, 'ephemeral');
    assert.match(acks[0].payload.text, /costs money/i, 'the cost warning is the load-bearing line');
  }
  // The whole point: help must NEVER open the wizard (no views.open) and never
  // touch the paid service.
  assert.equal(slackFetch.calls.some((c) => c.url.endsWith('/views.open')), false, 'help must not open the wizard');
  assert.equal(serviceFetch.calls.length, 0, 'help never touches the service');
});

test('C1 deviation: bare /plan (empty text) STILL opens the wizard — help interception must not regress the primary path (slack.test.mjs:82)', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'bare',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: '', channel_id: 'C100', user_id: 'U1', trigger_id: 't' },
    },
    (ack) => acks.push(ack),
  );
  assert.equal(acks[0].payload, undefined, 'bare /plan acks EMPTY and opens the wizard, NOT an ephemeral hint');
  assert.ok(viewsOpenCall(slackFetch), 'the wizard opens for bare /plan — the primary healthy invocation');
});

test('C1 adversarial: "Help" (mixed case) also intercepts — the case-insensitive match covers more than just all-lower/all-upper', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'help-mixed',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: 'Help', channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 't' },
    },
    (ack) => acks.push(ack),
  );
  assert.ok(acks[0].payload, '"Help" (mixed case) must get the ephemeral hint');
  assert.equal(acks[0].payload.response_type, 'ephemeral');
  assert.equal(slackFetch.calls.some((c) => c.url.endsWith('/views.open')), false, '"Help" must not open the wizard');
});

test('C1 adversarial: "/plan help me plan the invoice page" is NOT intercepted — only an EXACT help/?/h short-circuits, never a prefix', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'prefix-help',
      type: 'slash_commands',
      accepts_response_payload: true,
      payload: { command: '/plan', text: 'help me plan the invoice page', channel_id: 'C100', user_id: 'U1', user_name: 'test-requester', trigger_id: 'trig-p' },
    },
    (ack) => acks.push(ack),
  );

  assert.equal(acks[0].payload, undefined, 'a "help ..." prefix must NOT get the ephemeral hint — it is not an exact help/?/h match');
  const opened = viewsOpenCall(slackFetch);
  assert.ok(opened, 'the wizard opens for a "help ..." prefix, exactly like any other free-text ask');
  const descBlock = opened.view.blocks.find((b) => b.block_id === 'desc');
  assert.equal(descBlock.element.initial_value, 'help me plan the invoice page', 'the whole text is preserved as the pre-fill — never swallowed by the intercept');
  assert.equal(serviceFetch.calls.length, 0, 'no service call yet — only submit starts a plan');
});

test('view_submission: tr radio + single scope -> POST /plan carries output_language AND scope_hint, watch registered from private_metadata', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') {
      return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-000000000001', status: 'breaking_down' });
    }
    return fakeResponse(404, { error: 'unexpected' });
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const logged = [];
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: { error: (m) => logged.push(String(m)) } });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'sub-1',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester', id: 'U1' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: {
            // The DOCUMENTED radio_buttons view-state shape — identical to
            // static_select's: { type, selected_option: { value } }
            // (docs.slack.dev/surfaces/modals view_submission example).
            values: {
              lang: { output_language: { type: 'radio_buttons', selected_option: { value: 'tr' } } },
              scope: { scope_hint: { type: 'radio_buttons', selected_option: { value: 'single' } } },
              desc: { description: { value: 'kullanıcı geçmişini arama' } },
            },
          },
        },
      },
    },
    (ack) => acks.push(ack),
  );

  // Empty ack closes the modal (no response_action).
  assert.equal(acks.length, 1);
  assert.equal(acks[0].envelope_id, 'sub-1');
  assert.equal(acks[0].payload, undefined, 'a valid submission acks empty to close the modal');

  // Filtered to the plan-creation POST — the submit flow now ALSO fires a
  // best-effort POST /plan/{id}/surface, asserted below.
  const posts = jsonCalls(serviceFetch).filter((c) => c.url.endsWith('/plan'));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].body.description, 'kullanıcı geçmişini arama');
  assert.equal(posts[0].body.requester, 'test-requester');
  assert.equal(posts[0].body.role_lens, 'business');
  assert.equal(posts[0].body.output_language, 'tr', 'the selected language must reach the service');
  assert.equal(posts[0].body.scope_hint, 'single', 'the selected scope must reach the service');
  // C0: this metadata lacks requester_id (a legacy modal), so it falls back
  // to the view_submission payload's own stable id (payload.user.id = 'U1').
  assert.equal(posts[0].body.requester_id, 'U1', 'requester_id falls back to payload.user.id when metadata lacks it');
  // The reply-to surface rides the very first write, so a
  // bridge restart at any later moment recovers the channel from the store.
  assert.deepEqual(posts[0].body.surface, { type: 'slack', channel: 'C100' }, 'POST /plan must carry the slack surface descriptor');

  // FIX 1's diagnosability contract: the raw extracted value is on stderr,
  // so the next live language mismatch is diagnosable from logs alone.
  assert.ok(
    logged.some((l) => /wizard language extracted: tr \(raw block present: yes\)/.test(l)),
    `the raw language extraction must be logged — got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    logged.some((l) => /wizard scope extracted: single \(raw block present: yes\)/.test(l)),
    'the raw scope extraction must be logged',
  );

  const entry = bridge.watched.get('aaaaaaaa-0000-4000-8000-000000000001');
  assert.ok(entry);
  assert.equal(entry.channel, 'C100', 'channel recovered from private_metadata');
  assert.equal(entry.description, 'kullanıcı geçmişini arama');
});

test('view_submission: lang/scope blocks MISSING from state.values -> en/auto fallbacks, LOUD stderr log, no throw', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') {
      return fakeResponse(202, { plan_id: 'aaaaaaaa-0000-4000-8000-000000000002', status: 'breaking_down' });
    }
    return fakeResponse(404, { error: 'unexpected' });
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const logged = [];
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: { error: (m) => logged.push(String(m)) } });

  // Pathological state: values carries the
  // description but NO lang/scope blocks at all.
  await assert.doesNotReject(() => bridge.handleEnvelope(
    {
      envelope_id: 'sub-missing',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: { values: { desc: { description: { value: 'add a thing' } } } },
        },
      },
    },
    () => {},
  ));

  const posts = jsonCalls(serviceFetch).filter((c) => c.url.endsWith('/plan'));
  assert.equal(posts.length, 1, 'the submission still starts a plan');
  assert.equal(posts[0].body.output_language, 'en', 'missing lang block falls back to en');
  assert.equal(posts[0].body.scope_hint, 'auto', 'missing scope block falls back to auto');

  assert.ok(
    logged.some((l) => /wizard language extracted: \(missing\) \(raw block present: no\)/.test(l)),
    `the missing extraction must be logged — got: ${JSON.stringify(logged)}`,
  );
  assert.ok(
    logged.some((l) => /"lang" block MISSING from view\.state\.values/.test(l)),
    'the missing lang block must be logged loudly',
  );
  assert.ok(
    logged.some((l) => /"scope" block MISSING from view\.state\.values/.test(l)),
    'the missing scope block must be logged loudly',
  );
});

test('view_submission: empty description -> response_action errors, keeps the modal open, no POST', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    {
      envelope_id: 'sub-2',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: { values: { lang: { output_language: { selected_option: { value: 'en' } } }, desc: { description: { value: '   ' } } } },
        },
      },
    },
    (ack) => acks.push(ack),
  );

  assert.equal(acks.length, 1);
  assert.equal(acks[0].payload.response_action, 'errors');
  assert.ok(acks[0].payload.errors.desc, 'the error must be attached to the desc block');
  assert.equal(serviceFetch.calls.length, 0, 'an empty description must never reach the service');
  assert.equal(bridge.watched.size, 0);
});

test('UX: submit posts a "Preparing…" placeholder, then shape_ready updates it in place (no blank wait, no second message)', async () => {
  const planId = 'aaaaaaaa-0000-4000-8000-00000000000a';
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan') && call.method === 'POST') return fakeResponse(202, { plan_id: planId, status: 'breaking_down' });
    if (call.url.endsWith(`/plan/${planId}`)) return fakeResponse(200, { plan_id: planId, status: 'shape_ready', skeleton: { items: [{ temp_id: 'i1', type: 'Story', one_line_summary: 'do the thing' }] }, skeleton_gate: { ok: true }, cost_usd: 1.4 });
    return fakeResponse(404, {});
  });
  // Slack fake returns a ts so the placeholder is "active".
  const slackFetch = makeRecordingFetch((call) => fakeResponse(200, { ok: true, ts: '1700000009.000009', channel: 'C100' }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(
    {
      envelope_id: 'sub-3',
      type: 'interactive',
      payload: {
        type: 'view_submission',
        user: { username: 'test-requester' },
        view: {
          callback_id: 'plan_wizard',
          private_metadata: JSON.stringify({ channel: 'C100', requester: 'test-requester' }),
          state: { values: { lang: { output_language: { selected_option: { value: 'en' } } }, desc: { description: { value: 'add a thing' } } } },
        },
      },
    },
    () => {},
  );

  // A placeholder chat.postMessage went out immediately.
  const placeholderPosts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(placeholderPosts.length, 1, 'exactly one placeholder message posts on submit');
  assert.match(placeholderPosts[0].body.blocks[0].text.text, /Preparing/);
  assert.equal(bridge.watched.get(planId).messageTs, '1700000009.000009', 'the placeholder ts is tracked');

  // shape_ready → the placeholder is UPDATED in place, not re-posted.
  await bridge.pollOnce();
  const posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  const updates = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.update'));
  assert.equal(posts.length, 1, 'still just the one placeholder post — no second message for the shape');
  assert.equal(updates.length, 1, 'the shape arrives as a chat.update of the placeholder');
  assert.equal(updates[0].body.ts, '1700000009.000009');
  assert.match(updates[0].body.blocks[0].text.text, /Proposed plan/);
});

test('envelope dispatch: a non-/plan slash command gets an ephemeral "only /plan exists" hint (C1), never a channel post', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(
    { envelope_id: 'env-4', type: 'slash_commands', accepts_response_payload: true, payload: { command: '/other', text: 'x' } },
    (ack) => acks.push(ack),
  );

  // C1: the silent no-op is upgraded to an ephemeral nudge — visible ONLY to
  // the invoker (response_type ephemeral), never a chat.postMessage.
  assert.equal(acks.length, 1);
  assert.ok(acks[0].payload, 'an unknown command now gets an ephemeral hint payload');
  assert.equal(acks[0].payload.response_type, 'ephemeral');
  assert.match(acks[0].payload.text, /\/plan/, 'the hint points at the one command that exists');
  assert.equal(serviceFetch.calls.length, 0);
  assert.equal(slackFetch.calls.length, 0, 'the hint rides the ack — no chat.postMessage / channel post');
});

// ---------------------------------------------------------------------------
// envelope dispatch: interactive block_actions
// ---------------------------------------------------------------------------

function interactiveEnvelope(actionId, extra = {}) {
  return {
    envelope_id: 'env-interactive',
    type: 'interactive',
    payload: {
      type: 'block_actions',
      actions: [{ action_id: actionId, value: 'PLAN-ID' }],
      channel: { id: 'C200' },
      message: {
        ts: '1720000000.000100',
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: 'keep this block' } },
          { type: 'actions', elements: [{ type: 'button' }] },
        ],
      },
      user: { user_name: 'test-requester' },
      ...extra,
    },
  };
}

test('envelope dispatch: interactive click acks immediately with no payload', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(202, { status: 'grooming' }));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope(interactiveEnvelope('approve_shape'), (ack) => acks.push(ack));

  assert.equal(acks.length, 1);
  assert.deepEqual(acks[0], { envelope_id: 'env-interactive' });
});

for (const [actionId, expectedSuffix, expectedStatus, expectedConfirm] of [
  // C2: the confirm string now names what happens next — approve → "grooming
  // now", create → "writing to Jira now" — so the two most expensive phases
  // don't read as stalled. reject is terminal: no "working" suffix.
  ['approve_shape', '/plan/PLAN-ID/approve-shape', { status: 'grooming' }, /Approved by @test-requester — grooming now/],
  ['create', '/plan/PLAN-ID/create', { status: 'creating' }, /Create started by @test-requester — writing to Jira now/],
  ['reject', '/plan/PLAN-ID/reject', { status: 'rejected' }, /^✔ Rejected by @test-requester$/],
]) {
  test(`envelope dispatch: interactive "${actionId}" calls the matching service route and chat.updates the original message`, async () => {
    const serviceFetch = makeRecordingFetch((call) => {
      if (call.url.endsWith(expectedSuffix) && call.method === 'POST') return fakeResponse(202, expectedStatus);
      if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
      return fakeResponse(404, { error: 'unexpected call: ' + call.url });
    });
    const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
    const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

    await bridge.handleEnvelope(interactiveEnvelope(actionId), () => {});

    const actionPosts = serviceFetch.calls.filter((c) => c.method === 'POST' && c.url.endsWith(expectedSuffix));
    assert.equal(actionPosts.length, 1, `exactly one action-route POST expected for ${actionId}`);
    if (actionId === 'reject') {
      const body = JSON.parse(actionPosts[0].body);
      assert.match(body.reason, /rejected from Slack by test-requester/);
    }

    // An ADVANCING click also persists the click's channel to
    // the store (the RAM-only re-capture was the orphan gap); reject is
    // terminal — nothing left to post, nothing persisted.
    const surfacePosts = serviceFetch.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/surface'));
    if (actionId === 'reject') {
      assert.equal(surfacePosts.length, 0, 'reject persists no surface');
    } else {
      assert.equal(surfacePosts.length, 1, `${actionId} must persist the surface to the store`);
      assert.deepEqual(JSON.parse(surfacePosts[0].body), { surface: { type: 'slack', channel: 'C200' } });
    }

    const updates = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.update'));
    assert.equal(updates.length, 1, 'chat.update should have been recorded');
    assert.equal(updates[0].body.channel, 'C200');
    assert.equal(updates[0].body.ts, '1720000000.000100');
    assert.equal(updates[0].body.blocks.some((b) => b.type === 'actions'), false, 'the actions block must be replaced');
    assert.equal(updates[0].body.blocks[0].text.text, 'keep this block', 'informative blocks are kept');
    const contextBlock = updates[0].body.blocks.at(-1);
    assert.equal(contextBlock.type, 'context');
    assert.match(contextBlock.elements[0].text, expectedConfirm, `${actionId} confirm text names the next step (C2)`);
  });
}

test('envelope dispatch: interactive click that 409s updates the message with "already <status>"', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(409, { error: 'illegal transition', status: 'grooming' }));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(interactiveEnvelope('approve_shape'), () => {});

  const updates = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.update'));
  assert.equal(updates.length, 1);
  const contextBlock = updates[0].body.blocks.at(-1);
  assert.match(contextBlock.elements[0].text, /already grooming/);
});

test('envelope dispatch: interactive click on an unknown/finished plan (404) posts a note instead of chat.update, and never crashes', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(404, { error: 'not found' }));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await assert.doesNotReject(() => bridge.handleEnvelope(interactiveEnvelope('create'), () => {}));

  const slackCalls = jsonCalls(slackFetch);
  assert.equal(slackCalls.some((c) => c.url.endsWith('chat.update')), false, 'must not chat.update an unknown/finished plan');
  const posts = slackCalls.filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 1, 'a lightweight note should be posted instead');
  assert.equal(posts[0].body.channel, 'C200');
  assert.match(posts[0].body.text, /Could not create/i);
});

test('envelope dispatch: an unrecognized action_id never crashes and calls no service/Slack API', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await assert.doesNotReject(() => bridge.handleEnvelope(interactiveEnvelope('mystery_action'), (ack) => acks.push(ack)));

  assert.equal(acks.length, 1, 'the envelope is still acked even for an unrecognized action');
  assert.equal(serviceFetch.calls.length, 0);
  assert.equal(slackFetch.calls.length, 0);
});

test('envelope dispatch: interactive click with no value on the action never crashes', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const envelope = interactiveEnvelope('approve_shape');
  envelope.payload.actions[0].value = undefined;

  await assert.doesNotReject(() => bridge.handleEnvelope(envelope, () => {}));
  assert.equal(serviceFetch.calls.length, 0);
});

test('events_api envelopes (and anything else unhandled) are acked and otherwise ignored', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, {}));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  const acks = [];
  await bridge.handleEnvelope({ envelope_id: 'env-5', type: 'events_api', payload: { type: 'app_mention' } }, (ack) => acks.push(ack));

  assert.deepEqual(acks, [{ envelope_id: 'env-5' }]);
  assert.equal(serviceFetch.calls.length, 0);
  assert.equal(slackFetch.calls.length, 0);
});

// ---------------------------------------------------------------------------
// poller transitions
// ---------------------------------------------------------------------------

test('poller: shape_ready -> plan_ready -> created posts the right message each time and cleans up the watch map', async () => {
  const planId = '11111111-1111-4111-8111-111111111111';
  let currentPlan = { plan_id: planId, status: 'breaking_down', cost_usd: 0 };

  const serviceFetch = makeRecordingFetch((call) => {
    // The poller's cursor write must succeed for the watch
    // map to advance/clean up — serve it like the real service would.
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    if (call.url.endsWith(`/plan/${planId}`)) return fakeResponse(200, currentPlan);
    return fakeResponse(404, { error: 'not found' });
  });

  let tsCounter = 0;
  const slackFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('chat.postMessage')) {
      tsCounter += 1;
      return fakeResponse(200, { ok: true, ts: `170000000${tsCounter}.000000`, channel: JSON.parse(call.body).channel });
    }
    // Serve the content-visible gate file-upload leg (plan_ready attaches the full plan text
    // in-thread) so it succeeds silently — the upload is asserted in detail
    // in slack-plan-gate.test.mjs; here it must simply not add posts.
    if (call.url.endsWith('files.getUploadURLExternal')) {
      return fakeResponse(200, { ok: true, upload_url: 'https://files.slack.com/upload/v1/FAKE', file_id: 'F-FAKE' });
    }
    if (call.url.startsWith('https://files.slack.com/')) return fakeResponse(200, {});
    return fakeResponse(200, { ok: true });
  });

  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, { channel: 'C300', requester: 'test-requester', description: 'x'.repeat(50), lastStatus: 'breaking_down', messageTs: undefined });

  // -- shape_ready --
  currentPlan = {
    ...currentPlan,
    status: 'shape_ready',
    cost_usd: 0.8,
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'do a thing' }] },
    skeleton_gate: { ok: true },
  };
  await bridge.pollOnce();

  let posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 1);
  assert.match(posts[0].body.blocks[0].text.text, /Proposed plan/);
  assert.ok(bridge.watched.has(planId), 'shape_ready must not stop watching');
  assert.equal(bridge.watched.get(planId).messageTs, '1700000001.000000');

  // -- plan_ready --
  currentPlan = {
    ...currentPlan,
    status: 'plan_ready',
    cost_usd: 1.7,
    plan: { items: [{ temp_id: 'i1', type: 'Task', effort_tier: 'low', fields: { acceptance_criteria: [], related_links: {}, technical_analysis: {} } }] },
    duplicate_search: { ok: true, output: 'no matches (fake)' },
  };
  await bridge.pollOnce();

  posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 2);
  assert.match(posts[1].body.blocks[0].text.text, /Groomed/);
  assert.ok(bridge.watched.has(planId), 'plan_ready must not stop watching');

  // -- created --
  currentPlan = { ...currentPlan, status: 'created', created: { keys: ['PROJ-999'], verify_ok: true } };
  await bridge.pollOnce();

  posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 3);
  assert.match(posts[2].body.blocks[0].text.text, /Created/);
  assert.match(posts[2].body.blocks[0].text.text, /PROJ-999/);
  assert.equal(bridge.watched.has(planId), false, 'created must stop watching and remove the plan');
});

test('poller: a same-status re-poll is a no-op (no duplicate posts)', async () => {
  const planId = '22222222-2222-4222-8222-222222222222';
  const currentPlan = { plan_id: planId, status: 'shape_ready', cost_usd: 0.8, skeleton: { items: [] } };

  const serviceFetch = makeRecordingFetch((call) => (call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true, ts: '1.1' }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, { channel: 'C1', description: 'd', lastStatus: 'shape_ready', messageTs: undefined });

  await bridge.pollOnce();
  await bridge.pollOnce();
  await bridge.pollOnce();

  const posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 0, 'lastStatus already equals the current status, so nothing should post');
});

test('poller: terminal statuses post a ⚠️ warning; rejected stops watching, failed/budget_blocked stay watched for retry', async () => {
  // rejected is a human decision → drop it. failed/budget_blocked are
  // retryable → the entry must survive so a Retry click can re-use it.
  const cases = [
    { status: 'rejected', staysWatched: false, hasRetry: false },
    { status: 'failed', staysWatched: true, hasRetry: true },
    { status: 'budget_blocked', staysWatched: true, hasRetry: true },
  ];
  for (const { status, staysWatched, hasRetry } of cases) {
    const planId = `33333333-3333-4333-8333-33333333333${status.length % 10}`;
    const currentPlan = { plan_id: planId, status, cost_usd: 0.8, error: status === 'failed' ? 'skeleton gate failed' : undefined };

    const serviceFetch = makeRecordingFetch((call) => {
      if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
      return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
    });
    const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
    const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
    bridge.watched.set(planId, { channel: 'C1', description: 'd', lastStatus: 'plan_ready', messageTs: undefined });

    await bridge.pollOnce();

    const posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
    assert.equal(posts.length, 1, `expected one terminal post for ${status}`);
    assert.match(posts[0].body.blocks[0].text.text, /⚠️/);
    const hasRetryButton = (posts[0].body.blocks || []).some(
      (b) => b.type === 'actions' && b.elements.some((e) => e.action_id === 'retry'),
    );
    assert.equal(hasRetryButton, hasRetry, `${status} retry-button presence`);
    assert.equal(bridge.watched.has(planId), staysWatched, `${status} watch retention`);

    // A second poll must NOT repost (the status is unchanged) even though the
    // retryable entry is still watched.
    await bridge.pollOnce();
    const posts2 = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
    assert.equal(posts2.length, 1, `${status} must not repost on an unchanged status`);
  }
});

test('interactive cancel_tree: click POSTs /plan/{id}/cancel and re-captures the channel so the poller can post cancelled', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan/PLAN-ID/cancel') && call.method === 'POST') {
      return fakeResponse(202, { status: 'cancelling' });
    }
    if (call.url.endsWith('/plan/PLAN-ID/surface') && call.method === 'POST') {
      return fakeResponse(200, { ok: true });
    }
    return fakeResponse(404, { error: 'unexpected call: ' + call.url });
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  // The created message's watch entry is already GONE by the time its Cancel
  // button is clicked (`created` is a STOP_WATCHING status) — this empty map
  // is exactly the state a real cancel_tree click arrives in.
  assert.equal(bridge.watched.size, 0);

  await bridge.handleEnvelope(interactiveEnvelope('cancel_tree'), () => {});

  const cancelPosts = serviceFetch.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/plan/PLAN-ID/cancel'));
  assert.equal(cancelPosts.length, 1, 'must POST the cancel route exactly once');

  // The click's channel is persisted to the STORE too — the
  // watch entry was gone, so after a bridge restart the store copy is the
  // only thing that lets the eventual 🚫 cancelled reach this channel.
  const surfacePosts = serviceFetch.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/plan/PLAN-ID/surface'));
  assert.equal(surfacePosts.length, 1, 'the re-capture also writes the surface to the store');
  assert.deepEqual(JSON.parse(surfacePosts[0].body), { surface: { type: 'slack', channel: 'C200' } });

  const entry = bridge.watched.get('PLAN-ID');
  assert.ok(entry, 'cancel_tree must re-capture the plan into the watch map — the poller has cancelled to post');
  assert.equal(entry.channel, 'C200', 'channel recovered from the click itself');
  assert.equal(entry.lastStatus, 'cancelling');

  const updates = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.update'));
  assert.equal(updates.length, 1, 'the clicked message loses its buttons');
  // C2: the confirm names what happens next (the cleanup sweep) instead of
  // sitting mute for the minutes it takes.
  assert.match(updates[0].body.blocks.at(-1).elements[0].text, /Cancel by @test-requester — cleaning up/);
});

test('interactive retry: click POSTs /plan/{id}/retry and re-watches the plan', async () => {
  const planId = '55555555-5555-4555-8555-555555555555';
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith(`/plan/${planId}/retry`) && call.method === 'POST') {
      return fakeResponse(202, { status: 'grooming' });
    }
    return fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  // Simulate the failed entry still on file (as the poller now leaves it).
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'big migration', lastStatus: 'failed', messageTs: 'ts-9' });

  await bridge.handleEnvelope(
    {
      envelope_id: 'retry-1',
      type: 'interactive',
      payload: {
        type: 'block_actions',
        user: { username: 'test-requester' },
        channel: { id: 'C1' },
        message: { ts: 'ts-9', blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '⚠️ failed' } }, { type: 'actions', elements: [] }] },
        actions: [{ action_id: 'retry', value: planId }],
      },
    },
    () => {},
  );

  const posts = jsonCalls(serviceFetch).filter((c) => c.url.endsWith(`/plan/${planId}/retry`));
  assert.equal(posts.length, 1, 'must POST the retry route exactly once');
  const entry = bridge.watched.get(planId);
  assert.ok(entry, 'the plan must remain watched after retry');
  assert.equal(entry.lastStatus, 'grooming', 'lastStatus updated so the poller reposts on the next change');
  assert.equal(entry.description, 'big migration', 'the description survives the retry');
  // C2: the retry confirm names the re-run rather than sitting mute.
  const updates = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.update'));
  assert.equal(updates.length, 1);
  assert.match(updates[0].body.blocks.at(-1).elements[0].text, /Retry by @test-requester — re-running/);
});

test('poller: cancelling posts nothing (worker mid-sweep); cancelled posts the 🚫 message and stops watching', async () => {
  const planId = '66666666-6666-4666-8666-666666666666';
  let currentPlan = { plan_id: planId, status: 'cancelling', cost_usd: 1.7 };
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  // Exactly what a cancel_tree click leaves behind (see the dispatch test).
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'created', messageTs: undefined });

  await bridge.pollOnce();
  assert.equal(slackFetch.calls.length, 0, 'cancelling posts nothing — same silence as creating/grooming');
  assert.ok(bridge.watched.has(planId), 'still watched while the sweep runs');

  currentPlan = { ...currentPlan, status: 'cancelled', created: { keys: ['PROJ-999'], record_path: '/rec.json', verify_ok: true, cancelled: true } };
  await bridge.pollOnce();

  const posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 1, 'cancelled posts exactly one message');
  assert.match(posts[0].body.blocks[0].text.text, /🚫 Tree cancelled/, 'its own success-of-cancel message — never the ⚠️ terminal one');
  assert.match(posts[0].body.blocks[0].text.text, /<https:\/\/your-domain\.atlassian\.net\/browse\/PROJ-999\|PROJ-999>/, 'one browse link per cancelled key');
  const contextBlock = posts[0].body.blocks.find((b) => b.type === 'context');
  assert.match(contextBlock.elements[0].text, /nothing was deleted/, 'the cancel-not-delete honesty line is present');
  assert.equal(posts[0].body.blocks.some((b) => b.type === 'actions'), false, 'no action buttons — cancelled is final on the product surface');
  assert.equal(bridge.watched.has(planId), false, 'cancelled stops watching and removes the plan');
});

test('poller race: a cancel_tree re-capture DURING the created post survives the stop-watching delete — the eventual 🚫 still posts', async () => {
  const planId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  let currentPlan = { plan_id: planId, status: 'created', created: { keys: ['PROJ-999'], record_path: '/rec.json', verify_ok: true } };
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
  });
  // The interleave: while pollOnce is awaiting the createdMessage post, a
  // confirmed cancel_tree click re-captures the plan into the watch map as
  // a FRESH entry (exactly what handleBlockAction does on a 202). Running
  // the re-capture inside the recorded-calls fake puts it deterministically
  // inside that await window.
  let recaptured = false;
  const slackFetch = makeRecordingFetch((call) => {
    if (!recaptured && call.url.endsWith('chat.postMessage') && String(call.body).includes('🎫 Created:')) {
      recaptured = true;
      bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'cancelling', messageTs: undefined });
    }
    return fakeResponse(200, { ok: true });
  });
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'creating', messageTs: undefined });

  await bridge.pollOnce();

  // Without the guarded delete, `created` (a STOP_WATCHING status) would
  // unconditionally delete the map entry here — destroying the click's
  // fresh entry and orphaning the eventual cancel outcome.
  assert.equal(bridge.watched.has(planId), true, 'the re-captured entry must survive the created stop-watching delete');
  assert.equal(bridge.watched.get(planId).lastStatus, 'cancelling', "and it is the CLICK's entry, not the stale created one");

  currentPlan = { ...currentPlan, status: 'cancelled', created: { ...currentPlan.created, cancelled: true } };
  await bridge.pollOnce();

  const posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 2, 'the created post and the cancelled post');
  assert.match(posts[1].body.blocks[0].text.text, /🚫 Tree cancelled/, 'the eventual cancel outcome still reaches the channel');
  assert.equal(bridge.watched.has(planId), false, 'an unraced cancelled still stops watching');
});

test('poller reentrancy: pollOnce is the unguarded primitive (two concurrent manual calls double-post); the STARTED poller guards tick overlap and posts the transition exactly once', async () => {
  // Part 1 — the reviewer's repro, kept as documentation of WHERE the guard
  // lives: pollOnce itself has no reentrancy protection, so two overlapping
  // manual calls both read the not-yet-advanced lastStatus and both post.
  const planId = '99999999-9999-4999-8999-999999999999';
  const plan = { plan_id: planId, status: 'created', created: { keys: ['PROJ-9'], verify_ok: true } };
  const makeServiceFetch = () => makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    if (call.url.endsWith('/plans')) return fakeResponse(200, { plans: [] });
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, plan) : fakeResponse(404, {});
  });
  const makeSlowSlackFetch = (postDelayMs) => makeRecordingFetch(async (call) => {
    if (call.url.endsWith('apps.connections.open')) return fakeResponse(200, { ok: true, url: 'wss://fake' });
    if (call.url.endsWith('chat.postMessage')) {
      // Deliberately slow post — long enough to outlive several poll ticks.
      await new Promise((resolve) => setTimeout(resolve, postDelayMs));
      return fakeResponse(200, { ok: true, ts: '1.1' });
    }
    return fakeResponse(200, { ok: true });
  });

  const slackFetch1 = makeSlowSlackFetch(50);
  const bridge1 = createBridge({ serviceFetch: makeServiceFetch(), slackFetch: slackFetch1, env: FAKE_ENV, log: SILENT_LOG });
  bridge1.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'creating', messageTs: undefined });
  await Promise.all([bridge1.pollOnce(), bridge1.pollOnce()]);
  assert.equal(
    slackFetch1.calls.filter((c) => c.url.endsWith('chat.postMessage')).length,
    2,
    'the primitive double-posts when overlapped by hand — proving the guard must live in start()',
  );

  // Part 2 — through start(): a 25ms interval with a 150ms post means ~5
  // ticks fire while the first pollOnce is still awaiting Slack. The
  // `polling` guard must swallow every overlapping tick, leaving exactly
  // ONE post for the transition. (Restart-duplicates are the delivered
  // cursor's job, not this guard's — see start()'s comment.)
  const slackFetch2 = makeSlowSlackFetch(150);
  const bridge2 = createBridge({
    serviceFetch: makeServiceFetch(),
    slackFetch: slackFetch2,
    connect: () => ({ addEventListener() {}, close() {}, send() {} }),
    env: { ...FAKE_ENV, RADSVINN_SLACK_POLL_MS: '25' },
    log: SILENT_LOG,
  });
  bridge2.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'creating', messageTs: undefined });
  await bridge2.start();
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    assert.equal(
      slackFetch2.calls.filter((c) => c.url.endsWith('chat.postMessage')).length,
      1,
      'the started poller announces the transition exactly once despite overlapping ticks',
    );
    assert.equal(bridge2.watched.has(planId), false, 'the delivered created still drops out of the watch map');
  } finally {
    bridge2.stop();
  }
});

test('poller: a resumed plan with no channel on file logs and skips the post instead of crashing', async () => {
  const planId = '44444444-4444-4444-8444-444444444444';
  const currentPlan = { plan_id: planId, status: 'plan_ready', cost_usd: 1.0 };

  const serviceFetch = makeRecordingFetch((call) => (call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const warnings = [];
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: { error: (m) => warnings.push(m) } });
  // Mirrors exactly what resume() would seed: no channel known.
  bridge.watched.set(planId, { channel: undefined, description: 'd', lastStatus: 'shape_ready', messageTs: undefined });

  await assert.doesNotReject(() => bridge.pollOnce());

  assert.equal(slackFetch.calls.length, 0, 'no Slack call should be attempted without a channel');
  assert.ok(warnings.some((w) => w.includes(planId)), 'a warning naming the plan should be logged');
});

// ---------------------------------------------------------------------------
// boot-resume
// ---------------------------------------------------------------------------

test('boot-resume: GET /plans feeds the watch map with every non-terminal plan only', async () => {
  const plans = [
    { plan_id: 'p1', status: 'shape_ready', description: 'search history by prompt', updated_at: '2026-07-09T00:00:00.000Z' },
    { plan_id: 'p2', status: 'created', description: 'already done', updated_at: '2026-07-08T00:00:00.000Z' },
    { plan_id: 'p3', status: 'grooming', description: 'mid groom', updated_at: '2026-07-08T01:00:00.000Z' },
    { plan_id: 'p4', status: 'rejected', description: 'nope', updated_at: '2026-07-08T02:00:00.000Z' },
    { plan_id: 'p5', status: 'cancelled', description: 'undone tree', updated_at: '2026-07-08T03:00:00.000Z' },
  ];
  const serviceFetch = makeRecordingFetch((call) => (call.url.endsWith('/plans') ? fakeResponse(200, { plans }) : fakeResponse(404, {})));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.resume();

  assert.equal(bridge.watched.size, 2, 'only shape_ready and grooming (non-terminal) plans should be re-watched');
  assert.ok(bridge.watched.has('p1'));
  assert.ok(bridge.watched.has('p3'));
  assert.equal(bridge.watched.has('p2'), false, 'created is terminal');
  assert.equal(bridge.watched.has('p4'), false, 'rejected is terminal');
  assert.equal(bridge.watched.has('p5'), false, 'cancelled is terminal — never re-watched at boot');

  const p1 = bridge.watched.get('p1');
  assert.equal(p1.lastStatus, 'shape_ready');
  assert.equal(p1.description, 'search history by prompt');
  assert.equal(p1.channel, undefined, 'a resumed plan has no channel until this process learns one some other way');
});

test('boot-resume: a GET /plans failure is swallowed, not thrown', async () => {
  const serviceFetch = makeRecordingFetch(() => fakeResponse(500, { error: 'boom' }));
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await assert.doesNotReject(() => bridge.resume());
  assert.equal(bridge.watched.size, 0);
});

// ---------------------------------------------------------------------------
// block builders (slack-blocks.mjs) — exercised directly, no bridge needed
// ---------------------------------------------------------------------------

test('renderSkeletonTree: groups items under milestone lines, ordered by `order`, with an (unassigned) bucket', () => {
  const skeleton = {
    milestones: [
      { milestone_id: 'm2', name: 'Second', order: 2 },
      { milestone_id: 'm1', name: 'First', order: 1 },
    ],
    items: [
      { temp_id: 'i1', type: 'Task', milestone_id: 'm1', one_line_summary: 'do first thing' },
      { temp_id: 'i2', type: 'Story', milestone_id: 'm2', one_line_summary: 'do second thing' },
      { temp_id: 'i3', type: 'Task', milestone_id: 'unknown-milestone', one_line_summary: 'orphaned item' },
    ],
  };
  const tree = renderSkeletonTree(skeleton);
  const firstIdx = tree.indexOf('First:');
  const secondIdx = tree.indexOf('Second:');
  const unassignedIdx = tree.indexOf('(unassigned):');
  assert.ok(firstIdx >= 0 && secondIdx > firstIdx, 'milestones should render in `order`, not array order');
  assert.ok(unassignedIdx > secondIdx);
  assert.match(tree, /\[Task] i1 — do first thing/);
  assert.match(tree, /\[Story] i2 — do second thing/);
  assert.match(tree, /\[Task] i3 — orphaned item/);
});

test('renderSkeletonTree: a one-node skeleton renders as the single line even though a milestone exists', () => {
  const skeleton = {
    milestones: [{ milestone_id: 'm1', name: 'Only', order: 1 }],
    items: [{ temp_id: 'i1', type: 'Task', milestone_id: 'm1', one_line_summary: 'the only thing' }],
  };
  assert.equal(renderSkeletonTree(skeleton), '[Task] i1 — the only thing');
});

test('renderSkeletonTree: no milestones -> flat list, not grouped', () => {
  const skeleton = {
    milestones: [],
    items: [
      { temp_id: 'i1', type: 'Task', one_line_summary: 'a' },
      { temp_id: 'i2', type: 'Task', one_line_summary: 'b' },
    ],
  };
  assert.equal(renderSkeletonTree(skeleton), '[Task] i1 — a\n[Task] i2 — b');
});

test('skeletonMessage: context surfaces lang (when known) and scope (only when constrained) at the FIRST gate', () => {
  // FIX 1+2 (2026-07-10): a wrong output_language used to surface only
  // after the expensive groom — the shape gate is where regenerating is
  // still cheap, so lang (and a non-auto scope) must be visible there.
  const base = {
    plan_id: 'PID',
    cost_usd: 0.8,
    description: 'search history',
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }] },
  };

  const constrained = skeletonMessage({ ...base, output_language: 'tr', scope_hint: 'single' });
  const ctx = constrained.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.match(ctx, /lang: tr/, 'the chosen language is visible at the shape gate');
  assert.match(ctx, /scope: single/, 'a constrained scope is visible so the approver checks the shape honored it');
  assert.match(ctx, /correctness NOT auto-checked/, 'the honest gate tail survives the additions');

  const auto = skeletonMessage({ ...base, output_language: 'en', scope_hint: 'auto' });
  const ctx2 = auto.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.match(ctx2, /lang: en/);
  assert.equal(/scope:/.test(ctx2), false, 'auto is the default — never surfaced');

  // A legacy plan without the fields keeps the exact original context line
  // (exact-string contract in slack-plan-gate.test.mjs).
  const legacy = skeletonMessage(base);
  const ctx3 = legacy.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.equal(ctx3.includes('lang:'), false);
  assert.equal(ctx3.includes('scope:'), false);
});

test('planReadyMessage: resolves each item summary from the matching skeleton item, falling back to temp_id', () => {
  const plan = {
    plan_id: 'PID',
    cost_usd: 1.7,
    duplicate_search: { ok: true, output: 'no matches (fake)' },
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'index the column' }] },
    plan: {
      items: [
        {
          temp_id: 'i1',
          type: 'Task',
          effort_tier: 'low',
          fields: {
            why: 'searches must stay fast',
            definition_of_done: 'index exists and is used',
            acceptance_criteria: ['a', 'b'],
            related_links: { code_anchors: ['web-app:x:Y'] },
            technical_analysis: { prose: 'add a GIN index', coupling_zones: ['none'] },
          },
        },
        { temp_id: 'i2', type: 'Story', effort_tier: 'medium', fields: { acceptance_criteria: [], related_links: {}, technical_analysis: {} } },
      ],
    },
  };
  const msg = planReadyMessage(plan);

  // content-visible gate: the create gate renders CONTENT, not counts — 2 items fit rich.
  const first = msg.blocks[1];
  assert.match(first.text.text, /\*Task\* index the column/);
  assert.match(first.text.text, /\*Why:\* searches must stay fast/);
  assert.match(first.text.text, /\*DoD:\* index exists and is used/);
  assert.match(first.text.text, /\*AC:\*\n• a\n• b/);
  assert.match(first.text.text, /\*TA:\* add a GIN index/);
  assert.match(first.text.text, /\*Anchors:\*\n`web-app:x:Y`/);
  assert.match(first.text.text, /zones: none · effort: low/);

  const second = msg.blocks[2];
  assert.match(second.text.text, /\*Story\* i2/, 'falls back to temp_id when no skeleton match exists');
  // Empty/missing fields render as a visible (none), never silently vanish —
  // absence is exactly what the human gate must be able to see and reject.
  assert.match(second.text.text, /\*Why:\* \(none\)/);
  assert.match(second.text.text, /\*AC:\* \(none\)/);
  assert.match(second.text.text, /\*Anchors:\* \(none\)/);
  assert.match(second.text.text, /zones: none · effort: medium/);

  const contextText = msg.blocks.find((b) => b.type === 'context').elements[0].text;
  assert.match(contextText, /no matches/);
  assert.match(contextText, /cost \$1\.70/);
});

test('createdMessage: renders one PROJ browse link per created key and a verify line', () => {
  const msg = createdMessage({ created: { keys: ['PROJ-100', 'PROJ-101'], verify_ok: true } });
  const text = msg.blocks[0].text.text;
  assert.match(text, /<https:\/\/your-domain\.atlassian\.net\/browse\/PROJ-100\|PROJ-100>/);
  assert.match(text, /<https:\/\/your-domain\.atlassian\.net\/browse\/PROJ-101\|PROJ-101>/);
  assert.match(text, /verify: ✅/);
});

test('createdMessage: carries the confirm-guarded Cancel tree button (cancel flow) — created is a real tree needing a real undo', () => {
  const msg = createdMessage({ plan_id: 'PID-1', created: { keys: ['PROJ-100'], verify_ok: true } });
  const actions = msg.blocks.find((b) => b.type === 'actions');
  assert.ok(actions, 'the created message must carry an actions block');
  assert.equal(actions.elements.length, 1, 'exactly one button — Cancel tree');
  const btn = actions.elements[0];
  assert.equal(btn.action_id, 'cancel_tree');
  assert.equal(btn.value, 'PID-1');
  assert.equal(btn.style, 'danger');
  assert.ok(btn.confirm, 'a destructive one-click MUST be confirm-guarded');
  assert.equal(btn.confirm.title.text, 'Cancel this tree?');
  assert.match(btn.confirm.text.text, /never deleted/, 'the dialog states cancel-not-delete');
  assert.match(btn.confirm.text.text, /terminal state \(cancelled\/closed where available\)/, 'CANCEL_RES can fall back to Done — the dialog claims a terminal state, not strictly cancelled/closed');
  assert.match(btn.confirm.text.text, /cannot be undone from Slack/);
  assert.equal(btn.confirm.confirm.text, 'Cancel tree');
  assert.equal(btn.confirm.deny.text, 'Keep it');
  // Slack REJECTS mrkdwn text objects inside a confirm dialog — all four
  // fields must be plain_text or chat.postMessage fails invalid_blocks.
  assert.equal(btn.confirm.title.type, 'plain_text');
  assert.equal(btn.confirm.text.type, 'plain_text');
  assert.equal(btn.confirm.confirm.type, 'plain_text');
  assert.equal(btn.confirm.deny.type, 'plain_text');
  assert.equal(btn.confirm.style, 'danger', "the dialog's confirm button is red — Slack's destructive-confirm guidance");
});

test('terminalMessage: Cancel tree appears ONLY on failed-with-created-record, next to Retry — the retry write guard dead-end escape', () => {
  // failed WITH a record (retry write guard's surfaced partial tree, or a failed cancel).
  const withRecord = terminalMessage({
    plan_id: 'PID-2',
    status: 'failed',
    error: 'retry blocked — a previous create attempt already wrote 1 issue(s) to Jira',
    created: { keys: ['PROJ-1'], record_path: '/rec.json', verify_ok: false, partial: true },
  });
  const actions = withRecord.blocks.find((b) => b.type === 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['retry', 'cancel_tree'], 'both recoveries side by side');
  const cancelBtn = actions.elements.find((e) => e.action_id === 'cancel_tree');
  assert.equal(cancelBtn.style, 'danger');
  assert.equal(cancelBtn.value, 'PID-2');
  assert.ok(cancelBtn.confirm, 'the failed-surface cancel is confirm-guarded too');

  // failed WITHOUT a record — nothing on the board, nothing to cancel.
  const noRecord = terminalMessage({ plan_id: 'PID-3', status: 'failed', error: 'groom died' });
  const noRecActions = noRecord.blocks.find((b) => b.type === 'actions');
  assert.deepEqual(noRecActions.elements.map((e) => e.action_id), ['retry'], 'no record → Retry only');

  // budget_blocked never offers cancel, even with a (stale) marker present.
  const budget = terminalMessage({ plan_id: 'PID-4', status: 'budget_blocked', created: { record_path: '/rec.json' } });
  const budgetActions = budget.blocks.find((b) => b.type === 'actions');
  assert.deepEqual(budgetActions.elements.map((e) => e.action_id), ['retry'], 'budget_blocked → Retry only');

  // rejected keeps offering nothing at all.
  const rejected = terminalMessage({ plan_id: 'PID-5', status: 'rejected' });
  assert.equal(rejected.blocks.some((b) => b.type === 'actions'), false, 'rejected stays button-free');
});

test('cancelledMessage: 🚫 header, one browse link per key, cancel-not-delete context, zero buttons', () => {
  const msg = cancelledMessage({ plan_id: 'PID-6', created: { keys: ['PROJ-100', 'PROJ-101'], cancelled: true } });
  assert.match(msg.text, /Tree cancelled: PROJ-100, PROJ-101/);
  const text = msg.blocks[0].text.text;
  assert.match(text, /🚫 Tree cancelled:/);
  assert.match(text, /<https:\/\/your-domain\.atlassian\.net\/browse\/PROJ-100\|PROJ-100>/);
  assert.match(text, /<https:\/\/your-domain\.atlassian\.net\/browse\/PROJ-101\|PROJ-101>/);
  const contextBlock = msg.blocks.find((b) => b.type === 'context');
  assert.match(contextBlock.elements[0].text, /nothing was deleted/);
  assert.match(contextBlock.elements[0].text, /no hard failures/, 'claims only what cleanup exit 0 proves under the hard-failure exit-1 semantics');
  assert.match(contextBlock.elements[0].text, /already in a terminal state is skipped/, 'the benign-skip caveat reaches the surface');
  assert.match(contextBlock.elements[0].text, /GET \/plan/, 'points the human at the per-ticket sweep output');
  assert.equal(msg.blocks.some((b) => b.type === 'actions'), false);
});

test('createdMessage/cancelledMessage: empty or absent keys never crash — cancel still offered on created, cancelled stays button-free', () => {
  // A record with created:[] produces keys:[] — the messages must render,
  // not throw (a crash here would silence the poller for every later plan).
  const created = createdMessage({ plan_id: 'PID-7', created: { keys: [], verify_ok: false } });
  assert.equal(created.text, 'Created');
  assert.match(created.blocks[0].text.text, /🎫 Created:/);
  const actions = created.blocks.find((b) => b.type === 'actions');
  assert.equal(actions.elements[0].action_id, 'cancel_tree', 'zero recorded keys still needs the undo — the record is the source of truth, not the key list');

  const cancelledEmpty = cancelledMessage({ plan_id: 'PID-8', created: { keys: [] } });
  assert.equal(cancelledEmpty.text, 'Tree cancelled');
  assert.match(cancelledEmpty.blocks[0].text.text, /🚫 Tree cancelled:/);
  assert.equal(cancelledEmpty.blocks.some((b) => b.type === 'actions'), false);

  // No marker at all (defensive — cancelled should always carry one).
  const cancelledNoMarker = cancelledMessage({ plan_id: 'PID-9' });
  assert.equal(cancelledNoMarker.text, 'Tree cancelled');
  assert.match(cancelledNoMarker.blocks[0].text.text, /🚫 Tree cancelled:/);
});

test('poller: a FAILED cancel (cancelling -> failed with record) posts the ⚠️ message with BOTH Retry and Cancel tree, and stays watched', async () => {
  const planId = '88888888-8888-4888-8888-888888888888';
  let currentPlan = { plan_id: planId, status: 'cancelling', cost_usd: 1.7 };
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/surface') && call.method === 'POST') return fakeResponse(200, { ok: true });
    return call.url.endsWith(`/plan/${planId}`) ? fakeResponse(200, currentPlan) : fakeResponse(404, {});
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });
  // Exactly what the cancel_tree click's re-capture leaves behind.
  bridge.watched.set(planId, { channel: 'C1', requester: 'test-requester', description: 'd', lastStatus: 'cancelling', messageTs: undefined });

  currentPlan = {
    ...currentPlan,
    status: 'failed',
    error: 'cancel failed — the tree may be only partially cancelled.\nClick "Cancel tree" again or run: node tools/create-tree.mjs --cleanup /rec.json --live',
    created: { keys: ['PROJ-999'], record_path: '/rec.json', verify_ok: true },
  };
  await bridge.pollOnce();

  const posts = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.postMessage'));
  assert.equal(posts.length, 1, 'the failed cancel posts exactly one ⚠️ message');
  assert.match(posts[0].body.blocks[0].text.text, /⚠️/);
  assert.match(posts[0].body.blocks[0].text.text, /Click "Cancel tree" again/, 'the re-click guidance reaches the Slack surface inside the 500-char window');
  const actions = posts[0].body.blocks.find((b) => b.type === 'actions');
  assert.deepEqual(actions.elements.map((e) => e.action_id), ['retry', 'cancel_tree'], 'both recoveries offered after a failed cancel');
  assert.ok(actions.elements[1].confirm, 'the re-offered cancel is still confirm-guarded');
  assert.equal(bridge.watched.has(planId), true, 'failed is not watch-terminal — a re-click outcome still needs posting');
});

test('interactive cancel_tree double-click: the late click 409s and softens into "already cancelled" — no re-watch, no scary extra post', async () => {
  const serviceFetch = makeRecordingFetch((call) => {
    if (call.url.endsWith('/plan/PLAN-ID/cancel') && call.method === 'POST') {
      return fakeResponse(409, { error: 'illegal transition', status: 'cancelled' });
    }
    return fakeResponse(404, { error: 'unexpected call: ' + call.url });
  });
  const slackFetch = makeRecordingFetch(() => fakeResponse(200, { ok: true }));
  const bridge = createBridge({ serviceFetch, slackFetch, env: FAKE_ENV, log: SILENT_LOG });

  await bridge.handleEnvelope(interactiveEnvelope('cancel_tree'), () => {});

  const updates = jsonCalls(slackFetch).filter((c) => c.url.endsWith('chat.update'));
  assert.equal(updates.length, 1, 'the clicked message is softened in place');
  assert.match(updates[0].body.blocks.at(-1).elements[0].text, /⏳ already cancelled/);
  assert.equal(bridge.watched.size, 0, 'a refused cancel must not re-watch the plan');
  assert.equal(slackFetch.calls.filter((c) => c.url.endsWith('chat.postMessage')).length, 0, 'a benign double-click never posts a new message');
});

test('ackPayload: defaults to the standard planning text, accepts an override', () => {
  assert.equal(ackPayload().response_type, 'ephemeral');
  assert.match(ackPayload().text, /Planning/);
  assert.equal(ackPayload('custom text').text, 'custom text');
});

test('C4: createdMessage renders "asked by <@id>" when requester_id is present, cleanly omits it when absent', () => {
  const withId = createdMessage({ plan_id: 'PID', requester_id: 'U777', created: { keys: ['PROJ-1'], verify_ok: true } });
  const ctx = withId.blocks.find((b) => b.type === 'context');
  assert.ok(ctx, 'a context block carries the attribution');
  assert.match(ctx.elements[0].text, /asked by <@U777>/);
  assert.ok(withId.blocks.find((b) => b.type === 'actions'), 'the Cancel tree button survives the added attribution');

  // Legacy plan (no requester_id) → no attribution block, no bare <@>.
  const withoutId = createdMessage({ plan_id: 'PID', created: { keys: ['PROJ-1'], verify_ok: true } });
  assert.equal(withoutId.blocks.some((b) => b.type === 'context'), false, 'no attribution block for a legacy plan');
  assert.equal(JSON.stringify(withoutId).includes('asked by'), false, 'no dangling "asked by" text');
});

test('C4: preparingMessage renders "asked by <@id>" when requesterId is present, cleanly omits it when absent', () => {
  const withId = preparingMessage({ description: 'do a thing', outputLanguage: 'en', requesterId: 'U777' });
  assert.ok(
    withId.blocks.some((b) => b.type === 'context' && /asked by <@U777>/.test(b.elements[0].text)),
    'the attribution context block is present',
  );

  const withoutId = preparingMessage({ description: 'do a thing', outputLanguage: 'en' });
  assert.equal(JSON.stringify(withoutId).includes('asked by'), false, 'no attribution for an absent requesterId');
  // The original grounding-note context block still renders regardless.
  assert.ok(withoutId.blocks.some((b) => b.type === 'context' && /Reading the codebase/.test(b.elements[0].text)));
});

test('C4: a poisoned requester_id is mrkdwn-escaped — it can never smuggle a live channel-wide mention', () => {
  const msg = createdMessage({ plan_id: 'PID', requester_id: '<!channel>', created: { keys: [], verify_ok: false } });
  const ctx = msg.blocks.find((b) => b.type === 'context');
  assert.ok(ctx);
  // The raw <!channel> control sequence must be entity-escaped, never live.
  assert.equal(ctx.elements[0].text.includes('<!channel>'), false, 'no live channel ping survives');
  assert.match(ctx.elements[0].text, /&lt;!channel&gt;/, 'the control chars are entity-escaped');
});

test('C4 adversarial: a requester_id carrying its OWN ">" cannot prematurely close the <@…> mention wrapper', () => {
  // A crafted id like "U1>x<!channel" tries to close the <@...> span early
  // (via the bare ">") so the rest rides as live mrkdwn outside the mention.
  // mrkdwnEscape runs on the whole id BEFORE it is wrapped, so both the
  // attacker's ">" and the "<" of "<!channel" are entity-escaped — no raw
  // control character survives anywhere in the id, whichever position it's in.
  const msg = createdMessage({ plan_id: 'PID', requester_id: 'U1>x<!channel', created: { keys: [], verify_ok: false } });
  const ctx = msg.blocks.find((b) => b.type === 'context');
  assert.ok(ctx);
  const text = ctx.elements[0].text;
  assert.equal(text.includes('<!channel>'), false, 'no raw <!channel> substring survives anywhere in the rendered text');
  assert.equal(text.includes('U1>'), false, 'no raw ">" from the poisoned id survives either — it cannot close the wrapper early');
  assert.match(text, /asked by <@U1&gt;x&lt;!channel>/, 'the whole id is escaped, and the "asked by <@…>" wrapper stays a single intact span');
});

test('C4: the GATE builders (skeletonMessage / planReadyMessage) never render an "asked by" line — attribution there is deferred to C6', () => {
  const skeletonPlan = {
    plan_id: 'PID', cost_usd: 0.8, requester_id: 'U777',
    skeleton: { items: [{ temp_id: 'i1', type: 'Task', one_line_summary: 'a' }] },
  };
  const skelMsg = skeletonMessage(skeletonPlan);
  assert.equal(JSON.stringify(skelMsg).includes('asked by'), false, 'skeletonMessage must not include requester attribution');
  assert.equal(skelMsg.blocks.some((b) => b.type === 'context' && /asked by/.test(b.elements?.[0]?.text || '')), false);

  const planReadyPlan = {
    plan_id: 'PID', cost_usd: 1.7, requester_id: 'U777',
    duplicate_search: { ok: true, output: 'no matches (fake)' },
    skeleton: { items: [] },
    plan: { items: [] },
  };
  const readyMsg = planReadyMessage(planReadyPlan);
  assert.equal(JSON.stringify(readyMsg).includes('asked by'), false, 'planReadyMessage must not include requester attribution');
});

test('C4 adversarial: requesterAttributionLine directly — undefined/null/empty/whitespace-only all return null (no block)', () => {
  for (const junk of [undefined, null, '', '   ']) {
    assert.equal(requesterAttributionLine(junk), null, `requesterAttributionLine(${JSON.stringify(junk)}) must return null`);
  }
  const real = requesterAttributionLine('U777');
  assert.equal(real.type, 'context');
  assert.match(real.elements[0].text, /asked by <@U777>/);
});

test('C4 hardening: requesterAttributionLine TRUNCATES an oversized requester_id so createdMessage can never blow Slack\'s per-block limit', () => {
  // requester_id rides POST /plan UN-validated (fail-open); a direct client
  // can legally send ~50KB (only the 64KB body cap bounds it). Without a cap,
  // an oversized id would push createdMessage past Slack's ~3000-char per-block
  // limit → chat.postMessage invalid_blocks → the `created` announcement (and
  // its only non-CLI Cancel-tree undo) would never post, deterministically.
  const huge = 'U' + 'x'.repeat(50000);
  const line = requesterAttributionLine(huge);
  assert.equal(line.type, 'context');
  assert.ok(line.elements[0].text.length < 200, `attribution must be bounded; got ${line.elements[0].text.length}`);
  // A normal-length id is NOT over-eagerly truncated.
  assert.match(requesterAttributionLine('U0123456789').elements[0].text, /asked by <@U0123456789>/);
});

test('replaceActionsWithContext: drops the actions block, keeps everything else, appends a context line', () => {
  const blocks = [
    { type: 'section', text: { type: 'mrkdwn', text: 'keep me' } },
    { type: 'actions', elements: [{ type: 'button' }] },
  ];
  const result = replaceActionsWithContext(blocks, '✔ done');
  assert.equal(result.blocks.length, 2);
  assert.equal(result.blocks[0].text.text, 'keep me');
  assert.equal(result.blocks[1].type, 'context');
  assert.equal(result.blocks[1].elements[0].text, '✔ done');
});
