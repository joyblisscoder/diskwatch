import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { nowSec, parseLocalTs, dayKey } from '../util/time.js';

export const DISKGUARD_SOURCE = 'disk-guard.log';
export const DISKGUARD_PATH = path.join(
  os.homedir(),
  '.claude',
  'scripts',
  'disk-guard.log',
);

const RE_REAPED =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) reaped (\S+) \((.+)\)$/;
const RE_PRUNED = /^PRUNED (\S+) \((\d+) KiB logical\)$/;
const RE_ALERT =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) disk alert (delivery failed|unavailable.*)$/;
const RE_SKIP =
  /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) (SKIP|WOULD REAP) /;

/**
 * Parse one disk-guard.log line.
 * @param {string} line
 * @param {{ fileMtimeSec?: number }} [ctx]
 * @returns {{ type: string, action?: object, event?: object, raw?: string }}
 */
export function parseDiskguardLine(line, ctx = {}) {
  const raw = String(line);
  if (raw.trim() === '') return { type: 'blank' };

  let m = RE_REAPED.exec(raw);
  if (m) {
    return {
      type: 'action',
      action: {
        mode: 'external',
        rule_key: 'worktree.reap',
        outcome: 'success',
        target_path: m[2],
        started_at: parseLocalTs(m[1]),
        freed_kb: null,
        command: null,
        exit_code: null,
        finished_at: null,
        size_before_kb: null,
        size_after_kb: null,
        free_before_kb: null,
        free_after_kb: null,
        preflight_json: null,
        verify_json: null,
        quarantine_path: null,
        suggestion_id: null,
        detail: m[3],
      },
    };
  }

  m = RE_PRUNED.exec(raw);
  if (m) {
    const mtimeSec = ctx.fileMtimeSec ?? nowSec();
    const day = dayKey(mtimeSec);
    const [y, mo, d] = day.split('-').map(Number);
    const noon = Math.floor(new Date(y, mo - 1, d, 12, 0, 0).getTime() / 1000);
    return {
      type: 'action',
      action: {
        mode: 'external',
        rule_key: 'codesign.clones',
        outcome: 'success',
        target_path: m[1],
        started_at: noon,
        freed_kb: Number(m[2]),
        command: null,
        exit_code: null,
        finished_at: null,
        size_before_kb: null,
        size_after_kb: null,
        free_before_kb: null,
        free_after_kb: null,
        preflight_json: null,
        verify_json: null,
        quarantine_path: null,
        suggestion_id: null,
      },
    };
  }

  m = RE_ALERT.exec(raw);
  if (m) {
    return {
      type: 'event',
      event: {
        kind: 'external_alert_lost',
        severity: 'critical',
        headline: `disk alert ${m[2]}`,
        detail: {
          body: 'unrecoverable',
          match: m[2],
          at_local: m[1],
        },
        at: parseLocalTs(m[1]),
      },
    };
  }

  if (RE_SKIP.test(raw)) return { type: 'ignored' };

  return { type: 'unparsed', raw };
}

function getCursor(db, source) {
  const row = db.prepare('SELECT bytes_read FROM ingest_cursors WHERE source = ?').get(source);
  return row ? Number(row.bytes_read) : 0;
}

function setCursor(db, source, bytesRead, lineHash) {
  db.prepare(
    `INSERT INTO ingest_cursors (source, bytes_read, last_line_hash, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source) DO UPDATE SET
       bytes_read = excluded.bytes_read,
       last_line_hash = excluded.last_line_hash,
       updated_at = excluded.updated_at`,
  ).run(source, bytesRead, lineHash, nowSec());
}

function insertAction(db, a) {
  db.prepare(
    `INSERT INTO actions (
       suggestion_id, rule_key, target_path, mode, command, preflight_json,
       started_at, finished_at, exit_code, size_before_kb, size_after_kb, freed_kb,
       free_before_kb, free_after_kb, verify_json, outcome, quarantine_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    a.suggestion_id ?? null,
    a.rule_key,
    a.target_path,
    a.mode,
    a.command ?? null,
    a.preflight_json ?? null,
    a.started_at,
    a.finished_at ?? null,
    a.exit_code ?? null,
    a.size_before_kb ?? null,
    a.size_after_kb ?? null,
    a.freed_kb ?? null,
    a.free_before_kb ?? null,
    a.free_after_kb ?? null,
    a.verify_json ?? null,
    a.outcome,
    a.quarantine_path ?? null,
  );
}

function upsertOpenEvent(db, { kind, severity, headline, detail, at, path_id = null, scan_id = null }) {
  const open = db
    .prepare(
      `SELECT id FROM events
       WHERE kind = ? AND open = 1 AND (
         (path_id IS NULL AND ? IS NULL) OR path_id = ?
       )
       LIMIT 1`,
    )
    .get(kind, path_id, path_id);
  const detailJson = JSON.stringify(detail ?? {});
  if (open) {
    db.prepare(
      `UPDATE events SET last_seen = ?, count = count + 1, severity = ?,
         headline = ?, detail_json = ?, scan_id = COALESCE(?, scan_id)
       WHERE id = ?`,
    ).run(at, severity, headline, detailJson, scan_id, open.id);
    return open.id;
  }
  const info = db
    .prepare(
      `INSERT INTO events (at, scan_id, path_id, kind, severity, headline, detail_json, open, last_seen, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
    )
    .run(at, scan_id, path_id, kind, severity, headline, detailJson, at);
  return Number(info.lastInsertRowid);
}

function storeUnparsed(db, source, lineNo, raw) {
  db.prepare(
    `INSERT INTO ingest_unparsed (source, line_no, raw, first_seen)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(source, line_no) DO NOTHING`,
  ).run(source, lineNo, raw, nowSec());
}

function countCompletedLines(filePath, byteCount) {
  if (byteCount <= 0) return 0;
  const fd = fs.openSync(filePath, 'r');
  try {
    const head = Buffer.alloc(byteCount);
    fs.readSync(fd, head, 0, byteCount, 0);
    const text = head.toString('utf8');
    // Number of newline-terminated lines in the prefix
    let n = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') n++;
    }
    return n;
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Idempotent ingest of ~/.claude/scripts/disk-guard.log via byte cursor.
 * On shrunk file (rotation) resets cursor to 0.
 */
export function ingestDiskguard(db) {
  const source = DISKGUARD_SOURCE;
  let st;
  try {
    st = fs.statSync(DISKGUARD_PATH);
  } catch {
    return { ok: true, missing: true, actions: 0, events: 0, unparsed: 0 };
  }

  let cursor = getCursor(db, source);
  if (cursor > st.size) cursor = 0;

  const fd = fs.openSync(DISKGUARD_PATH, 'r');
  let buf;
  try {
    const len = st.size - cursor;
    buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, cursor);
  } finally {
    fs.closeSync(fd);
  }

  const text = buf.toString('utf8');
  const lines = text.split('\n');
  let trailingPartial = '';
  if (text.length > 0 && !text.endsWith('\n')) {
    trailingPartial = lines.pop() || '';
  } else if (lines.length > 0 && lines[lines.length - 1] === '') {
    // trailing empty string from final newline is not a line
    lines.pop();
  }
  const completeLines = lines;

  const fileMtimeSec = Math.floor(st.mtimeMs / 1000);
  let lineNo = countCompletedLines(DISKGUARD_PATH, cursor) + 1;

  let actions = 0;
  let events = 0;
  let unparsed = 0;
  let lastHash = null;
  let sawUnparsed = false;

  for (const line of completeLines) {
    const parsed = parseDiskguardLine(line, { fileMtimeSec });
    lastHash = crypto.createHash('sha256').update(line).digest('hex').slice(0, 16);

    if (parsed.type === 'action') {
      insertAction(db, parsed.action);
      actions++;
    } else if (parsed.type === 'event') {
      const e = parsed.event;
      upsertOpenEvent(db, {
        kind: e.kind,
        severity: e.severity,
        headline: e.headline,
        detail: e.detail,
        at: e.at,
      });
      events++;
    } else if (parsed.type === 'unparsed') {
      storeUnparsed(db, source, lineNo, line);
      unparsed++;
      sawUnparsed = true;
    }
    lineNo++;
  }

  if (sawUnparsed) {
    upsertOpenEvent(db, {
      kind: 'log_format_drift',
      severity: 'warn',
      headline: 'disk-guard.log has unparsed lines',
      detail: { source, unparsed },
      at: nowSec(),
    });
  }

  // Advance past complete lines only; hold a trailing partial line for next read
  const newCursor = cursor + buf.length - Buffer.byteLength(trailingPartial, 'utf8');
  setCursor(db, source, newCursor, lastHash);
  return { ok: true, actions, events, unparsed, bytes_read: newCursor };
}
