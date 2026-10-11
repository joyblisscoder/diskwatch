import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../src/db/schema.sql',
);

/** Open a temp SQLite DB with schema.sql applied. Caller should close db. */
export function openTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-unit-'));
  const dbFile = path.join(dir, 'diskwatch.db');
  const db = new DatabaseSync(dbFile);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(fs.readFileSync(SCHEMA, 'utf8'));
  db.prepare(
    `INSERT INTO meta (k, v) VALUES (?, ?)
     ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
  ).run('schema_version', '1');
  return { db, dir, dbFile };
}

export function seedPath(db, absPath, opts = {}) {
  const t = Math.floor(Date.now() / 1000);
  const info = db
    .prepare(
      `INSERT INTO paths (
         path, class, owner, watch_tier, regen_command, protected, kp_id,
         added_by, first_seen_at, last_seen_at, active, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ok')`,
    )
    .run(
      absPath,
      opts.class ?? 'unknown',
      opts.owner ?? null,
      opts.watch_tier ?? 'hourly',
      opts.regen_command ?? null,
      opts.protected ?? 0,
      opts.kp_id ?? null,
      opts.added_by ?? 'seed',
      t,
      t,
    );
  return Number(info.lastInsertRowid);
}
