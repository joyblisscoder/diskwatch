/**
 * Report envelope + SwiftBar markup. Numbers are rounded; payload stays lean (<=4KB target).
 */

import os from 'node:os';
import path from 'node:path';
import { getConfig, statePath } from '../config.js';
import { cleanupSummary } from '../cleanup/summary.js';
import { fileURLToPath } from 'node:url';
import { freeColor, collapseHome } from '../util/fmt.js';
import { nowSec, dayKey, agoSec } from '../util/time.js';
import { runDoctor } from '../doctor.js';

const KB_PER_GB = 1024 * 1024;
const CLI_BIN = path.join(os.homedir(), '.local', 'bin', 'diskwatch');
const PROJECT_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function round1(n) {
  return Math.round(Number(n) * 10) / 10;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function kbToGb(kb) {
  if (kb == null || Number.isNaN(Number(kb))) return 0;
  return Number(kb) / KB_PER_GB;
}

function lastScan(db) {
  return db
    .prepare(
      `SELECT id, started_at, finished_at, vol_total_kb, vol_free_kb,
              swap_used_mb, restart_reclaim_kb, ok
       FROM scans
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get();
}

function freeKbNear(db, atSec) {
  const row = db
    .prepare(
      `SELECT vol_free_kb FROM scans
       WHERE vol_free_kb IS NOT NULL AND started_at <= ?
       ORDER BY started_at DESC
       LIMIT 1`,
    )
    .get(atSec);
  return row ? row.vol_free_kb : null;
}

function topMovers(db, limit = 10) {
  const today = dayKey(nowSec());
  const weekAgo = dayKey(nowSec() - 7 * 86400);
  const rows = db
    .prepare(
      `SELECT p.path, p.class, p.kp_id,
              d.last_kb AS size_kb,
              d.delta_kb AS delta_1d_kb,
              (d.last_kb - COALESCE((
                SELECT d2.last_kb FROM daily_stats d2
                WHERE d2.path_id = d.path_id AND d2.day <= ?
                ORDER BY d2.day DESC LIMIT 1
              ), d.last_kb)) AS delta_7d_kb
       FROM daily_stats d
       JOIN paths p ON p.id = d.path_id
       WHERE d.day = ?
       ORDER BY ABS(d.delta_kb) DESC
       LIMIT ?`,
    )
    .all(weekAgo, today, limit);

  return rows.map((r) => ({
    path: collapseHome(r.path) || r.path,
    class: r.class || 'unknown',
    kp_id: r.kp_id || null,
    size_gb: round2(kbToGb(r.size_kb)),
    delta_1d_gb: round2(kbToGb(r.delta_1d_kb)),
    delta_7d_gb: round2(kbToGb(r.delta_7d_kb)),
  }));
}

function openEvents(db) {
  const rows = db
    .prepare(
      `SELECT e.id, e.at, e.kind, e.severity, e.headline, e.detail_json,
              e.open, e.last_seen, e.count, e.path_id, p.path
       FROM events e
       LEFT JOIN paths p ON p.id = e.path_id
       WHERE e.open = 1
       ORDER BY e.at DESC
       LIMIT 20`,
    )
    .all();

  return rows.map((e) => {
    let detail = null;
    try {
      detail = e.detail_json ? JSON.parse(e.detail_json) : null;
    } catch {
      detail = e.detail_json;
    }
    return {
      id: e.id,
      at: e.at,
      kind: e.kind,
      severity: e.severity,
      headline: e.headline,
      path: e.path ? collapseHome(e.path) : null,
      last_seen: e.last_seen,
      count: e.count,
    };
  });
}

function lastExternalActions(db, limit = 5) {
  const rows = db
    .prepare(
      `SELECT id, started_at, rule_key, target_path, mode, outcome,
              freed_kb, finished_at
       FROM actions
       WHERE mode = 'external'
       ORDER BY started_at DESC
       LIMIT ?`,
    )
    .all(limit);

  return rows.map((a) => ({
    id: a.id,
    at: a.started_at,
    rule_key: a.rule_key,
    target_path: collapseHome(a.target_path) || a.target_path,
    outcome: a.outcome,
    freed_gb: a.freed_kb == null ? null : round2(kbToGb(a.freed_kb)),
  }));
}

function doctorSummary(db) {
  try {
    const result = runDoctor({ db });
    const failing = (result.checks || [])
      .filter((c) => c.status === 'fail' || c.status === 'warn')
      .filter((c) => c.status === 'fail')
      .map((c) => c.id);
    return { status: result.status, failing };
  } catch (err) {
    return { status: 'fail', failing: ['doctor_error'] };
  }
}

/**
 * Build the report --json envelope.
 * @param {object} db DatabaseSync
 * @param {{ logCommand?: string }} [opts] When logCommand is set, INSERT into queries.
 */
export function buildReport(db, opts = {}) {
  const generated_at = nowSec();
  const thresholds = getConfig().thresholds;

  if (opts.logCommand) {
    try {
      db.prepare(`INSERT INTO queries (at, command) VALUES (?, ?)`).run(
        generated_at,
        String(opts.logCommand),
      );
    } catch {
      /* read-only callers skip */
    }
  }

  const scan = lastScan(db);
  const as_of = scan
    ? scan.finished_at != null
      ? scan.finished_at
      : scan.started_at
    : null;
  const staleness_seconds = as_of == null ? null : Math.max(0, generated_at - as_of);
  const stale =
    as_of == null ||
    staleness_seconds > (thresholds.staleness_stale_sec ?? 2700);

  const free_gb = scan ? round1(kbToGb(scan.vol_free_kb)) : 0;
  const total_gb = scan ? round1(kbToGb(scan.vol_total_kb)) : 0;
  const swap_gb = scan ? round1((scan.swap_used_mb || 0) / 1024) : 0;
  const restart_reclaim_gb = scan
    ? round1(kbToGb(scan.restart_reclaim_kb || 0))
    : 0;

  let trend_24h_gb = 0;
  if (scan && scan.vol_free_kb != null) {
    const past = freeKbNear(db, generated_at - 86400);
    if (past != null) {
      trend_24h_gb = round1(kbToGb(scan.vol_free_kb) - kbToGb(past));
    }
  }

  const warnGb = thresholds.free_warn_gb ?? 40;
  const triage = free_gb < warnGb;

  const movers = topMovers(db, 10);
  const events = openEvents(db);
  const actions = lastExternalActions(db, 5);
  const doctor = doctorSummary(db);

  return {
    schema_version: 1,
    generated_at,
    as_of,
    staleness_seconds,
    stale: Boolean(stale),
    doctor,
    data: {
      free_gb,
      total_gb,
      trend_24h_gb,
      swap_gb,
      restart_reclaim_gb,
      triage,
      top_movers: movers,
      open_events: events,
      last_external_actions: actions,
      cleanup_summary: cleanupSummary({state:statePath(),config:getConfig()}),
    },
  };
}

function fmtSignedGb(gb) {
  const n = Number(gb);
  const sign = n > 0 ? '+' : '';
  return `${sign}${n.toFixed(1)} GB`;
}

function swiftbarError(message) {
  const msg = String(message || 'unknown error').replace(/\n/g, ' ').slice(0, 200);
  return [`DW ! | color=red`, '---', msg].join('\n') + '\n';
}

/**
 * SwiftBar markup. NEVER empty. On DB errors return DW ! red + submenu.
 */
export function buildSwiftbar(db) {
  try {
    const report = buildReport(db);
    const d = report.data;
    const color = freeColor(d.free_gb);
    const lines = [];

    lines.push(`${round1(d.free_gb)}GB free | color=${color}`);
    lines.push('---');
    lines.push(
      `Free ${round1(d.free_gb)} GB of ${round1(d.total_gb)} GB, swap ${round1(d.swap_gb)} GB`,
    );

    if (d.restart_reclaim_gb >= 10) {
      lines.push(`Restart reclaims ~${round1(d.restart_reclaim_gb)} GB`);
    }

    const mins =
      report.as_of == null
        ? '?'
        : Math.max(0, Math.floor(agoSec(report.as_of) / 60));
    lines.push(`Last scan ${mins} min ago`);
    if(d.cleanup_summary) {
      const summary=d.cleanup_summary;
      if(summary.status === 'ready') lines.push(`${summary.candidate_count} cleanup lead(s), ${summary.suppressed_count} kept/snoozed${summary.partial ? ' (partial coverage)' : ''}`);
      else lines.push(`Cleanup discovery: ${summary.status.replaceAll('_',' ')}`);
      lines.push(`Prepare cleanup review | bash="${CLI_BIN}" param1=agent terminal=true refresh=true`);
    }
    lines.push('---');
    lines.push('Top movers today');

    const movers = (d.top_movers || []).slice(0, 3);
    if (movers.length === 0) {
      lines.push('-- (none)');
    } else {
      for (const m of movers) {
        lines.push(`-- ${m.path}  ${fmtSignedGb(m.delta_1d_gb)}`);
      }
    }

    const k = (d.open_events || []).length;
    if (k > 0) {
      lines.push('---');
      lines.push(`${k} open events | color=amber`);
    }

    lines.push('---');
    if (getConfig().integrations.agent_menu) {
      lines.push(`Open agent | bash=/bin/bash param1="${path.join(PROJECT_ROOT, 'scripts/open-agent.sh')}" terminal=false`);
    }
    lines.push('Open dashboard | href=http://127.0.0.1:7381');
    lines.push(
      `Scan now | bash="${CLI_BIN}" param1=scan terminal=false refresh=true`,
    );

    return lines.join('\n') + '\n';
  } catch (err) {
    return swiftbarError(err && err.message ? err.message : err);
  }
}

export { swiftbarError, kbToGb, round1, round2 };
