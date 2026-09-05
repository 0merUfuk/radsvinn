// Shared model-child credential boundary. Deterministic control-plane tools
// inherit their configuration separately; only model children use this deny set.
const STRIP_KEYS = new Set([
  'GITHUB_TOKEN', 'GH_TOKEN', 'OPENROUTER_API_KEY',
]);
const SECRET_CONFIG = /^(?:MERCURY|RADSVINN)_(?:JIRA_TOKEN|SERVICE_TOKEN(?:_.*)?|OPENROUTER_API_KEY)$/;

export function sandboxedEnv(env) {
  const out = { ...env };
  for (const key of Object.keys(out)) {
    if (STRIP_KEYS.has(key) || SECRET_CONFIG.test(key)
      || /^(?:SLACK|RAILWAY|DASH)_/.test(key)) delete out[key];
  }
  return out;
}

// Redact BOTH configured spellings, including the losing alias, in child
// diagnostics before errors reach logs or persisted plan/harness evidence.
export function redactSecrets(text, env = process.env) {
  let out = String(text ?? '');
  const secrets = Object.entries(env)
    .filter(([key, value]) => typeof value === 'string' && value.length > 0
      && (STRIP_KEYS.has(key) || SECRET_CONFIG.test(key)
        || /^(?:SLACK|DASH)_.*(?:TOKEN|SECRET|KEY|URL)$/.test(key)
        || /^(?:ANTHROPIC|OPENAI|CLAUDE_CODE)_.*(?:TOKEN|SECRET|KEY)$/.test(key)))
    .map(([, value]) => value).sort((a, b) => b.length - a.length);
  for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
  return out.replace(/\b(?:MERCURY|RADSVINN)_(?:JIRA_TOKEN|SERVICE_TOKEN(?:_[A-Z_]+)?|OPENROUTER_API_KEY)\s*[:=]\s*[^\s,;]+/gi, '[REDACTED]');
}
