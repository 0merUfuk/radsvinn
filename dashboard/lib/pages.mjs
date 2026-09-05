// lib/pages.mjs — the SSR shell and static-asset serving for the dashboard UI.
//
// Design note (§7.7, explicit v1 decision): the shell is 100% STATIC HTML —
// it interpolates NO request or plan data, so there is no server-side
// injection surface here at all. Every dynamic screen is rendered
// client-side from the same-origin /api/* surface using text-node-only DOM
// construction (public/app.js — CI-guarded against innerHTML). This is a
// deliberately stronger XSS posture than SSR string interpolation: hostile
// plan/LLM prose can never become markup because it never touches an HTML
// string on either hop. The CSP forbids inline script, so the bootstrap is
// a fetch of /api/session on load, not an inline data blob.
//
// No-JS read-screen SSR is a documented follow-up (§9.2 split); the security
// posture does not depend on it.
//
// Static serving is traversal-guarded (resolved path must stay under
// public/), MIME-mapped from a fixed allowlist, and never lists a directory.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

const MIME = {
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.woff2': 'font/woff2',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

// The page routes that all serve the same static shell (client router picks
// the screen from location.pathname). Detail is a UUID path, matched separately.
export const PAGE_PATHS = new Set(['/', '/plans', '/plans/new', '/operations', '/audit', '/settings']);

export function isPagePath(pathname) {
  if (PAGE_PATHS.has(pathname)) return true;
  return /^\/plans\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(pathname);
}

// The one HTML document the whole SPA-less app boots from. Static string —
// no interpolation, ever. Nav items carry both a glyph (.ni, shown only on
// the collapsed icon rail) and a label (.nl); the client marks the active
// one. IDs (crumb/role-pill/main/live) are the client renderer's mount points.
const SHELL = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Radsvinn</title>
<link rel="stylesheet" href="/assets/fonts/fonts.css">
<link rel="stylesheet" href="/assets/app.css">
<script src="/assets/app.js" defer></script>
</head><body>
<div class="shell">
  <nav class="sidebar" aria-label="Primary">
    <div class="brand">RADSVINN<span class="brand-sub">planning lens</span></div>
    <div class="navgroup"><div class="navlabel">Plan</div>
      <a href="/plans" data-nav="/plans"><span class="ni" aria-hidden="true">&#9636;</span><span class="nl">Plans</span></a>
      <a href="/plans/new" data-nav="/plans/new"><span class="ni" aria-hidden="true">&#65291;</span><span class="nl">New plan</span></a></div>
    <div class="navgroup"><div class="navlabel">Operate</div>
      <a href="/operations" data-nav="/operations"><span class="ni" aria-hidden="true">&#9678;</span><span class="nl">Operations</span></a></div>
    <div class="navgroup"><div class="navlabel">Govern</div>
      <a href="/audit" data-nav="/audit"><span class="ni" aria-hidden="true">&#8801;</span><span class="nl">Audit</span></a>
      <a href="/settings" data-nav="/settings"><span class="ni" aria-hidden="true">&#9881;</span><span class="nl">Settings</span></a></div>
  </nav>
  <div class="work">
    <header class="dock">
      <div class="crumb mono" id="crumb">Plan / Plans</div>
      <div class="dock-right">
        <span class="pill pill-proto" id="env-pill">PRODUCTION</span>
        <span class="pill pill-role mono" id="role-pill">&#8230;</span>
      </div>
    </header>
    <main id="main"><p class="loading">&#9680; Loading&#8230;</p></main>
  </div>
</div>
<div id="live" aria-live="polite" class="visually-hidden"></div>
</body></html>`;

export function renderShell() {
  return SHELL;
}

// Resolves a request path under /assets/* to a real file inside PUBLIC_DIR,
// or null if it escapes, doesn't exist, isn't a file, or has a disallowed
// extension. The traversal guard is the resolved-prefix check — never string
// matching on the raw request path.
export function resolveAsset(pathname) {
  if (!pathname.startsWith('/assets/')) return null;
  const rel = pathname.slice('/assets/'.length);
  if (rel.length === 0) return null;
  const ext = path.extname(rel).toLowerCase();
  if (!Object.prototype.hasOwnProperty.call(MIME, ext)) return null;
  // Normalize then confirm containment: a `..`-laden path resolves out of
  // PUBLIC_DIR and is rejected by the prefix check below.
  const resolved = path.resolve(PUBLIC_DIR, rel);
  const prefix = PUBLIC_DIR + path.sep;
  if (resolved !== PUBLIC_DIR && !resolved.startsWith(prefix)) return null;
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  return { filePath: resolved, contentType: MIME[ext], size: stat.size, ext };
}

export function readAsset(filePath) {
  return fs.readFileSync(filePath);
}
