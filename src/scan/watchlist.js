import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, expandHome } from '../config.js';
import { classify, kpIdForPath } from '../learn/classify.js';
import { nowSec } from '../util/time.js';
import { duSk } from './volume.js';

const CHILD_MIN_KB = 51_200; // 50 MB

/**
 * Upsert config watchlist into paths.
 * class/owner/regen/protected from classify(); kp_id from kpIdForPath;
 * watch_tier from seed (default hourly); added_by='seed'.
 */
export function seedPaths(db) {
  const cfg = getConfig();
  const t = nowSec();
  const upsert = db.prepare(
    `INSERT INTO paths (
       path, class, owner, watch_tier, regen_command, protected, kp_id,
       added_by, first_seen_at, last_seen_at, active, status
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'seed', ?, ?, 1, 'ok')
     ON CONFLICT(path) DO UPDATE SET
       class = excluded.class,
       owner = excluded.owner,
       regen_command = excluded.regen_command,
       protected = excluded.protected,
       kp_id = excluded.kp_id,
       watch_tier = CASE
         WHEN paths.watch_tier = 'slow' THEN 'slow'
         ELSE excluded.watch_tier
       END,
       last_seen_at = excluded.last_seen_at,
       active = 1`,
  );

  const out = [];
  for (const entry of cfg.watchlist || []) {
    const abs = expandHome(entry.path);
    const c = classify(abs);
    const protectedFlag =
      entry.protected != null ? (entry.protected ? 1 : 0) : c.protected;
    const tier = entry.tier || 'hourly';
    const kp = kpIdForPath(abs);
    upsert.run(
      abs,
      c.class,
      c.owner,
      tier,
      c.regen_command,
      protectedFlag,
      kp,
      t,
      t,
    );
    const row = db.prepare('SELECT id, path, watch_tier FROM paths WHERE path = ?').get(abs);
    out.push({
      ...row,
      mode: entry.mode || 'leaf',
      seed_path: entry.path,
    });
  }
  return out;
}

/**
 * Ensure a path row exists (for expand children, (other), worktrees).
 * @returns {number} path id
 */
export function ensurePath(db, absPath, opts = {}) {
  const abs = expandHome(absPath);
  const existing = db.prepare('SELECT id FROM paths WHERE path = ?').get(abs);
  const t = nowSec();
  if (existing) {
    db.prepare(
      `UPDATE paths SET last_seen_at = ?, active = 1 WHERE id = ?`,
    ).run(t, existing.id);
    return existing.id;
  }
  const c = classify(abs);
  const tier = opts.watch_tier || 'hourly';
  const addedBy = opts.added_by || 'expand';
  const protectedFlag = opts.protected != null ? opts.protected : c.protected;
  const info = db
    .prepare(
      `INSERT INTO paths (
         path, class, owner, watch_tier, regen_command, protected, kp_id,
         added_by, first_seen_at, last_seen_at, active, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'ok')`,
    )
    .run(
      abs,
      opts.class || c.class,
      opts.owner !== undefined ? opts.owner : c.owner,
      tier,
      opts.regen_command !== undefined ? opts.regen_command : c.regen_command,
      protectedFlag,
      opts.kp_id !== undefined ? opts.kp_id : kpIdForPath(abs),
      addedBy,
      t,
      t,
    );
  return Number(info.lastInsertRowid);
}

/**
 * Measure root with duSk, then each depth-1 child.
 * Children >= 50MB get their own entries; smaller aggregate into root/(other).
 * @returns {{ root: object, children: object[], other: object|null }}
 */
export function expandPath(root) {
  const abs = expandHome(root);
  const rootDu = duSk(abs);
  const children = [];
  let otherKb = 0;
  let otherPartial = false;
  let otherTimedOut = false;

  let names = [];
  try {
    names = fs.readdirSync(abs);
  } catch {
    return {
      root: { path: abs, ...rootDu },
      children: [],
      other: null,
    };
  }

  for (const name of names) {
    if (name === '.' || name === '..' || name === '(other)') continue;
    const childPath = path.join(abs, name);
    let st;
    try {
      st = fs.lstatSync(childPath);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (!st.isDirectory() && !st.isFile()) continue;

    const d = duSk(childPath);
    if (d.size_kb >= CHILD_MIN_KB) {
      children.push({ path: childPath, ...d });
    } else {
      otherKb += d.size_kb;
      if (d.partial) otherPartial = true;
      if (d.timedOut) otherTimedOut = true;
    }
  }

  let other = null;
  if (otherKb > 0 || names.length > 0) {
    // Always emit (other) when there were small children, or when we saw any child scan
    const hadSmall = otherKb > 0 || otherPartial || otherTimedOut;
    if (hadSmall) {
      other = {
        path: path.join(abs, '(other)'),
        size_kb: otherKb,
        timedOut: otherTimedOut,
        partial: otherPartial || otherTimedOut,
        ok: !otherTimedOut,
      };
    }
  }

  return {
    root: { path: abs, ...rootDu },
    children,
    other,
  };
}

/**
 * Paths to sample this scan, joined with config mode.
 * @param {*} db
 * @param {{ tier?: string }} [opts]  hourly skips watch_tier=slow
 */
export function getActiveTargets(db, opts = {}) {
  const tier = opts.tier || 'hourly';
  const cfg = getConfig();
  const byPath = new Map();
  for (const entry of cfg.watchlist || []) {
    byPath.set(expandHome(entry.path), {
      mode: entry.mode || 'leaf',
      seed_tier: entry.tier || 'hourly',
    });
  }

  const rows = db
    .prepare(
      `SELECT id, path, class, owner, watch_tier, protected, kp_id, added_by, status
       FROM paths WHERE active = 1`,
    )
    .all();

  const targets = [];
  for (const row of rows) {
    const meta = byPath.get(row.path);
    // Seed leaf/expand roots only (not expand children or dynamic worktrees)
    if (!meta) continue;
    if (tier === 'hourly' && row.watch_tier === 'slow') continue;
    if (tier === 'hourly' && meta.seed_tier === 'slow') continue;
    targets.push({
      path_id: row.id,
      path: row.path,
      mode: meta.mode,
      watch_tier: row.watch_tier,
      class: row.class,
      status: row.status,
    });
  }
  return targets;
}

/**
 * Discover agent worktrees via worktree-lib.sh.
 * @returns {{ ok: true, paths: string[] } | { ok: false, error: string, paths: [] }}
 */
export function discoverWorktrees() {
  if (!getConfig().integrations.worktree_helper) return { ok: true, paths: [], skipped: true };
  const r = spawnSync(
    'bash',
    ['-c', "source ~/.claude/scripts/worktree-lib.sh; discover_worktrees"],
    { encoding: 'utf8', timeout: 60_000, maxBuffer: 4 * 1024 * 1024 },
  );
  if (r.error || (r.status !== 0 && r.status != null)) {
    const err =
      (r.error && r.error.message) ||
      String(r.stderr || '').trim() ||
      `exit ${r.status}`;
    return { ok: false, error: err, paths: [] };
  }
  const paths = String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  return { ok: true, paths };
}
