/**
 * Telegram notifications via hermes, with fingerprint dedupe and retry ladder.
 * Phase 1: critical free_low (on OPEN), external_alert_lost, weekly canary.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureStateDir as ensureDwState, statePath, notificationChannel } from '../config.js';
import { nowSec } from '../util/time.js';

const DAY_SEC = 86400;
const RETRY_1_SEC = 60;
const RETRY_2_SEC = 300;
const MAX_ATTEMPT = 3;

const FALLBACK_STATE = path.join(os.homedir(), '.local', 'state', 'diskwatch');

function resolveStateDir() {
  if (process.env.DISKWATCH_STATE_DIR) return process.env.DISKWATCH_STATE_DIR;
  try {
    ensureDwState();
    return statePath();
  } catch {
    return FALLBACK_STATE;
  }
}

function hermesBin() {
  return process.env.HERMES_BIN || path.join(os.homedir(), '.local/bin/hermes');
}

function undeliveredPath(stateDir) {
  return path.join(stateDir, 'UNDELIVERED');
}

function ensureStateDir(stateDir) {
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
}

function runHermes(body) {
  return spawnSync(
    hermesBin(),
    ['send', '--to', 'telegram', '--json', '--quiet', String(body)],
    { encoding: 'utf8', timeout: 60_000 }
  );
}

function deliver(channel, subject, body) {
  if (channel === 'telegram') return runHermes(body);
  if (channel !== 'macos') return { status: 1, stderr: `Disabled or unsupported channel: ${channel}` };
  const result = spawnSync('osascript', ['-e',
    'on run argv\n display notification (item 2 of argv) with title (item 1 of argv)\nend run',
    String(subject || 'DiskWatch'), String(body)], { encoding: 'utf8', timeout: 15_000 });
  return { ...result, stdout: result.status === 0 ? '{"submitted":true}' : result.stdout };
}

function stdoutIsJson(stdout) {
  try {
    JSON.parse(String(stdout ?? ''));
    return true;
  } catch {
    return false;
  }
}

function applyAttempt(db, id, attempt, result) {
  const exitCode = result.status === null || result.status === undefined ? -1 : result.status;
  const stdout = result.stdout == null ? '' : String(result.stdout);
  const stderr = result.stderr == null ? '' : String(result.stderr);
  const ok = exitCode === 0 && stdoutIsJson(stdout);
  const deliveredAt = ok ? nowSec() : null;

  db.prepare(
    `UPDATE notifications
     SET attempt = ?, exit_code = ?, stdout = ?, stderr = ?,
         delivered_at = CASE WHEN ? IS NOT NULL THEN ? ELSE delivered_at END
     WHERE id = ?`
  ).run(attempt, exitCode, stdout, stderr, deliveredAt, deliveredAt, id);

  return ok;
}

function escalate(db, row, stateDir) {
  if (row.escalated_at) return;
  ensureStateDir(stateDir);
  const marker = undeliveredPath(stateDir);
  const line = `notification id=${row.id} fingerprint=${row.fingerprint} failed after ${MAX_ATTEMPT} attempts\n`;
  fs.writeFileSync(marker, line, 'utf8');
  spawnSync(
    'osascript',
    [
      '-e',
      `display notification "DiskWatch alert could not be delivered (id ${row.id})" with title "DiskWatch"`,
    ],
    { encoding: 'utf8', timeout: 15_000 }
  );
  db.prepare(`UPDATE notifications SET escalated_at = ? WHERE id = ?`).run(nowSec(), row.id);
}

/**
 * Clear <state>/UNDELIVERED when every notification row has been delivered.
 */
export function clearUndeliveredIfClean(db, stateDir = resolveStateDir()) {
  const row = db
    .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE delivered_at IS NULL`)
    .get();
  if (!row || row.c !== 0) return false;
  const marker = undeliveredPath(stateDir);
  if (fs.existsSync(marker)) fs.unlinkSync(marker);
  return true;
}

/**
 * Insert notification body first, then attempt hermes send.
 * Fingerprint dedupe: at most one send per fingerprint per 24h.
 * @returns {{ skipped?: boolean, reason?: string, id?: number, delivered?: boolean }}
 */
export function send(db, subject, body, fingerprint, opts = {}) {
  const channel = opts.channel || notificationChannel();
  if (channel === 'none') return { skipped: true, reason: 'disabled' };
  const stateDir = opts.stateDir || resolveStateDir();
  const t = nowSec();

  if (!opts.force) {
    const recent = db
      .prepare(
        `SELECT id FROM notifications
         WHERE fingerprint = ? AND created_at >= ?
         LIMIT 1`
      )
      .get(fingerprint, t - DAY_SEC);
    if (recent) {
      return { skipped: true, reason: 'dedupe', id: recent.id };
    }
  }

  const info = db
    .prepare(
      `INSERT INTO notifications
         (created_at, channel, fingerprint, subject, body, attempt)
       VALUES (?, ?, ?, ?, ?, 0)`
    )
    .run(t, channel, fingerprint, subject ?? null, String(body));

  const id = Number(info.lastInsertRowid);
  const result = deliver(channel, subject, body);
  const delivered = applyAttempt(db, id, 1, result);

  if (delivered) {
    clearUndeliveredIfClean(db, stateDir);
  }

  return { id, delivered, skipped: false };
}

function isRetryDue(row, t) {
  if (row.delivered_at != null) return false;
  if (row.attempt >= MAX_ATTEMPT) return false;
  if (row.attempt <= 0) return true;
  if (row.attempt === 1) return t >= row.created_at + RETRY_1_SEC;
  if (row.attempt === 2) return t >= row.created_at + RETRY_2_SEC;
  return false;
}

/**
 * Retry undelivered rows: attempt 1 immediate (via send), attempt 2 at +60s,
 * attempt 3 at +300s from created_at. After attempt 3 fails: UNDELIVERED + osascript.
 */
export function processRetries(db, opts = {}) {
  if (notificationChannel() === 'none') return [];
  const stateDir = opts.stateDir || resolveStateDir();
  const t = nowSec();
  const rows = db
    .prepare(
      `SELECT * FROM notifications
       WHERE delivered_at IS NULL AND attempt < ?
       ORDER BY id ASC`
    )
    .all(MAX_ATTEMPT);

  const out = [];
  for (const row of rows) {
    if (!isRetryDue(row, t)) continue;

    const nextAttempt = row.attempt + 1;
    const result = deliver(row.channel, row.subject, row.body);
    const delivered = applyAttempt(db, row.id, nextAttempt, result);

    if (delivered) {
      clearUndeliveredIfClean(db, stateDir);
      out.push({ id: row.id, delivered: true, attempt: nextAttempt });
      continue;
    }

    if (nextAttempt >= MAX_ATTEMPT) {
      const fresh = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(row.id);
      escalate(db, fresh, stateDir);
    }
    out.push({ id: row.id, delivered: false, attempt: nextAttempt });
  }
  return out;
}

/**
 * Weekly canary: prove the alert path works. Sets meta.last_verified_delivery on success.
 */
export function canary(db, opts = {}) {
  const scan = db
    .prepare(
      `SELECT vol_free_kb FROM scans
       WHERE vol_free_kb IS NOT NULL
       ORDER BY started_at DESC LIMIT 1`
    )
    .get();

  let freeLabel = '?';
  if (scan && scan.vol_free_kb != null) {
    freeLabel = (scan.vol_free_kb / (1024 * 1024)).toFixed(1);
  }

  const body = `DiskWatch weekly canary: alert path is alive. Free ${freeLabel}GB.`;
  const subject = 'DiskWatch canary';
  const fingerprint = opts.fingerprint || `canary:${nowSec()}`;

  const result = send(db, subject, body, fingerprint, { force: !!opts.force, stateDir: opts.stateDir });

  if (result.delivered) {
    db.prepare(
      `INSERT INTO meta (k, v) VALUES ('last_verified_delivery', ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`
    ).run(String(nowSec()));
  }

  return result;
}

/**
 * Phase 1: notify on critical free_low transitions (open only) and external_alert_lost.
 * Canary is invoked separately via the canary command.
 */
export function maybeNotifyCriticalEvents(db, opts = {}) {
  const sent = [];

  const freeLows = db
    .prepare(
      `SELECT id, at, headline, detail_json, severity
       FROM events
       WHERE kind = 'free_low' AND severity = 'critical' AND open = 1`
    )
    .all();

  for (const ev of freeLows) {
    const fingerprint = `event:free_low:critical:${ev.id}:${ev.at}`;
    const subject = 'DiskWatch critical: free disk low';
    const body = ev.headline || 'Free disk space is critically low.';
    const r = send(db, subject, body, fingerprint, opts);
    if (!r.skipped) sent.push({ kind: 'free_low', ...r });
  }

  const lost = db
    .prepare(
      `SELECT id, at, headline, detail_json
       FROM events
       WHERE kind = 'external_alert_lost' AND open = 1`
    )
    .all();

  for (const ev of lost) {
    const fingerprint = `event:external_alert_lost:${ev.id}:${ev.at}`;
    const subject = 'DiskWatch critical: external alert lost';
    const body =
      ev.headline ||
      'An external disk alert failed to deliver; the body is unrecoverable.';
    const r = send(db, subject, body, fingerprint, opts);
    if (!r.skipped) sent.push({ kind: 'external_alert_lost', ...r });
  }

  return sent;
}
