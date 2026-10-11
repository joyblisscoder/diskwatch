import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { open, close } from './db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Apply schema.sql idempotently and set meta.schema_version = 1. */
export function migrate() {
  const sqlPath = path.join(__dirname, 'schema.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const db = open();
  try {
    db.exec(sql);
    db.prepare(
      `INSERT INTO meta (k, v) VALUES (?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v`,
    ).run('schema_version', '1');
  } finally {
    close(db);
  }
}

export default migrate;
