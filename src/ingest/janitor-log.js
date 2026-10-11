import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { nowSec, parseLocalTs } from '../util/time.js';

export const JANITOR_SOURCE = 'disk-janitor.log';
export const JANITOR_PATH = path.join(
  os.homedir(),
  '.local',
  'state',
  'disk-janitor.log',
);

const RE_HEADER = /^=== disk-janitor run (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) ===\s*$/;
const RE_FREED = /freed\s*~(\d+)MB/i;

/**
 * Split janitor log text into blocks.
 * Each block starts at `=== disk-janitor run YYYY-MM-DD HH:MM ===`.
 * @returns {Array<{ started_at: number, freed_kb: number|null, raw: string, header: string }>}
 */
export function parseJanitorBlocks(text) {
  const lines = String(text).split(/\n/);
  const blocks = [];
  let cur = null;

  const flush = () => {
    if (!cur) return;
    const freed = RE_FREED.exec(cur.raw);
    cur.freed_kb = freed ? Number(freed[1]) * 1024 : null;
    blocks.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const m = RE_HEADER.exec(line);
    if (m) {
      flush();
      // Header has HH:MM only; treat as HH:MM:00 local
      const started_at = parseLocalTs(`${m[1]}:00`);
      cur = { started_at, freed_kb: null, raw: line + '\n', header: line };
      continue;
    }
    if (cur) cur.raw += line + '\n';
  }
  flush();
  return blocks;
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
    null,
    a.rule_key,
    a.target_path,
    a.mode,
    null,
    null,
    a.started_at,
    null,
    null,
    null,
    null,
    a.freed_kb,
    null,
    null,
    null,
    a.outcome,
    null,
  );
}

/**
 * Idempotent ingest of ~/.local/state/disk-janitor.log.
 * Each run block -> one actions row (mode=external, rule_key=janitor.weekly).
 */
export function ingestJanitor(db) {
  const source = JANITOR_SOURCE;
  let st;
  try {
    st = fs.statSync(JANITOR_PATH);
  } catch {
    return { ok: true, missing: true, actions: 0 };
  }

  let cursor = getCursor(db, source);
  if (cursor > st.size) cursor = 0;

  // For block-oriented logs, re-parse from start of file when cursor is mid-content
  // is unsafe. We read only new bytes and parse complete blocks in the chunk.
  // On first run (cursor=0) parse the whole file.
  const fd = fs.openSync(JANITOR_PATH, 'r');
  let buf;
  try {
    const len = st.size - cursor;
    buf = Buffer.alloc(len);
    if (len > 0) fs.readSync(fd, buf, 0, len, cursor);
  } finally {
    fs.closeSync(fd);
  }

  let text = buf.toString('utf8');
  // If we start mid-file, drop bytes until the next header so we never split a block
  if (cursor > 0) {
    const idx = text.search(/^=== disk-janitor run /m);
    if (idx < 0) {
      // No complete new block yet; advance only if file ends with trailing content without header
      setCursor(db, source, st.size, null);
      return { ok: true, actions: 0, bytes_read: st.size };
    }
    // Count discarded prefix toward cursor advance
    const discarded = Buffer.byteLength(text.slice(0, idx), 'utf8');
    text = text.slice(idx);
    cursor += discarded;
  }

  // Hold back a trailing partial block (no following blank end guarantee): if file
  // ends without a final newline after content, still parse complete headers present.
  const blocks = parseJanitorBlocks(text);
  // If the file still growing mid-block, the last block is complete once we see it
  // (janitor writes the whole block at once). Accept all parsed blocks.

  let actions = 0;
  let lastHash = null;
  for (const b of blocks) {
    insertAction(db, {
      mode: 'external',
      rule_key: 'janitor.weekly',
      target_path: '~/.codex/sessions',
      outcome: 'success',
      started_at: b.started_at,
      freed_kb: b.freed_kb,
    });
    actions++;
    lastHash = crypto.createHash('sha256').update(b.header).digest('hex').slice(0, 16);
  }

  const newCursor = st.size;
  setCursor(db, source, newCursor, lastHash);
  return { ok: true, actions, bytes_read: newCursor };
}
