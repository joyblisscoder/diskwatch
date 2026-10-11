/**
 * samples -> daily_stats rollup.
 * delta_kb = today's last_kb - previous day's last_kb (0 if no prior day).
 */

function dayKeyFromEpoch(epochSec) {
  const d = new Date(Number(epochSec) * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function previousDayLastKb(db, pathId, dayKey) {
  const row = db
    .prepare(
      `SELECT last_kb FROM daily_stats
       WHERE path_id = ? AND day < ?
       ORDER BY day DESC LIMIT 1`
    )
    .get(pathId, dayKey);
  return row ? row.last_kb : 0;
}

/**
 * Upsert min/max/last/delta/samples for one path on one day.
 * On first sample of the day: min=max=last=sizeKb, samples=1.
 * Same-day updates: refresh min/max/last, increment samples, recompute delta from prior day.
 */
export function updateDailyStats(db, pathId, sizeKb, dayKey) {
  const size = Number(sizeKb);
  const prevLast = previousDayLastKb(db, pathId, dayKey);
  const existing = db
    .prepare(`SELECT min_kb, max_kb, last_kb, samples FROM daily_stats WHERE path_id = ? AND day = ?`)
    .get(pathId, dayKey);

  if (!existing) {
    const delta = size - prevLast;
    db.prepare(
      `INSERT INTO daily_stats (path_id, day, min_kb, max_kb, last_kb, delta_kb, samples)
       VALUES (?, ?, ?, ?, ?, ?, 1)`
    ).run(pathId, dayKey, size, size, size, delta);
    return;
  }

  const minKb = Math.min(existing.min_kb, size);
  const maxKb = Math.max(existing.max_kb, size);
  const lastKb = size;
  const delta = lastKb - prevLast;
  const samples = existing.samples + 1;

  db.prepare(
    `UPDATE daily_stats
     SET min_kb = ?, max_kb = ?, last_kb = ?, delta_kb = ?, samples = ?
     WHERE path_id = ? AND day = ?`
  ).run(minKb, maxKb, lastKb, delta, samples, pathId, dayKey);
}

/**
 * For each sample in a scan, update that path's daily_stats for the scan's day.
 */
export function rollupScan(db, scanId) {
  const scan = db.prepare(`SELECT started_at FROM scans WHERE id = ?`).get(scanId);
  if (!scan) return;

  const dayKey = dayKeyFromEpoch(scan.started_at);
  const samples = db
    .prepare(`SELECT path_id, size_kb FROM samples WHERE scan_id = ?`)
    .all(scanId);

  for (const s of samples) {
    updateDailyStats(db, s.path_id, s.size_kb, dayKey);
  }
}

export { dayKeyFromEpoch };
