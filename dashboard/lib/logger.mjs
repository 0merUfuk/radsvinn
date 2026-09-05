// lib/logger.mjs — structured request logging (house pattern: loud stderr
// lines Railway captures). Hard constraint: never tokens, cookies, OAuth
// codes, or full bodies — only method, templated path, status, latency,
// actor login, and the named action (§3.4, §9.2's "request logging" item).

function redactPath(path) {
  // NOTE: the current call site (server.mjs) passes `url.pathname` — the
  // real request path, but WITHOUT the query string (URL#pathname never
  // includes it) — never a route template. That's still safe today: no
  // route embeds a secret in a path segment, and the query string (where an
  // OAuth `code=` could ride on /auth/callback) is already excluded upstream
  // of this call. This function remains the single choke point for that
  // guarantee; if a future caller ever passes a full URL/query string
  // instead of `.pathname`, this is where to actually redact/template it
  // rather than passing it through as-is.
  return path;
}

export function createLogger(write = (line) => console.error(line)) {
  function line(prefix, fields) {
    const parts = Object.entries(fields)
      .filter(([, v]) => v !== undefined && v !== null && v !== '')
      .map(([k, v]) => `${k}=${v}`);
    write(`[radsvinn-dashboard] ${prefix} ${parts.join(' ')}`.trimEnd());
  }

  return {
    logRequest({ method, path, status, durationMs, actorLogin, action, requestId }) {
      line('request', {
        method,
        path: redactPath(path),
        status,
        duration_ms: typeof durationMs === 'number' ? Math.round(durationMs) : undefined,
        actor: actorLogin,
        action,
        request_id: requestId,
      });
    },
    info(msg, fields = {}) {
      line('info', { msg: `"${msg}"`, ...fields });
    },
    warn(msg, fields = {}) {
      line('WARN', { msg: `"${msg}"`, ...fields });
    },
    error(msg, fields = {}) {
      line('ERROR', { msg: `"${msg}"`, ...fields });
    },
  };
}
