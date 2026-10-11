PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS paths (
  id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE,
  class TEXT NOT NULL DEFAULT 'unknown', owner TEXT,
  watch_tier TEXT NOT NULL, regen_command TEXT,
  protected INTEGER NOT NULL DEFAULT 0, kp_id TEXT,
  added_by TEXT NOT NULL DEFAULT 'seed',
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'ok'
);
CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, scanner TEXT NOT NULL,
  started_at INTEGER NOT NULL, finished_at INTEGER,
  vol_total_kb INTEGER, vol_free_kb INTEGER, swap_used_mb INTEGER,
  restart_reclaim_kb INTEGER, ok INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_scans_time ON scans(started_at DESC);
CREATE TABLE IF NOT EXISTS samples (
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  path_id INTEGER NOT NULL REFERENCES paths(id),
  size_kb INTEGER NOT NULL, partial INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scan_id, path_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_samples_path ON samples(path_id, scan_id DESC);
CREATE TABLE IF NOT EXISTS daily_stats (
  path_id INTEGER NOT NULL REFERENCES paths(id), day TEXT NOT NULL,
  min_kb INTEGER NOT NULL, max_kb INTEGER NOT NULL, last_kb INTEGER NOT NULL,
  delta_kb INTEGER NOT NULL, samples INTEGER NOT NULL,
  PRIMARY KEY (path_id, day)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, scan_id INTEGER,
  path_id INTEGER, kind TEXT NOT NULL, severity TEXT NOT NULL,
  headline TEXT NOT NULL, detail_json TEXT NOT NULL,
  open INTEGER NOT NULL DEFAULT 0, last_seen INTEGER, count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_events_time ON events(at DESC);
CREATE INDEX IF NOT EXISTS idx_events_open ON events(kind, open);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, channel TEXT NOT NULL,
  fingerprint TEXT NOT NULL, subject TEXT, body TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0, exit_code INTEGER, stdout TEXT, stderr TEXT,
  delivered_at INTEGER, escalated_at INTEGER
);
CREATE TABLE IF NOT EXISTS ingest_cursors (
  source TEXT PRIMARY KEY, bytes_read INTEGER NOT NULL,
  last_line_hash TEXT, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ingest_unparsed (
  source TEXT NOT NULL, line_no INTEGER NOT NULL, raw TEXT NOT NULL, first_seen INTEGER NOT NULL,
  PRIMARY KEY (source, line_no)
);
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY, suggestion_id INTEGER, rule_key TEXT NOT NULL,
  target_path TEXT NOT NULL, mode TEXT NOT NULL, command TEXT,
  preflight_json TEXT, started_at INTEGER NOT NULL, finished_at INTEGER,
  exit_code INTEGER, size_before_kb INTEGER, size_after_kb INTEGER, freed_kb INTEGER,
  free_before_kb INTEGER, free_after_kb INTEGER, verify_json TEXT,
  outcome TEXT NOT NULL, quarantine_path TEXT
);
CREATE INDEX IF NOT EXISTS idx_actions_time ON actions(started_at DESC);
CREATE TABLE IF NOT EXISTS queries (
  id INTEGER PRIMARY KEY, at INTEGER NOT NULL, command TEXT NOT NULL
);
