import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrate } from '../../src/db/migrate.js';
import { open, close, dbFileSizeBytes } from '../../src/db/db.js';
import { dbPath } from '../../src/config.js';

describe('db migrate', () => {
  let prevState;
  let stateDir;

  before(() => {
    prevState = process.env.DISKWATCH_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-db-'));
    process.env.DISKWATCH_STATE_DIR = stateDir;
  });

  after(() => {
    if (prevState === undefined) delete process.env.DISKWATCH_STATE_DIR;
    else process.env.DISKWATCH_STATE_DIR = prevState;
  });

  it('migrate applies schema and sets schema_version=1', () => {
    migrate();
    const db = open();
    try {
      const row = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get();
      assert.equal(row.v, '1');

      const tables = db
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all()
        .map((r) => r.name);
      for (const name of [
        'meta',
        'paths',
        'scans',
        'samples',
        'daily_stats',
        'events',
        'notifications',
        'actions',
      ]) {
        assert.ok(tables.includes(name), `missing table ${name}`);
      }

      const journal = db.prepare('PRAGMA journal_mode').get();
      assert.ok(journal);
      const mode = String(journal.journal_mode || Object.values(journal)[0]).toLowerCase();
      assert.equal(mode, 'wal');
    } finally {
      close(db);
    }
  });

  it('dbFileSizeBytes reports a positive size after migrate', () => {
    const size = dbFileSizeBytes(dbPath());
    assert.ok(size > 0, `expected positive db size, got ${size}`);
  });
});
