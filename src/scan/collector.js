import fs from 'node:fs';
import path from 'node:path';
import { ensureStateDir, statePath, getConfig, expandHome } from '../config.js';
import { open, close } from '../db/db.js';
import { migrate } from '../db/migrate.js';
import { rollupScan } from '../learn/rollup.js';
import { processRetries, maybeNotifyCriticalEvents } from '../notify/notify.js';
import { runIngest } from '../ingest/run.js';
import { nowSec } from '../util/time.js';
import { append } from '../util/log.js';
import { measureVolume, duSk } from './volume.js';
import {
  seedPaths,
  expandPath,
  getActiveTargets,
  discoverWorktrees,
  ensurePath,
} from './watchlist.js';

const LOCK_STALE_SEC = 30 * 60;
const GB_KB = 1024 * 1024;
const RESTART_RECLAIM_WARN_KB = 20 * GB_KB;
const TIMEOUT_PROMOTE_AFTER = 3;

function lockDir() {
  return statePath('collector.lock');
}

/**
 * Acquire mkdir lock. Returns { ok, reason?, lockPath } .
 * Stale (>=30 min) lock is removed and retaken.
 */
export function acquireLock() {
  const dir = lockDir();
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err && err.code === 'EEXIST') {
      let st;
      try {
        st = fs.statSync(dir);
      } catch {
        return { ok: false, reason: 'lock_stat_failed', lockPath: dir };
      }
      const ageSec = nowSec() - Math.floor(st.mtimeMs / 1000);
      if (ageSec < LOCK_STALE_SEC) {
        return { ok: false, reason: 'lock_held', lockPath: dir, ageSec };
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        return { ok: false, reason: 'lock_stale_remove_failed', lockPath: dir };
      }
      try {
        fs.mkdirSync(dir);
      } catch (e2) {
        return { ok: false, reason: 'lock_reacquire_failed', lockPath: dir, error: String(e2) };
      }
    } else {
      throw err;
    }
  }
  fs.writeFileSync(path.join(dir, 'pid'), String(process.pid) + '\n', 'utf8');
  return { ok: true, lockPath: dir };
}

export function releaseLock(lockPath = lockDir()) {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* already gone */
  }
}

/**
 * Open-event upsert: one open row per (kind, path_id).
 * On re-observation: last_seen + count++. Returns event id.
 */
export function upsertOpenEvent(db, {
  kind,
  severity,
  headline,
  detail_json,
  path_id = null,
  scan_id = null,
  at = null,
}) {
  const t = at ?? nowSec();
  const detail =
    typeof detail_json === 'string' ? detail_json : JSON.stringify(detail_json ?? {});
  const open = db
    .prepare(
      `SELECT id FROM events
       WHERE kind = ? AND open = 1
         AND ((path_id IS NULL AND ? IS NULL) OR path_id = ?)
       LIMIT 1`,
    )
    .get(kind, path_id, path_id);

  if (open) {
    db.prepare(
      `UPDATE events SET
         last_seen = ?, count = count + 1, severity = ?,
         headline = ?, detail_json = ?,
         scan_id = COALESCE(?, scan_id)
       WHERE id = ?`,
    ).run(t, severity, headline, detail, scan_id, open.id);
    return open.id;
  }

  const info = db
    .prepare(
      `INSERT INTO events
         (at, scan_id, path_id, kind, severity, headline, detail_json, open, last_seen, count)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1)`,
    )
    .run(t, scan_id, path_id, kind, severity, headline, detail, t);
  return Number(info.lastInsertRowid);
}

/** Close the open event for (kind, path_id), if any. */
export function closeOpenEvent(db, kind, pathId = null) {
  db.prepare(
    `UPDATE events SET open = 0
     WHERE kind = ? AND open = 1
       AND ((path_id IS NULL AND ? IS NULL) OR path_id = ?)`,
  ).run(kind, pathId, pathId);
}

function timeoutCount(status) {
  const m = /^timeout:(\d+)$/.exec(String(status || ''));
  return m ? Number(m[1]) : 0;
}

function recordSample(db, scanId, pathId, sizeKb, partial) {
  db.prepare(
    `INSERT INTO samples (scan_id, path_id, size_kb, partial)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(scan_id, path_id) DO UPDATE SET
       size_kb = excluded.size_kb,
       partial = excluded.partial`,
  ).run(scanId, pathId, sizeKb, partial ? 1 : 0);
}

function noteTimeout(db, pathId, pathStr, scanId) {
  const row = db.prepare('SELECT status, watch_tier FROM paths WHERE id = ?').get(pathId);
  const n = timeoutCount(row?.status) + 1;
  db.prepare(`UPDATE paths SET status = ? WHERE id = ?`).run(`timeout:${n}`, pathId);
  upsertOpenEvent(db, {
    kind: 'scan_timeout',
    severity: 'warn',
    headline: `du timed out: ${pathStr}`,
    detail_json: { path: pathStr, consecutive: n },
    path_id: pathId,
    scan_id: scanId,
  });
  if (n >= TIMEOUT_PROMOTE_AFTER && row?.watch_tier !== 'slow') {
    db.prepare(`UPDATE paths SET watch_tier = 'slow' WHERE id = ?`).run(pathId);
    upsertOpenEvent(db, {
      kind: 'scan_timeout',
      severity: 'warn',
      headline: `path demoted to slow after ${n} timeouts: ${pathStr}`,
      detail_json: { path: pathStr, consecutive: n, watch_tier: 'slow' },
      path_id: pathId,
      scan_id: scanId,
    });
  }
}

function clearTimeoutStatus(db, pathId) {
  const row = db.prepare('SELECT status FROM paths WHERE id = ?').get(pathId);
  if (row && String(row.status).startsWith('timeout:')) {
    db.prepare(`UPDATE paths SET status = 'ok' WHERE id = ?`).run(pathId);
  }
  // Do not auto-close scan_timeout on success; leave open-event until condition clears
  // Spec: scan_timeout is an event on timeout. Closing when path samples cleanly is reasonable.
  closeOpenEvent(db, 'scan_timeout', pathId);
}

function sampleOne(db, scanId, absPath, pathId) {
  const d = duSk(absPath);
  const partial = d.partial || d.timedOut ? 1 : 0;
  recordSample(db, scanId, pathId, d.size_kb || 0, partial);
  if (d.timedOut) {
    noteTimeout(db, pathId, absPath, scanId);
  } else {
    clearTimeoutStatus(db, pathId);
  }
  return d;
}

function runPhase1Events(db, scanId, volume, sampleSizes) {
  const cfg = getConfig();
  const th = cfg.thresholds || {};
  const freeWarnKb = (th.free_warn_gb ?? 40) * GB_KB;
  const freeCritKb = (th.free_critical_gb ?? 20) * GB_KB;
  const swapCapMb = (th.swap_cap_gb ?? 15) * 1024;
  const free = volume.vol_free_kb;

  // free_low
  if (free < freeCritKb) {
    upsertOpenEvent(db, {
      kind: 'free_low',
      severity: 'critical',
      headline: `Free disk critically low: ${(free / GB_KB).toFixed(1)} GB`,
      detail_json: { vol_free_kb: free, threshold_gb: th.free_critical_gb ?? 20 },
      scan_id: scanId,
    });
  } else if (free < freeWarnKb) {
    upsertOpenEvent(db, {
      kind: 'free_low',
      severity: 'warn',
      headline: `Free disk low: ${(free / GB_KB).toFixed(1)} GB`,
      detail_json: { vol_free_kb: free, threshold_gb: th.free_warn_gb ?? 40 },
      scan_id: scanId,
    });
  } else {
    closeOpenEvent(db, 'free_low', null);
  }

  // swap_high
  if (volume.swap_used_mb > swapCapMb) {
    upsertOpenEvent(db, {
      kind: 'swap_high',
      severity: 'warn',
      headline: `Swap high: ${(volume.swap_used_mb / 1024).toFixed(1)} GB`,
      detail_json: { swap_used_mb: volume.swap_used_mb, cap_gb: th.swap_cap_gb ?? 15 },
      scan_id: scanId,
    });
  } else {
    closeOpenEvent(db, 'swap_high', null);
  }

  // restart_reclaimable_high
  if (volume.restart_reclaim_kb >= RESTART_RECLAIM_WARN_KB) {
    upsertOpenEvent(db, {
      kind: 'restart_reclaimable_high',
      severity: 'warn',
      headline: `Restart would reclaim ~${(volume.restart_reclaim_kb / GB_KB).toFixed(1)} GB`,
      detail_json: { restart_reclaim_kb: volume.restart_reclaim_kb },
      scan_id: scanId,
    });
  } else {
    closeOpenEvent(db, 'restart_reclaimable_high', null);
  }

  // cap_exceeded: expand home keys from thresholds.caps
  const caps = th.caps || {};
  const seenCapPathIds = new Set();
  for (const [key, capGb] of Object.entries(caps)) {
    const abs = expandHome(key);
    const pathRow = db.prepare('SELECT id FROM paths WHERE path = ?').get(abs);
    const sizeKb =
      sampleSizes.get(abs) ??
      (pathRow
        ? db
            .prepare(
              `SELECT size_kb FROM samples WHERE path_id = ? AND scan_id = ?`,
            )
            .get(pathRow.id, scanId)?.size_kb
        : null);
    if (sizeKb == null || !pathRow) continue;
    seenCapPathIds.add(pathRow.id);
    const capKb = Number(capGb) * GB_KB;
    if (sizeKb > capKb) {
      upsertOpenEvent(db, {
        kind: 'cap_exceeded',
        severity: 'warn',
        headline: `Cap exceeded: ${key} ${(sizeKb / GB_KB).toFixed(1)} GB > ${capGb} GB`,
        detail_json: { path: abs, size_kb: sizeKb, cap_gb: capGb },
        path_id: pathRow.id,
        scan_id: scanId,
      });
    } else {
      closeOpenEvent(db, 'cap_exceeded', pathRow.id);
    }
  }
}

/**
 * Main collector pass.
 * @param {{ tier?: string, once?: boolean }} [opts]
 */
export function runCollector({ tier = 'hourly', once = true } = {}) {
  const stateDir = ensureStateDir();
  migrate();

  const lock = acquireLock();
  if (!lock.ok) {
    append(stateDir, 'collector', `skip lock_held reason=${lock.reason}`);
    return { ok: false, skipped: true, reason: lock.reason };
  }

  const db = open();
  let scanId = null;
  try {
    seedPaths(db);
    const volume = measureVolume();
    const started = nowSec();

    const info = db
      .prepare(
        `INSERT INTO scans (
           kind, scanner, started_at, vol_total_kb, vol_free_kb,
           swap_used_mb, restart_reclaim_kb, ok
         ) VALUES (?, 'collector', ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        tier,
        started,
        volume.vol_total_kb,
        volume.vol_free_kb,
        volume.swap_used_mb,
        volume.restart_reclaim_kb,
      );
    scanId = Number(info.lastInsertRowid);

    const sampleSizes = new Map();
    const targets = getActiveTargets(db, { tier });

    for (const t of targets) {
      if (t.mode === 'expand') {
        const expanded = expandPath(t.path);
        // Sample root
        const rootId = ensurePath(db, expanded.root.path, { added_by: 'seed' });
        recordSample(
          db,
          scanId,
          rootId,
          expanded.root.size_kb || 0,
          expanded.root.partial || expanded.root.timedOut ? 1 : 0,
        );
        sampleSizes.set(expanded.root.path, expanded.root.size_kb || 0);
        if (expanded.root.timedOut) {
          noteTimeout(db, rootId, expanded.root.path, scanId);
        } else {
          clearTimeoutStatus(db, rootId);
        }

        for (const ch of expanded.children) {
          const id = ensurePath(db, ch.path, { added_by: 'expand' });
          recordSample(db, scanId, id, ch.size_kb || 0, ch.partial || ch.timedOut ? 1 : 0);
          sampleSizes.set(ch.path, ch.size_kb || 0);
          if (ch.timedOut) noteTimeout(db, id, ch.path, scanId);
          else clearTimeoutStatus(db, id);
        }
        if (expanded.other) {
          const id = ensurePath(db, expanded.other.path, {
            added_by: 'expand',
            class: 'unknown',
          });
          recordSample(
            db,
            scanId,
            id,
            expanded.other.size_kb || 0,
            expanded.other.partial ? 1 : 0,
          );
          sampleSizes.set(expanded.other.path, expanded.other.size_kb || 0);
        }
      } else {
        // leaf
        const d = sampleOne(db, scanId, t.path, t.path_id);
        sampleSizes.set(t.path, d.size_kb || 0);
      }
    }

    // Dynamic worktrees
    const wt = discoverWorktrees();
    if (!wt.ok) {
      upsertOpenEvent(db, {
        kind: 'collector_degraded',
        severity: 'warn',
        headline: 'worktree discovery failed',
        detail_json: { error: wt.error },
        scan_id: scanId,
      });
    } else {
      closeOpenEvent(db, 'collector_degraded', null);
      for (const p of wt.paths) {
        const id = ensurePath(db, p, {
          class: 'worktree',
          watch_tier: 'dynamic',
          added_by: 'dynamic',
        });
        // Force class/tier in case path already existed
        db.prepare(
          `UPDATE paths SET class = 'worktree', watch_tier = 'dynamic', added_by = 'dynamic'
           WHERE id = ?`,
        ).run(id);
        const d = sampleOne(db, scanId, p, id);
        sampleSizes.set(p, d.size_kb || 0);
      }
    }

    rollupScan(db, scanId);
    runPhase1Events(db, scanId, volume, sampleSizes);

    try {
      runIngest(db);
    } catch (err) {
      append(stateDir, 'collector', `ingest_error ${err && err.message ? err.message : err}`);
    }

    try {
      processRetries(db);
    } catch (err) {
      append(stateDir, 'collector', `notify_retry_error ${err && err.message ? err.message : err}`);
    }

    try {
      maybeNotifyCriticalEvents(db);
    } catch (err) {
      append(stateDir, 'collector', `notify_error ${err && err.message ? err.message : err}`);
    }

    db.prepare(`UPDATE scans SET finished_at = ?, ok = 1 WHERE id = ?`).run(nowSec(), scanId);
    append(stateDir, 'collector', `scan_ok id=${scanId} tier=${tier} once=${once}`);

    return {
      ok: true,
      scan_id: scanId,
      tier,
      volume,
      once,
    };
  } catch (err) {
    if (scanId != null) {
      try {
        db.prepare(`UPDATE scans SET finished_at = ?, ok = 0 WHERE id = ?`).run(nowSec(), scanId);
      } catch {
        /* ignore */
      }
    }
    append(
      stateDir,
      'collector',
      `scan_fail ${err && err.stack ? err.stack : err}`,
    );
    throw err;
  } finally {
    close(db);
    releaseLock(lock.lockPath);
  }
}
