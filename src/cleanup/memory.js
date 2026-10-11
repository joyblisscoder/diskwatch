import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { statePath } from '../config.js';

const DAY = 86400000;
const MAX_JSON_BYTES = 1024 * 1024;
const FILES = ['cleanup.db', 'cleanup.db-wal', 'cleanup.db-shm'];

function absolutePath(value, name = 'path') {
  if (typeof value !== 'string' || !path.isAbsolute(value) || value.length > 16384 || /[\x00-\x1f\x7f]/.test(value)) throw new Error(`${name} must be an absolute path without control characters.`);
  return path.resolve(value);
}

function instant(value, name = 'now') {
  if (!Number.isSafeInteger(value) || !Number.isFinite(new Date(value).getTime())) throw new Error(`Invalid ${name}.`);
  return value;
}

function timestamp(value, name) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error(`${name} must be an ISO timestamp.`);
  return value;
}

function identifier(value, name = 'id') {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value)) throw new Error(`Invalid ${name}.`);
  return value;
}

function fingerprint(value) {
  if (typeof value !== 'string' || !value || value.length > 4096 || /[\x00-\x1f\x7f]/.test(value)) throw new Error('Invalid candidate fingerprint.');
  return value;
}

function boundedJson(value) {
  const visit = (item, ancestors = new Set()) => {
    if (ancestors.size > 64) throw new Error('JSON nesting exceeds maximum depth 64.');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || ancestors.has(item) || (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype)) throw new Error('Payload must contain only JSON data.');
    const next = new Set(ancestors).add(item);
    for (const child of Object.values(item)) visit(child, next);
  };
  visit(value);
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > MAX_JSON_BYTES) throw new Error('Payload is too large (maximum 1 MiB).');
  return json;
}

function safeFile(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 1) throw new Error('Refusing unsafe cleanup database or sidecar.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw new Error('Cleanup database changed during validation.');
    fs.fchmodSync(fd, 0o600);
  } finally { fs.closeSync(fd); }
}

function safeAncestors(root) {
  let current = path.parse(root).root;
  for (const component of root.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) break;
    // macOS itself publishes these root-owned aliases. Custom links, including
    // links elsewhere in the state path, cannot route storage to another place.
    const systemAlias = { '/var': '/private/var', '/tmp': '/private/tmp' }[current];
    if (stat.isSymbolicLink() && !(current !== root && stat.uid === 0 && systemAlias && fs.realpathSync(current) === systemAlias)) throw new Error('Refusing unsafe symlinked cleanup state ancestor.');
    if (!stat.isSymbolicLink() && stat.isDirectory() && (stat.mode & 0o022) && !(stat.mode & 0o1000)) throw new Error('Refusing unsafe writable cleanup state ancestor.');
  }
}

// All connections are short lived. The private owner directory prevents other
// users replacing SQLite files between validation and opening the database.
function withStore(state, create, use, writable = create) {
  const root = absolutePath(state ?? statePath(), 'state');
  safeAncestors(root);
  let stat = fs.lstatSync(root, { throwIfNoEntry: false });
  if (!stat && !create) return use(null);
  if (!stat) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    stat = fs.lstatSync(root);
  }
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)) throw new Error('Refusing unsafe cleanup state directory.');
  fs.chmodSync(root, 0o700);
  for (const name of FILES) safeFile(path.join(root, name));
  const file = path.join(root, FILES[0]);
  if (!fs.existsSync(file)) {
    if (!create) return use(null);
    const fd = fs.openSync(file, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.closeSync(fd);
  }
  const db = new DatabaseSync(file, { readOnly: !writable });
  try {
    db.exec('PRAGMA trusted_schema = OFF; PRAGMA busy_timeout = 5000;');
    if (create) db.exec('PRAGMA journal_mode = WAL;');
    for (const name of FILES) safeFile(path.join(root, name));
    if (create) db.exec(`CREATE TABLE IF NOT EXISTS decisions (
      path_key TEXT PRIMARY KEY, path TEXT NOT NULL, fingerprint TEXT NOT NULL,
      decision TEXT NOT NULL CHECK (decision IN ('keep','snooze')),
      decided_at INTEGER NOT NULL, expires_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS outcomes (action_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, payload TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS plans (id TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
    return use(db);
  } finally {
    db.close();
    for (const name of FILES) safeFile(path.join(root, name));
  }
}

const pathKey = value => absolutePath(value).normalize('NFC').toLowerCase();
const publicDecision = (row, now) => ({
  path: row.path, fingerprint: row.fingerprint, decision: row.decision,
  decided_at: new Date(row.decided_at).toISOString(),
  expires_at: row.expires_at === null ? null : new Date(row.expires_at).toISOString(),
  status: row.decision === 'snooze' && row.expires_at <= now ? 'expired' : 'active',
});

/** These preferences suppress proposals. They never authorize an action. */
export function rememberDecision({ state, candidate, decision, days = 30, now = Date.now() } = {}) {
  instant(now);
  if (!['keep', 'snooze', 'clear'].includes(decision)) throw new Error('Decision must be keep, snooze, or clear.');
  const target = absolutePath(candidate?.path);
  const key = pathKey(target);
  if (decision !== 'clear') fingerprint(candidate?.fingerprint);
  if (decision === 'snooze' && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new Error('Snooze days must be between 1 and 3650.');
  const expiry = decision === 'snooze' ? instant(now + days * DAY, 'snooze expiry') : null;
  return withStore(state, decision !== 'clear', db => {
    if (!db) return null;
    if (decision === 'clear') { db.prepare('DELETE FROM decisions WHERE path_key = ?').run(key); return null; }
    db.prepare(`INSERT INTO decisions (path_key,path,fingerprint,decision,decided_at,expires_at) VALUES (?,?,?,?,?,?)
      ON CONFLICT(path_key) DO UPDATE SET path=excluded.path,fingerprint=excluded.fingerprint,decision=excluded.decision,decided_at=excluded.decided_at,expires_at=excluded.expires_at`).run(key,target,candidate.fingerprint,decision,now,expiry);
    return publicDecision(db.prepare('SELECT * FROM decisions WHERE path_key = ?').get(key), now);
  }, true);
}

export function decisionList({ state, now = Date.now() } = {}) {
  instant(now);
  return withStore(state, false, db => db ? db.prepare('SELECT * FROM decisions ORDER BY path_key').all().map(row => publicDecision(row, now)) : []);
}

export function applyDecisions({ state, result, now = Date.now() } = {}) {
  instant(now);
  if (!result || !Array.isArray(result.candidates) || result.candidates.length > 10000) throw new Error('A bounded discovery result is required.');
  const rules = new Map(decisionList({ state, now }).map(rule => [pathKey(rule.path), rule]));
  const candidates = [], suppressed = [];
  for (const candidate of result.candidates) {
    const rule = rules.get(pathKey(candidate.path));
    if (!rule) { candidates.push(candidate); continue; }
    const reason = candidate.fingerprint !== rule.fingerprint ? 'fingerprint_changed' : rule.status === 'expired' ? 'snooze_expired' : 'unchanged';
    const item = { ...candidate, previous_decision: { ...rule, reason } };
    (reason === 'unchanged' ? suppressed : candidates).push(item);
  }
  return { ...result, candidates, suppressed };
}

/** Append external action evidence, retaining observed change, not attribution. */
export function recordOutcome({ state, ...outcome } = {}) {
  identifier(outcome.action_id, 'action_id');
  absolutePath(outcome.path);
  identifier(outcome.method, 'method');
  if (!['moved_to_trash', 'failed', 'changed', 'already_missing', 'still_present_unchanged', 'still_present_changed', 'path_absent', 'recreated', 'verification_incomplete', 'policy_changed'].includes(outcome.status)) throw new Error('Invalid outcome status.');
  timestamp(outcome.observed_at, 'observed_at');
  for (const name of ['before_free_bytes', 'after_free_bytes']) {
    if (outcome[name] !== null && (!Number.isSafeInteger(outcome[name]) || outcome[name] < 0)) throw new Error(`Invalid ${name}.`);
  }
  const expected = outcome.before_free_bytes === null || outcome.after_free_bytes === null ? null : outcome.after_free_bytes - outcome.before_free_bytes;
  if (outcome.measured_delta_bytes !== expected || (expected !== null && !Number.isSafeInteger(expected))) throw new Error('Measured delta must equal after minus before, or null for unavailable measurements.');
  if (!outcome.verification || typeof outcome.verification.source_absent !== 'boolean' || typeof outcome.verification.volume_changed !== 'boolean') throw new Error('Structured outcome verification is required.');
  if (outcome.verified !== undefined && (typeof outcome.verified !== 'boolean' || (outcome.verified && !outcome.verification.source_absent))) throw new Error('A verified outcome requires observed source absence.');
  const payload = boundedJson(outcome);
  return withStore(state, true, db => {
    db.prepare('INSERT INTO outcomes (action_id,observed_at,payload) VALUES (?,?,?)').run(outcome.action_id,outcome.observed_at,payload);
    return outcome;
  });
}

export function listOutcomes({ state, limit = 50 } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('Outcome limit must be between 1 and 1000.');
  return withStore(state, false, db => db ? db.prepare('SELECT payload FROM outcomes ORDER BY observed_at DESC,action_id LIMIT ?').all(limit).map(row => JSON.parse(row.payload)) : []);
}

export function savePlan({ state, plan } = {}) {
  identifier(plan?.id);
  timestamp(plan.created_at, 'created_at');
  if (!Array.isArray(plan.items) || plan.items.length > 1000) throw new Error('Plan items must be a bounded array.');
  if (!Number.isSafeInteger(plan.before_free_bytes) || plan.before_free_bytes < 0) throw new Error('Invalid before_free_bytes.');
  fingerprint(plan.policy_fingerprint);
  const payload = boundedJson(plan);
  return withStore(state, true, db => {
    db.prepare('INSERT INTO plans (id,payload) VALUES (?,?)').run(plan.id,payload);
    return plan;
  });
}

export function getPlan({ state, id } = {}) {
  identifier(id);
  return withStore(state, false, db => {
    const row = db?.prepare('SELECT payload FROM plans WHERE id = ?').get(id);
    return row ? JSON.parse(row.payload) : null;
  });
}
