import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { send } from '../../src/notify/notify.js';
import { openTempDb } from '../helpers.js';

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../fixtures/hermes-stub.sh',
);

describe('notify send', () => {
  let prevHermes;
  let prevState;
  let stateDir;
  let proof;

  before(() => {
    prevHermes = process.env.HERMES_BIN;
    prevState = process.env.DISKWATCH_STATE_DIR;
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-notify-'));
    proof = path.join(stateDir, 'hermes-proof.txt');
    process.env.HERMES_BIN = FIXTURE;
    process.env.DISKWATCH_STATE_DIR = stateDir;
    process.env.DISKWATCH_HERMES_PROOF = proof;
  });

  after(() => {
    if (prevHermes === undefined) delete process.env.HERMES_BIN;
    else process.env.HERMES_BIN = prevHermes;
    if (prevState === undefined) delete process.env.DISKWATCH_STATE_DIR;
    else process.env.DISKWATCH_STATE_DIR = prevState;
    delete process.env.DISKWATCH_HERMES_PROOF;
    delete process.env.DISKWATCH_TEST_DB;
  });

  it('writes body to notifications before hermes send', () => {
    const { db, dbFile } = openTempDb();
    process.env.DISKWATCH_TEST_DB = dbFile;
    try {
      const body = 'DiskWatch unit test alert body';
      const result = send(db, 'DiskWatch test', body, `unit-test-before:${Date.now()}`, {
        stateDir,
        channel: 'telegram',
      });
      assert.equal(result.skipped, false);
      assert.equal(result.delivered, true);
      assert.ok(result.id > 0);

      const row = db.prepare(`SELECT * FROM notifications WHERE id = ?`).get(result.id);
      assert.equal(row.body, body);
      assert.ok(row.delivered_at != null);
      assert.equal(row.attempt, 1);
      assert.ok(fs.existsSync(proof));
      assert.match(fs.readFileSync(proof, 'utf8'), /unit test alert body/);
    } finally {
      db.close();
    }
  });

  it('skips second send with same fingerprint within 24h', () => {
    const { db, dbFile } = openTempDb();
    process.env.DISKWATCH_TEST_DB = dbFile;
    try {
      const fp = `unit-test-dedupe:${Date.now()}`;
      const first = send(db, 'subj', 'body one', fp, { stateDir, channel: 'telegram' });
      assert.equal(first.skipped, false);
      assert.equal(first.delivered, true);

      const second = send(db, 'subj', 'body two', fp, { stateDir, channel: 'telegram' });
      assert.equal(second.skipped, true);
      assert.equal(second.reason, 'dedupe');

      const count = db
        .prepare(`SELECT COUNT(*) AS c FROM notifications WHERE fingerprint = ?`)
        .get(fp);
      assert.equal(count.c, 1);
    } finally {
      db.close();
    }
  });
});
