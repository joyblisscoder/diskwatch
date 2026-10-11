import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { ensureStateDir, dbPath } from '../config.js';

function applyPragmas(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
}

/** Open the DiskWatch DB for read/write. Creates the state dir if needed. */
export function open() {
  ensureStateDir();
  const db = new DatabaseSync(dbPath());
  applyPragmas(db);
  return db;
}

/** Open the DiskWatch DB read-only (status/report paths). */
export function openReadOnly() {
  const db = new DatabaseSync(dbPath(), { readOnly: true });
  // journal_mode/foreign_keys are no-ops or restricted in read-only; busy_timeout still helps.
  try {
    db.exec('PRAGMA busy_timeout = 5000');
  } catch {
    /* read-only may reject some pragmas */
  }
  return db;
}

export function close(db) {
  if (db && typeof db.close === 'function') db.close();
}

/** On-disk size of the DB file in bytes. 0 if missing. */
export function dbFileSizeBytes(filePath = dbPath()) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}
