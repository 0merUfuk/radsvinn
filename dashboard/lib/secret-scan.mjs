// lib/secret-scan.mjs — the §3.4 CI guard: the built client bundle must
// never contain DASH_/MERCURY_ env names or token-shaped strings. Written as
// a reusable scanner so it doubles as (a) a unit-testable pattern match and
// (b) the real guard run over whatever ships in `public/` once a UI lands.

import fs from 'node:fs';
import path from 'node:path';

// Order matters only for readability; every pattern is checked independently.
export const SECRET_PATTERNS = [
  { name: 'DASH_ env name', re: /\bDASH_[A-Z0-9_]+\b/g },
  { name: 'MERCURY_ env name', re: /\bMERCURY_[A-Z0-9_]+\b/g },
  { name: 'OAuth client_secret literal', re: /\bclient_secret\b\s*[:=]/gi },
  { name: 'GitHub personal access token (ghp_)', re: /\bghp_[A-Za-z0-9]{20,}\b/g },
  { name: 'GitHub OAuth token (gho_)', re: /\bgho_[A-Za-z0-9]{20,}\b/g },
  { name: 'GitHub fine-grained PAT (github_pat_)', re: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g },
  { name: 'Slack bot token (xoxb-)', re: /\bxoxb-[A-Za-z0-9-]{10,}\b/g },
  { name: 'Slack app token (xapp-)', re: /\bxapp-[A-Za-z0-9-]{10,}\b/g },
];

// A conservative allowlist so the scanner doesn't flag its OWN source (this
// file necessarily contains the pattern names/strings above as literals for
// matching purposes, and the codebase's docs/comments reference these names
// in prose). Only used by scanDirectory's default file filter — callers
// scanning a real client bundle should pass their own extension list.
const DEFAULT_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.html', '.css', '.map', '.json']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

export function scanText(content) {
  const violations = [];
  for (const { name, re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    let match;
    // eslint-disable-next-line no-cond-assign
    while ((match = re.exec(content)) !== null) {
      violations.push({ pattern: name, match: match[0] });
      if (match[0].length === 0) re.lastIndex += 1; // guard against zero-width infinite loop
    }
  }
  return violations;
}

// Recursively scans a directory; returns `[]` (never throws) when the
// directory doesn't exist yet — a pre-UI dashboard/public/ is a legitimate
// "nothing to scan" state, not a scan failure.
export function scanDirectory(rootDir, { extensions = DEFAULT_EXTENSIONS } = {}) {
  const violations = [];
  let rootStat;
  try {
    rootStat = fs.statSync(rootDir);
  } catch {
    return violations;
  }
  if (!rootStat.isDirectory()) return violations;

  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name);
      if (!extensions.has(ext)) continue;
      const filePath = path.join(dir, entry.name);
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf8');
      } catch {
        continue;
      }
      for (const v of scanText(content)) {
        violations.push({ file: filePath, ...v });
      }
    }
  }
  return violations;
}
