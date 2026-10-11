/**
 * Phase 1 doctor: twelve health checks. Exit 0 ok / 1 warn / 2 fail.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ensureStateDir, statePath, configPath, dbPath, getConfig, notificationChannel } from './config.js';
import { openReadOnly, close } from './db/db.js';
import { nowSec } from './util/time.js';

const HERMES = path.join(os.homedir(), '.local', 'bin', 'hermes');
const WORKTREE_LIB = path.join(os.homedir(), '.claude', 'scripts', 'worktree-lib.sh');
const WORKTREE_FUNCS = [
  'discover_repositories',
  'discover_worktrees',
  'owning_repo',
  'idle_days',
  'worktree_clean',
  'worktree_has_local_env',
  'worktree_has_process',
  'worktree_integrated',
  'registered_linked_worktree',
];
const DAY7 = 7 * 86400;

function check(id, status, measured, remediation) {
  return { id, status, measured, remediation };
}

function checkHermesExists() {
  const ok = fs.existsSync(HERMES);
  return check(
    'hermes_exists',
    ok ? 'ok' : 'fail',
    ok ? HERMES : 'missing',
    ok ? null : `Install hermes at ${HERMES}`,
  );
}

function checkHermesContract() {
  if (!fs.existsSync(HERMES)) {
    return check(
      'hermes_contract',
      'fail',
      'hermes missing',
      `Install hermes at ${HERMES}`,
    );
  }
  const r = spawnSync(HERMES, ['send', '--help'], {
    encoding: 'utf8',
    timeout: 15_000,
  });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  const exitOk = r.status === 0;
  const hasTo = out.includes('--to');
  const hasJson = out.includes('--json');
  const ok = exitOk && hasTo && hasJson;
  return check(
    'hermes_contract',
    ok ? 'ok' : 'fail',
    `exit=${r.status} --to=${hasTo} --json=${hasJson}`,
    ok ? null : 'hermes send --help must exit 0 and document --to and --json',
  );
}

function checkDeliveryProof(db) {
  let raw = null;
  try {
    const row = db.prepare(`SELECT v FROM meta WHERE k = 'last_verified_delivery'`).get();
    raw = row ? row.v : null;
  } catch (err) {
    return check(
      'delivery_proof',
      'fail',
      `db error: ${err.message}`,
      'Run diskwatch migrate, then diskwatch canary',
    );
  }
  if (raw == null || raw === '') {
    return check(
      'delivery_proof',
      'fail',
      'missing',
      'Run diskwatch canary to verify Telegram delivery',
    );
  }
  const ts = Number(raw);
  if (!Number.isFinite(ts)) {
    return check(
      'delivery_proof',
      'fail',
      `unparseable: ${raw}`,
      'Run diskwatch canary to refresh last_verified_delivery',
    );
  }
  const age = nowSec() - ts;
  const ok = age <= DAY7;
  return check(
    'delivery_proof',
    ok ? 'ok' : 'fail',
    `last_verified_delivery=${ts} age_sec=${age}`,
    ok ? null : 'Canary older than 7 days. Run diskwatch canary',
  );
}

function checkWorktreeLib() {
  if (!fs.existsSync(WORKTREE_LIB)) {
    return check(
      'worktree_lib',
      'fail',
      'missing script',
      `Create ${WORKTREE_LIB} with the 9 worktree helpers`,
    );
  }
  const probe = WORKTREE_FUNCS.map(
    (fn) => `if ! declare -F ${fn} >/dev/null; then echo MISSING:${fn}; fi`,
  ).join('\n');
  const script = `source ${JSON.stringify(WORKTREE_LIB)}\n${probe}\necho DONE\n`;
  const r = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  const missing = String(r.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('MISSING:'))
    .map((l) => l.slice('MISSING:'.length));
  const ok = r.status === 0 && missing.length === 0 && String(r.stdout || '').includes('DONE');
  return check(
    'worktree_lib',
    ok ? 'ok' : 'fail',
    ok ? `all ${WORKTREE_FUNCS.length} functions defined` : `missing=${missing.join(',') || 'source failed'}`,
    ok ? null : `Source ${WORKTREE_LIB} and define: ${WORKTREE_FUNCS.join(' ')}`,
  );
}

function checkNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 22;
  return check(
    'node_version',
    ok ? 'ok' : 'fail',
    process.versions.node,
    ok ? null : 'Install Node.js >= 22',
  );
}

function checkNodeSqlite() {
  try {
    // Dynamic import already resolved at load time for this process; probe DatabaseSync.
    const mod = spawnSync(
      process.execPath,
      ['-e', "import('node:sqlite').then(m => { if (!m.DatabaseSync) process.exit(2); })"],
      { encoding: 'utf8', timeout: 10_000 },
    );
    const ok = mod.status === 0;
    return check(
      'node_sqlite',
      ok ? 'ok' : 'fail',
      ok ? 'DatabaseSync loads' : `exit=${mod.status} ${mod.stderr || ''}`,
      ok ? null : 'Use a Node build that ships node:sqlite (Node >= 22.5)',
    );
  } catch (err) {
    return check(
      'node_sqlite',
      'fail',
      err.message,
      'Use a Node build that ships node:sqlite',
    );
  }
}

function checkScanFreshness(db) {
  const staleMin = getConfig().thresholds.scan_stale_min ?? 45;
  let row = null;
  try {
    row = db
      .prepare(
        `SELECT started_at, finished_at FROM scans ORDER BY started_at DESC LIMIT 1`,
      )
      .get();
  } catch (err) {
    return check(
      'scan_freshness',
      'fail',
      `db error: ${err.message}`,
      'Run diskwatch migrate && diskwatch scan --once',
    );
  }
  if (!row) {
    return check(
      'scan_freshness',
      'fail',
      'no scans',
      'Run diskwatch scan --once',
    );
  }
  const asOf = row.finished_at != null ? row.finished_at : row.started_at;
  const ageMin = Math.floor((nowSec() - asOf) / 60);
  if (ageMin > staleMin) {
    return check(
      'scan_freshness',
      'fail',
      `${ageMin} min since last scan`,
      'Run diskwatch scan --once or check the collector launchd job',
    );
  }
  // Approaching stale: warn in the last third of the budget.
  if (ageMin > Math.floor(staleMin * 0.75)) {
    return check(
      'scan_freshness',
      'warn',
      `${ageMin} min since last scan`,
      'Scan is aging; confirm collector is running',
    );
  }
  return check('scan_freshness', 'ok', `${ageMin} min since last scan`, null);
}

function checkDbSize() {
  const p = dbPath();
  if (!fs.existsSync(p)) {
    return check(
      'db_size',
      'fail',
      'db missing',
      'Run diskwatch migrate',
    );
  }
  const bytes = fs.statSync(p).size;
  const mb = bytes / (1024 * 1024);
  const warnMb = getConfig().thresholds.db_warn_mb ?? 250;
  const failMb = getConfig().thresholds.db_fail_mb ?? 500;
  const measured = `${mb.toFixed(1)} MB`;
  if (mb > failMb) {
    return check(
      'db_size',
      'fail',
      measured,
      `DB exceeds ${failMb}MB. Vacuum or trim samples (see RUNBOOK)`,
    );
  }
  if (mb > warnMb) {
    return check(
      'db_size',
      'warn',
      measured,
      `DB exceeds ${warnMb}MB. Plan a vacuum soon`,
    );
  }
  return check('db_size', 'ok', measured, null);
}

function checkDbIntegrity(db) {
  try {
    const row = db.prepare('PRAGMA quick_check').get();
    const val = row ? Object.values(row)[0] : null;
    const ok = val === 'ok';
    return check(
      'db_integrity',
      ok ? 'ok' : 'fail',
      String(val),
      ok ? null : 'Restore from backup or rebuild via migrate after quarantine',
    );
  } catch (err) {
    return check(
      'db_integrity',
      'fail',
      err.message,
      'DB unreadable. Restore or remigrate',
    );
  }
}

function checkUndeliveredAbsent() {
  ensureStateDir();
  const marker = statePath('UNDELIVERED');
  const present = fs.existsSync(marker);
  return check(
    'undelivered_absent',
    present ? 'fail' : 'ok',
    present ? marker : 'absent',
    present
      ? 'Fix hermes delivery, run canary, then clear UNDELIVERED once clean'
      : null,
  );
}

function checkLaunchdJobs() {
  const details = [];
  let anyFail = false;
  let anyWarn = false;
  const cfg = getConfig();
  let jobs = cfg.installation?.jobs;
  if (!jobs) {
    let prefix = 'com.diskwatch';
    const kinds = ['collector', 'server'];
    if (cfg.integrations.worktree_helper) {
      kinds.push('canary');
      const listed = spawnSync('launchctl', ['list'], {encoding:'utf8', timeout:10_000});
      if (listed.status !== 0) return check('launchd_jobs', 'fail', 'Could not list background jobs', 'Check launchctl in your logged-in macOS session');
      const installed = String(listed.stdout).split('\n').map(line => line.trim().split(/\s+/).at(-1))
        .find(label => /\.diskwatch\.collector$/.test(label));
      if (installed) prefix = installed.slice(0, -'.collector'.length);
    }
    jobs = kinds.map(kind => `${prefix}.${kind}`);
  }
  for (const label of jobs) {
    const r = spawnSync('launchctl', ['print', `gui/${process.getuid()}/${label}`], {
      encoding: 'utf8',
      timeout: 10_000,
    });
    if (r.status === 0) {
      details.push(`${label}=loaded`);
      continue;
    }
    const errText = `${r.stderr || ''}${r.stdout || ''}`.toLowerCase();
    const notInstalled =
      errText.includes('could not find service') ||
      errText.includes('no such') ||
      errText.includes('not found') ||
      r.status === 113 ||
      r.status === 125;
    if (notInstalled) {
      anyWarn = true;
      details.push(`${label}=not_installed`);
    } else {
      anyFail = true;
      details.push(`${label}=error:${r.status}`);
    }
  }
  const status = anyFail ? 'fail' : anyWarn ? 'warn' : 'ok';
  return check(
    'launchd_jobs',
    status,
    details.join('; '),
    status === 'ok'
      ? null
      : 'Run node scripts/install.js --start (WARN is fine before background setup)',
  );
}

function checkConfigParse() {
  ensureStateDir();
  const p = configPath();
  if (!fs.existsSync(p)) {
    // loadConfig creates it; absence before first run is a soft fail.
    return check(
      'config_parse',
      'warn',
      'config.json missing',
      'Run any diskwatch command to create config.json',
    );
  }
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return check(
        'config_parse',
        'fail',
        'not an object',
        `Fix JSON in ${p}`,
      );
    }
    return check('config_parse', 'ok', p, null);
  } catch (err) {
    return check(
      'config_parse',
      'fail',
      err.message,
      `Fix JSON in ${p}`,
    );
  }
}

function aggregate(checks) {
  let status = 'ok';
  let exitCode = 0;
  for (const c of checks) {
    if (c.status === 'fail') {
      status = 'fail';
      exitCode = 2;
      break;
    }
    if (c.status === 'warn' && exitCode < 1) {
      status = 'warn';
      exitCode = 1;
    }
  }
  const failing = checks.filter((c) => c.status === 'fail').map((c) => c.id);
  const warnings = checks.filter((c) => c.status === 'warn').map((c) => c.id);
  return { status, exitCode, failing, warnings, checks };
}

/**
 * Run all Phase 1 doctor checks.
 * @param {{ db?: object }} [opts] Optional open DB (read-only is fine).
 */
export function runDoctor(opts = {}) {
  ensureStateDir();
  let db = opts.db || null;
  let owned = false;
  const checks = [];

  let channel;
  try {
    channel = notificationChannel();
  } catch (err) {
    return aggregate([check('config_parse', 'fail', err.message, `Fix settings in ${configPath()}`)]);
  }
  if (channel === 'telegram') {
    checks.push(checkHermesExists());
    checks.push(checkHermesContract());
  }
  if (getConfig().integrations.worktree_helper) checks.push(checkWorktreeLib());
  checks.push(checkNodeVersion());
  checks.push(checkNodeSqlite());
  checks.push(checkDbSize());
  if (channel !== 'none') checks.push(checkUndeliveredAbsent());
  checks.push(checkLaunchdJobs());
  checks.push(checkConfigParse());

  if (!db) {
    try {
      db = openReadOnly();
      owned = true;
    } catch (err) {
      checks.push(
        check(
          'delivery_proof',
          'fail',
          `db unavailable: ${err.message}`,
          'Run diskwatch migrate',
        ),
      );
      checks.push(
        check(
          'scan_freshness',
          'fail',
          `db unavailable: ${err.message}`,
          'Run diskwatch migrate && diskwatch scan --once',
        ),
      );
      checks.push(
        check(
          'db_integrity',
          'fail',
          `db unavailable: ${err.message}`,
          'Run diskwatch migrate',
        ),
      );
      return aggregate(orderChecks(checks));
    }
  }

  try {
    if (channel === 'telegram') checks.push(checkDeliveryProof(db));
    checks.push(checkScanFreshness(db));
    checks.push(checkDbIntegrity(db));
  } finally {
    if (owned) close(db);
  }

  return aggregate(orderChecks(checks));
}

const CHECK_ORDER = [
  'hermes_exists',
  'hermes_contract',
  'delivery_proof',
  'worktree_lib',
  'node_version',
  'node_sqlite',
  'scan_freshness',
  'db_size',
  'db_integrity',
  'undelivered_absent',
  'launchd_jobs',
  'config_parse',
];

function orderChecks(checks) {
  const byId = new Map(checks.map((c) => [c.id, c]));
  return CHECK_ORDER.map((id) => byId.get(id)).filter(Boolean);
}

export function formatDoctorJson(result) {
  return JSON.stringify(
    {
      status: result.status,
      exit_code: result.exitCode,
      failing: result.failing,
      warnings: result.warnings,
      checks: result.checks,
    },
    null,
    2,
  );
}
