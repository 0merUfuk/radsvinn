// audit.mjs — the append-only actor-audit ledger.
// Backs the dashboard's GET /audit surface described in
// docs/ARCHITECTURE.md. Mirrors the `daily-spend-<date>.json` pattern
// established by breakers.mjs: one UTC-dated file per day under the same
// results root every other service file uses, written with a single
// synchronous fs call and zero external dependencies.
//
// `appendAudit` NEVER throws and NEVER blocks a mutation on a disk
// failure: by the time a caller reaches this module the CAS transition
// has already committed (see server.mjs's write-placement comment —
// validation -> CAS transition -> audit append -> HTTP response -> worker
// dispatch), so a write failure here must be loud (stderr) while the HTTP
// response still succeeds. On a full/unwritable `/data`, mutations keep
// committing while their audit lines fail, and the plan's own status
// history is the secondary evidence.
//
// There is no delete/update code path anywhere in this file. Retention is
// operator-owned and requires direct filesystem/volume maintenance outside
// this service.
//
// `readAudit` is the `GET /audit` backing store: newest-first, keyset
// pagination over (date desc, line_index desc) — stable because the
// files are append-only and dated, the same keyset discipline as
// server.mjs's GET /plans (updated_at desc, plan_id desc). A torn/corrupt
// line (e.g. a crash mid-append) is skipped, exactly like state.mjs skips
// a corrupt plan file at boot — never thrown, never counted against the
// page.

import fs from 'node:fs';
import path from 'node:path';

const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

/** Thrown by `readAudit` on a malformed cursor; callers map it to 400. */
export class AuditCursorError extends Error {}

export function auditDir(resultsRoot) {
  return path.join(resultsRoot, 'service', 'audit');
}

// The UTC date bucket a record files under is derived from the record's
// OWN `ts` (not a fresh `new Date()` call here) so a record timestamped
// 23:59:59.999Z can never be mis-filed into the next day's file by a
// clock read a few ms later than the caller's `nowIso()`.
function dateStampFromRecord(record) {
  const raw = record && typeof record.ts === 'string' ? record.ts : '';
  const m = /^(\d{4}-\d{2}-\d{2})T/.exec(raw);
  return m ? m[1] : new Date().toISOString().slice(0, 10);
}

/**
 * Appends one JSONL line to today's (UTC) audit file. Returns `true` on
 * success, `false` on any failure — NEVER throws. Callers must treat a
 * `false` return as "the mutation still succeeds anyway" (see server.mjs).
 */
export function appendAudit(resultsRoot, record) {
  try {
    const dir = auditDir(resultsRoot);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${dateStampFromRecord(record)}.jsonl`);
    fs.appendFileSync(file, `${JSON.stringify(record)}\n`);
    return true;
  } catch (err) {
    // Loud, never silent — the plan's own status history is the
    // secondary evidence when this line is missing.
    console.error(`[radsvinn] AUDIT WRITE FAILED: ${err && err.message ? err.message : String(err)}`);
    return false;
  }
}

function encodeCursor(date, lineIndex) {
  return Buffer.from(`${date} ${lineIndex}`, 'utf8').toString('base64url');
}

// Node's base64url decode is lenient (invalid characters are dropped
// rather than throwing), so a garbage cursor decodes to SOME string
// rather than raising — the regex below is what actually rejects
// anything that isn't exactly `<date> <line_index>`.
function decodeCursor(cursor) {
  const decoded = Buffer.from(String(cursor), 'base64url').toString('utf8');
  const m = /^(\d{4}-\d{2}-\d{2}) (\d+)$/.exec(decoded);
  if (!m) throw new AuditCursorError('malformed cursor');
  return { date: m[1], lineIndex: Number(m[2]) };
}

/**
 * Reads audit records newest-first, optionally filtered to one plan.
 * `cursor` (opaque, from a previous response's `next_cursor`) resumes
 * strictly AFTER the last record that response returned — stable across
 * calls because audit files are append-only and dated (a concurrent
 * append only ever adds lines AFTER any index already handed out).
 * Throws `AuditCursorError` on a malformed cursor; callers map that to a
 * 400 response.
 */
export function readAudit(resultsRoot, { planId, cursor, limit = 100 } = {}) {
  const boundedLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
  const dir = auditDir(resultsRoot);

  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => DATE_FILE_RE.test(f));
  } catch {
    files = [];
  }
  files.sort().reverse(); // filenames are YYYY-MM-DD.jsonl — lexicographic = chronological; reverse = newest first

  let resume;
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    resume = decodeCursor(cursor); // may throw AuditCursorError — propagates to the caller
  }

  const records = [];
  let lastIncluded;
  let nextCursor;

  fileLoop:
  for (const file of files) {
    const date = file.slice(0, 10);
    if (resume && date > resume.date) continue; // entirely served by an earlier page

    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch {
      continue; // file vanished/unreadable between readdir and read — skip, never throw
    }
    const lines = raw.split('\n');
    // Append-only: a later array index is always a LATER (newer) write —
    // walk backwards for newest-first within this file.
    for (let idx = lines.length - 1; idx >= 0; idx--) {
      const line = lines[idx];
      if (!line || line.trim().length === 0) continue;
      if (resume && date === resume.date && idx >= resume.lineIndex) continue;

      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue; // torn/corrupt line (crash mid-append) — skip, never throw
      }
      if (planId && record.plan_id !== planId) continue;

      if (records.length >= boundedLimit) {
        // `lastIncluded` is always set here: reaching this branch requires
        // `boundedLimit` (>= 1) records already pushed.
        nextCursor = encodeCursor(lastIncluded.date, lastIncluded.idx);
        break fileLoop;
      }
      records.push(record);
      lastIncluded = { date, idx };
    }
  }

  return nextCursor ? { records, next_cursor: nextCursor } : { records };
}
