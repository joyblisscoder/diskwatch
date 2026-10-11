import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { updateDailyStats } from '../../src/learn/rollup.js';
import { openTempDb, seedPath } from '../helpers.js';

describe('rollup updateDailyStats', () => {
  it('first sample inserts min=max=last and samples=1', () => {
    const { db } = openTempDb();
    try {
      const pathId = seedPath(db, '/tmp/diskwatch-rollup-a');
      updateDailyStats(db, pathId, 1000, '2026-08-30');
      const row = db
        .prepare(`SELECT * FROM daily_stats WHERE path_id = ? AND day = ?`)
        .get(pathId, '2026-08-30');
      assert.equal(row.min_kb, 1000);
      assert.equal(row.max_kb, 1000);
      assert.equal(row.last_kb, 1000);
      assert.equal(row.samples, 1);
      assert.equal(row.delta_kb, 1000);
    } finally {
      db.close();
    }
  });

  it('second sample same day updates min/max/last/samples', () => {
    const { db } = openTempDb();
    try {
      const pathId = seedPath(db, '/tmp/diskwatch-rollup-b');
      updateDailyStats(db, pathId, 1000, '2026-08-30');
      updateDailyStats(db, pathId, 2500, '2026-08-30');
      const row = db
        .prepare(`SELECT * FROM daily_stats WHERE path_id = ? AND day = ?`)
        .get(pathId, '2026-08-30');
      assert.equal(row.min_kb, 1000);
      assert.equal(row.max_kb, 2500);
      assert.equal(row.last_kb, 2500);
      assert.equal(row.samples, 2);
    } finally {
      db.close();
    }
  });

  it('delta is versus previous day last_kb', () => {
    const { db } = openTempDb();
    try {
      const pathId = seedPath(db, '/tmp/diskwatch-rollup-c');
      updateDailyStats(db, pathId, 5000, '2026-08-29');
      updateDailyStats(db, pathId, 8000, '2026-08-30');
      const today = db
        .prepare(`SELECT delta_kb, last_kb FROM daily_stats WHERE path_id = ? AND day = ?`)
        .get(pathId, '2026-08-30');
      assert.equal(today.last_kb, 8000);
      assert.equal(today.delta_kb, 3000);
    } finally {
      db.close();
    }
  });
});
