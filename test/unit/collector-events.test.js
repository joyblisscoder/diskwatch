import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { upsertOpenEvent, closeOpenEvent } from '../../src/scan/collector.js';
import { timedSpawn, duSk } from '../../src/scan/volume.js';
import { openTempDb } from '../helpers.js';

describe('collector open-event collapse', () => {
  it('8 free_low upserts collapse to one open row with count=8', () => {
    const { db } = openTempDb();
    try {
      for (let i = 0; i < 8; i++) {
        upsertOpenEvent(db, {
          kind: 'free_low',
          severity: 'warn',
          headline: 'Free disk low: 35.0 GB',
          detail_json: { vol_free_kb: 35 * 1024 * 1024 },
          at: 1_700_000_000 + i,
        });
      }
      const rows = db
        .prepare(`SELECT id, open, count, kind FROM events WHERE kind = 'free_low'`)
        .all();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].open, 1);
      assert.equal(rows[0].count, 8);

      closeOpenEvent(db, 'free_low', null);
      const closed = db.prepare(`SELECT open FROM events WHERE kind = 'free_low'`).get();
      assert.equal(closed.open, 0);
    } finally {
      db.close();
    }
  });
});

describe('collector timeout handling', () => {
  it('timedSpawn marks hanging sleep as timedOut', () => {
    const r = timedSpawn('sleep', ['30'], 200);
    assert.equal(r.timedOut, true);
  });

  it('duSk reports missing path without timing out', () => {
    const r = duSk('/tmp/diskwatch-does-not-exist-timeout-test-xyz', 500);
    assert.equal(r.missing, true);
    assert.equal(r.timedOut, false);
    assert.equal(r.size_kb, 0);
  });
});
