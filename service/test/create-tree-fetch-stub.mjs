// create-tree-fetch-stub.mjs — NOT a test file (no `.test.mjs` suffix): the
// scripted, zero-network Jira gateway double that create-tree-attach.test.mjs
// installs into the TOOL child process via `node --import <this file> tools/
// create-tree.mjs …`. `--import` evaluates this module BEFORE the tool's own
// module graph, so the global `fetch` the tool's api() closes over is already
// the stub by the time any command runs — the tests pin the tool's REAL wire
// behavior (request order, bodies, URLs) without a single network packet.
// This keeps tool-level attach request assertions reusable and explicit.
//
// Env contract (set by the test's spawn):
//   RADSVINN_TEST_FETCH_LOG        (required) file that receives one JSON line
//                                 per request: {method, url, body}. Created/
//                                 truncated at import time so a test can
//                                 assert the stub actually installed;
//                                 appendFileSync per request so the journal
//                                 survives a die()/process.exit mid-run.
//   RADSVINN_TEST_EXISTING_ISSUES  (optional) JSON map KEY → {summary,
//                                 issuetype} answering GET /issue/{KEY};
//                                 unknown keys get a Jira-shaped 404 —
//                                 exactly the attach-verify failure the tool
//                                 must die on.
//
// Everything else is canned: GET /project/* returns issue types (with a
// localized sub-task type, mirroring live PROJ), POST /issue mints PROJ-9xxx
// keys from a counter, links/comments/transitions succeed. An unscripted
// route answers 500 so a new tool endpoint fails LOUDLY in tests instead of
// silently passing.

import fs from 'node:fs';

const logPath = process.env.RADSVINN_TEST_FETCH_LOG;
if (!logPath) {
  throw new Error('create-tree-fetch-stub: RADSVINN_TEST_FETCH_LOG is required');
}
fs.writeFileSync(logPath, ''); // prove installation; truncate any stale log

const existingIssues = JSON.parse(process.env.RADSVINN_TEST_EXISTING_ISSUES || '{}');
let issueCounter = 9000;

// The tool's api() only touches res.ok / res.status / res.text() — a plain
// object double keeps this file dependency-free and Node-version-agnostic.
function respond(status, body) {
  const text = body === undefined ? '' : JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, text: async () => text };
}

globalThis.fetch = async (url, init = {}) => {
  const method = (init.method || 'GET').toUpperCase();
  const u = String(url);
  fs.appendFileSync(
    logPath,
    `${JSON.stringify({ method, url: u, body: init.body ? JSON.parse(init.body) : undefined })}\n`,
  );

  // Strip the gateway prefix: /ex/jira/<cloudId>/rest/api/3/<route>
  const route = new URL(u).pathname.replace(/^.*\/rest\/api\/3/, '');

  if (method === 'GET' && /^\/issue\/[^/]+$/.test(route)) {
    const key = route.split('/')[2];
    const known = existingIssues[key];
    if (!known) {
      return respond(404, { errorMessages: ['Issue does not exist or you do not have permission to see it.'] });
    }
    return respond(200, {
      key,
      fields: { summary: known.summary, issuetype: { name: known.issuetype }, status: { name: 'To Do' } },
    });
  }
  if (method === 'GET' && /^\/project\/[^/]+$/.test(route)) {
    return respond(200, {
      issueTypes: [
        { id: '10000', name: 'Epic', subtask: false },
        { id: '10001', name: 'Task', subtask: false },
        { id: '10004', name: 'Story', subtask: false },
        { id: '10002', name: 'Alt görev', subtask: true },
      ],
    });
  }
  if (method === 'POST' && route === '/issue') {
    issueCounter += 1;
    return respond(201, { id: String(issueCounter), key: `PROJ-${issueCounter}` });
  }
  if (method === 'POST' && route === '/issueLink') return respond(201, undefined);
  if (method === 'POST' && /^\/issue\/[^/]+\/comment$/.test(route)) return respond(201, { id: '1' });
  if (method === 'GET' && /^\/issue\/[^/]+\/transitions$/.test(route)) {
    return respond(200, { transitions: [{ id: '31', name: 'Closed', to: { name: 'Closed' } }] });
  }
  if (method === 'POST' && /^\/issue\/[^/]+\/transitions$/.test(route)) return respond(204, undefined);

  return respond(500, { stub: `unscripted route: ${method} ${route}` });
};
