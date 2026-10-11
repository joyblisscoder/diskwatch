import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildReport } from '../../src/report/report.js';
import { nowSec } from '../../src/util/time.js';
import { openTempDb, seedPath } from '../helpers.js';

function seedSmallReportDb(db) {
  const t = nowSec();
  const pathId = seedPath(db, '/tmp/diskwatch-report-path', {
    class: 'source_tree',
    watch_tier: 'hourly',
  });
  const scan = db
    .prepare(
      `INSERT INTO scans (
         kind, scanner, started_at, finished_at,
         vol_total_kb, vol_free_kb, swap_used_mb, restart_reclaim_kb, ok
       ) VALUES ('hourly', 'collector', ?, ?, ?, ?, ?, ?, 1)`,
    )
    .run(t - 60, t - 30, 500 * 1024 * 1024, 90 * 1024 * 1024, 1024, 5 * 1024 * 1024);
  const scanId = Number(scan.lastInsertRowid);
  db.prepare(
    `INSERT INTO samples (scan_id, path_id, size_kb, partial) VALUES (?, ?, ?, 0)`,
  ).run(scanId, pathId, 4096);
  return { scanId, pathId };
}

describe('buildReport', () => {
  it('envelope has required fields', () => {
    const { db } = openTempDb();
    try {
      seedSmallReportDb(db);
      const report = buildReport(db);
      assert.equal(report.schema_version, 1);
      assert.ok(typeof report.generated_at === 'number');
      assert.ok(report.as_of != null);
      assert.ok('staleness_seconds' in report);
      assert.ok('stale' in report);
      assert.ok(report.doctor && typeof report.doctor.status === 'string');
      assert.ok(Array.isArray(report.doctor.failing));
      assert.ok(report.data);
      assert.ok('free_gb' in report.data);
      assert.ok('total_gb' in report.data);
      assert.ok('triage' in report.data);
      assert.ok(Array.isArray(report.data.top_movers));
      assert.ok(Array.isArray(report.data.open_events));
      assert.ok(Array.isArray(report.data.last_external_actions));
    } finally {
      db.close();
    }
  });

  it('JSON.stringify length is <= 4096 on a seeded small db', () => {
    const { db } = openTempDb();
    try {
      seedSmallReportDb(db);
      const report = buildReport(db);
      const json = JSON.stringify(report);
      assert.ok(json.length <= 4096, `report JSON length ${json.length}`);
    } finally {
      db.close();
    }
  });
});
