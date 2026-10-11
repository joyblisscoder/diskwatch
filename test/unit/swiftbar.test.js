import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildSwiftbar, swiftbarError } from '../../src/report/report.js';
import { nowSec } from '../../src/util/time.js';
import { openTempDb, seedPath } from '../helpers.js';

describe('buildSwiftbar', () => {
  it('healthy seeded db yields non-empty markup', () => {
    const { db } = openTempDb();
    try {
      const t = nowSec();
      seedPath(db, '/tmp/diskwatch-swiftbar-path', { class: 'source_tree' });
      db.prepare(
        `INSERT INTO scans (
           kind, scanner, started_at, finished_at,
           vol_total_kb, vol_free_kb, swap_used_mb, restart_reclaim_kb, ok
         ) VALUES ('hourly', 'collector', ?, ?, ?, ?, 512, 0, 1)`,
      ).run(t - 120, t - 100, 500 * 1024 * 1024, 120 * 1024 * 1024);

      const out = buildSwiftbar(db);
      assert.ok(out.length > 0);
      assert.match(out, /GB free/);
      assert.match(out, /Open dashboard/);
    } finally {
      db.close();
    }
  });

  it('missing DB / error path is non-empty via swiftbarError', () => {
    const out = swiftbarError('db unavailable');
    assert.ok(out.length > 0);
    assert.match(out, /DW !/);
    assert.match(out, /db unavailable/);
  });

  it('buildSwiftbar catch path is non-empty for a broken db handle', () => {
    const broken = {
      prepare() {
        throw new Error('simulated db failure');
      },
    };
    const out = buildSwiftbar(broken);
    assert.ok(out.length > 0);
    assert.match(out, /DW !/);
  });

  it('doctor-fail-ish report still yields non-empty swiftbar', () => {
    const { db } = openTempDb();
    try {
      const t = nowSec();
      db.prepare(
        `INSERT INTO scans (
           kind, scanner, started_at, finished_at,
           vol_total_kb, vol_free_kb, swap_used_mb, restart_reclaim_kb, ok
         ) VALUES ('hourly', 'collector', ?, ?, ?, ?, 20000, 0, 1)`,
      ).run(t - 60, t - 30, 500 * 1024 * 1024, 10 * 1024 * 1024);
      // Open critical free_low so doctor/report paths still render markup.
      db.prepare(
        `INSERT INTO events (at, kind, severity, headline, detail_json, open, last_seen, count)
         VALUES (?, 'free_low', 'critical', 'Free disk critically low', '{}', 1, ?, 1)`,
      ).run(t, t);

      const out = buildSwiftbar(db);
      assert.ok(out.length > 0);
      assert.match(out, /GB free|DW !/);
    } finally {
      db.close();
    }
  });
});
