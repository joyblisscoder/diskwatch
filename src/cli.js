/**
 * DiskWatch CLI router.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ensureStateDir,
  configPath,
  dbPath,
  statePath,
  loadConfig,
  getConfig,
} from './config.js';
import { open, openReadOnly, close } from './db/db.js';
import { migrate } from './db/migrate.js';
import { runCollector } from './scan/collector.js';
import { runIngest } from './ingest/run.js';
import { canary } from './notify/notify.js';
import { buildReport, buildSwiftbar, swiftbarError } from './report/report.js';
import { runDoctor, formatDoctorJson } from './doctor.js';
import { startServer } from './server/server.js';
import { classify, kpIdForPath, expandHome, toTilde } from './learn/classify.js';
import { collapseHome } from './util/fmt.js';
import { nowSec } from './util/time.js';
import { append } from './util/log.js';
import { runOnboarding } from './onboarding.js';
import { candidatesFor, refreshAgent, inventoryFor } from './agent/workspace.js';
import {rememberDecision,decisionList,listOutcomes} from './cleanup/memory.js';
import {candidateId,selectCandidate,createCleanupPlan,verifyCleanupPlan} from './cleanup/workflow.js';

const [, , cmd, ...args] = process.argv;

function hasFlag(flag) {
  return args.includes(flag);
}

function flagValue(name, fallback = null) {
  const i = args.indexOf(name);
  if (i === -1) return fallback;
  return args[i + 1] != null ? args[i + 1] : fallback;
}

function positional(start = 0) {
  return args.filter((a) => !a.startsWith('--'));
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function errorEnvelope(code, message, extra = {}) {
  return {
    schema_version: 1,
    error: code,
    message,
    generated_at: nowSec(),
    ...extra,
  };
}

async function cmdMigrate() {
  migrate();
  process.stdout.write(`migrated ${dbPath()}\n`);
  process.exitCode = 0;
}

async function cmdScan() {
  const tier = flagValue('--tier', 'hourly');
  const once = hasFlag('--once') || true;
  const result = runCollector({ tier, once });
  if (result?.ok && getConfig().cleanup?.mode === 'agent') {
    try { result.discovery = await agentSnapshot(true); }
    catch (err) { result.discovery = {ok:false,error:err.message}; }
  }
  printJson(result);
  process.exitCode = result && result.ok === false && !result.skipped ? 1 : 0;
}

async function cmdIngest() {
  const db = open();
  try {
    const result = runIngest(db);
    printJson(result);
    process.exitCode = 0;
  } finally {
    close(db);
  }
}

async function cmdStatus() {
  if (!hasFlag('--swiftbar')) {
    process.stderr.write('usage: diskwatch status --swiftbar\n');
    process.exitCode = 2;
    return;
  }
  let db;
  try {
    db = openReadOnly();
  } catch (err) {
    process.stdout.write(swiftbarError(err.message || err));
    process.exitCode = 1;
    return;
  }
  try {
    const text = buildSwiftbar(db);
    process.stdout.write(text.endsWith('\n') ? text : text + '\n');
    // Nonzero only when there is no usable scan yet. Doctor fails stay in the
    // doctor command and dashboard banner; they must not blank the menu bar.
    let hard = false;
    try {
      const report = buildReport(db);
      if (report.as_of == null) hard = true;
    } catch {
      hard = true;
    }
    process.exitCode = hard ? 1 : 0;
  } catch (err) {
    process.stdout.write(swiftbarError(err.message || err));
    process.exitCode = 1;
  } finally {
    close(db);
  }
}

async function cmdReport() {
  if (!hasFlag('--json')) {
    process.stderr.write('usage: diskwatch report --json\n');
    process.exitCode = 2;
    return;
  }
  let db;
  try {
    db = open();
  } catch (err) {
    printJson(errorEnvelope('db_unavailable', String(err.message || err)));
    process.exitCode = 5;
    return;
  }
  try {
    const report = buildReport(db, { logCommand: 'report --json' });
    printJson(report);
    if (report.stale) process.exitCode = 3;
    else process.exitCode = 0;
  } catch (err) {
    printJson(errorEnvelope('report_failed', String(err.message || err)));
    process.exitCode = 5;
  } finally {
    close(db);
  }
}

function sizeSeries(db, pathId) {
  return db
    .prepare(
      `SELECT day, min_kb, max_kb, last_kb, delta_kb, samples
       FROM daily_stats
       WHERE path_id = ?
       ORDER BY day DESC
       LIMIT 14`,
    )
    .all(pathId)
    .reverse()
    .map((r) => ({
      day: r.day,
      min_gb: Math.round((r.min_kb / (1024 * 1024)) * 100) / 100,
      max_gb: Math.round((r.max_kb / (1024 * 1024)) * 100) / 100,
      last_gb: Math.round((r.last_kb / (1024 * 1024)) * 100) / 100,
      delta_gb: Math.round((r.delta_kb / (1024 * 1024)) * 100) / 100,
      samples: r.samples,
    }));
}

async function cmdWhy() {
  const wantJson = hasFlag('--json');
  const pos = positional();
  const inputPath = pos[0];
  if (!inputPath) {
    process.stderr.write('usage: diskwatch why <path> [--json]\n');
    process.exitCode = 2;
    return;
  }

  const abs = expandHome(inputPath);
  const preview = classify(abs);
  const kp = kpIdForPath(abs);

  let db;
  try {
    db = open();
  } catch (err) {
    if (wantJson) {
      printJson(
        errorEnvelope('db_unavailable', String(err.message || err), {
          path: toTilde(abs),
          classification: preview,
          kp_id: kp,
          watched: false,
        }),
      );
    } else {
      process.stderr.write(`db unavailable: ${err.message}\n`);
    }
    process.exitCode = 5;
    return;
  }

  try {
    db.prepare(`INSERT INTO queries (at, command) VALUES (?, ?)`).run(
      nowSec(),
      `why ${abs}`,
    );

    const row = db
      .prepare(
        `SELECT id, path, class, owner, regen_command, protected, kp_id,
                watch_tier, status, active
         FROM paths
         WHERE path = ? OR path = ?
         LIMIT 1`,
      )
      .get(abs, toTilde(abs));

    // Also try collapse/expand variants.
    let pathRow = row;
    if (!pathRow) {
      const collapsed = collapseHome(abs);
      pathRow = db
        .prepare(`SELECT * FROM paths WHERE path = ? OR path = ? LIMIT 1`)
        .get(abs, collapsed);
    }

    if (!pathRow) {
      // Case-insensitive / prefix match on absolute forms.
      pathRow = db
        .prepare(
          `SELECT * FROM paths WHERE path = ? COLLATE NOCASE LIMIT 1`,
        )
        .get(abs);
    }

    if (!pathRow) {
      const payload = {
        path: toTilde(abs),
        watched: false,
        note: 'not watched',
        classification: preview,
        kp_id: kp,
        open_events: [],
        size_series: [],
      };
      if (wantJson) printJson(payload);
      else {
        process.stdout.write(
          `${payload.path}: not watched\n` +
            `class=${preview.class} owner=${preview.owner} protected=${preview.protected}\n` +
            `regen=${preview.regen_command || '-'}\n`,
        );
      }
      process.exitCode = 0;
      return;
    }

    const series = sizeSeries(db, pathRow.id);
    const events = db
      .prepare(
        `SELECT id, at, kind, severity, headline, open, last_seen, count, detail_json
         FROM events
         WHERE path_id = ? AND open = 1
         ORDER BY at DESC`,
      )
      .all(pathRow.id)
      .map((e) => {
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
          last_seen: e.last_seen,
          count: e.count,
          detail,
        };
      });

    const payload = {
      path: collapseHome(pathRow.path) || pathRow.path,
      watched: true,
      class: pathRow.class,
      owner: pathRow.owner,
      regen_command: pathRow.regen_command,
      protected: pathRow.protected,
      kp_id: pathRow.kp_id || kp,
      watch_tier: pathRow.watch_tier,
      status: pathRow.status,
      size_series: series,
      open_events: events,
    };

    if (wantJson) printJson(payload);
    else {
      process.stdout.write(
        `${payload.path}\n` +
          `class=${payload.class} owner=${payload.owner || '-'} protected=${payload.protected}\n` +
          `kp_id=${payload.kp_id || '-'} tier=${payload.watch_tier}\n` +
          `regen=${payload.regen_command || '-'}\n` +
          `series_days=${series.length} open_events=${events.length}\n`,
      );
    }
    process.exitCode = 0;
  } finally {
    close(db);
  }
}

async function cmdDoctor() {
  const result = runDoctor();
  if (hasFlag('--json')) {
    process.stdout.write(formatDoctorJson(result) + '\n');
  } else {
    process.stdout.write(`doctor: ${result.status} (exit ${result.exitCode})\n`);
    for (const c of result.checks) {
      const rem = c.remediation ? ` | ${c.remediation}` : '';
      process.stdout.write(`  [${c.status}] ${c.id}: ${c.measured}${rem}\n`);
    }
  }
  process.exitCode = result.exitCode;
}

async function cmdServe() {
  const port = Number(flagValue('--port', '7381')) || 7381;
  const server = await startServer(port);
  const stateDir = ensureStateDir();
  append(stateDir, 'server', `listening 127.0.0.1:${port}`);
  process.stdout.write(`DiskWatch listening on http://127.0.0.1:${port}\n`);
  const shutdown = () => {
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdCanary() {
  const db = open();
  try {
    const result = canary(db);
    printJson(result);
    process.exitCode = result.delivered || result.reason === 'disabled' ? 0 : 1;
  } finally {
    close(db);
  }
}

async function cmdConfig() {
  ensureStateDir();
  const p = configPath();
  if (hasFlag('--dump') || hasFlag('--json')) {
    const cfg = loadConfig();
    printJson({ path: p, db: dbPath(), state: statePath(), config: cfg });
  } else {
    // Ensure exists.
    getConfig();
    process.stdout.write(`config: ${p}\n`);
    process.stdout.write(`db: ${dbPath()}\n`);
    process.stdout.write(`state: ${statePath()}\n`);
  }
  process.exitCode = 0;
}

async function agentSnapshot(scheduled = false) {
  const config = loadConfig();
  migrate();
  const db = open();
  let report;
  try { report = buildReport(db); } finally { close(db); }
  return refreshAgent({config,state:statePath(),report,scheduled});
}

const COMMANDS = {
  decisions: async () => {
    if(args.some(a=>a !== '--json')) throw new Error('usage: diskwatch decisions [--json]');
    const rows=decisionList({state:statePath()}).map(item=>({...item,id:candidateId(item)}));
    if(hasFlag('--json')) printJson(rows);
    else for(const row of rows) console.log(`${row.id.slice(0,12)} ${row.decision} (${row.status}) ${JSON.stringify(row.path)}`);
  },
  decide: async () => {
    const [reference,decision,...extra]=args;
    if(!reference || !['keep','snooze','clear'].includes(decision) || extra.some((a,i)=>a !== '--json' && a !== '--days' && extra[i-1] !== '--days')) throw new Error('usage: diskwatch decide <candidate-id> keep|snooze|clear [--days 30] [--json]');
    const state=statePath();
    let candidate;
    if(decision === 'clear') candidate=selectCandidate({candidates:decisionList({state})},reference);
    else candidate=selectCandidate(await candidatesFor({config:loadConfig(),state}),reference);
    const result=rememberDecision({state,candidate,decision,days:Number(flagValue('--days','30'))});
    if(hasFlag('--json')) printJson(result);
    else console.log(`${decision}: ${JSON.stringify(candidate.path)}. This preference does not approve cleanup.`);
  },
  cleanup: async () => {
    const [action,id,...extra]=args;
    if(!['plan','check','verify','history'].includes(action) || extra.some(a=>a !== '--json') || (action !== 'history' && !id) || (action === 'history' && id && id !== '--json')) throw new Error('usage: diskwatch cleanup plan <candidate-id> | check <plan-id> | verify <plan-id> | history [--json]');
    const state=statePath();
    let result;
    if(action === 'history') result=listOutcomes({state});
    else {
      const config=loadConfig();
      const discovered=await candidatesFor({config,state});
      result=action === 'plan' ? createCleanupPlan({state,config,result:discovered,reference:id}) : verifyCleanupPlan({state,config,result:discovered,id,record:action === 'verify'});
    }
    printJson(result);
  },
  inventory: async () => {
    if(args.some(a=>a !== '--json')) throw new Error('usage: diskwatch inventory [--json]');
    console.log(JSON.stringify(await inventoryFor({config:loadConfig(),state:statePath()}),null,2));
  },
  candidates: async () => {
    if (args.some(a => a !== '--json')) throw new Error('usage: diskwatch candidates [--json]');
    const result = await candidatesFor({config:loadConfig(),state:statePath()});
    if (hasFlag('--json')) printJson(result);
    else {
      console.log(`${result.candidates.length} investigation leads; ${result.suppressed?.length || 0} kept/snoozed. Cleanup approval required. Partial coverage: ${result.partial}`);
      for (const c of result.candidates) console.log(`${c.id.slice(0,12)} | ${JSON.stringify(c.path)} | ${(c.bytes/1048576).toFixed(1)} MB | ${c.age_days} days | ${c.kind}${c.evidence.traversal_complete ? '' : ' (incomplete estimate)'}`);
      console.log('Next: diskwatch agent, diskwatch decide <id> keep, or diskwatch cleanup plan <id>');
    }
  },
  agent: async () => {
    if (args.some(a => a !== '--json')) throw new Error('usage: diskwatch agent [--json]');
    const result = await agentSnapshot();
    if (hasFlag('--json')) printJson(result);
    else console.log(`Agent workspace: ${JSON.stringify(result.workspace)}\n${result.candidate_count} leads. Partial coverage: ${result.partial}.\n\nPaste this into your agent:\nRead CONTEXT.md in ${JSON.stringify(result.workspace)}. Follow the staged workflow. Explain privacy before reading reports. Investigate within my saved scope and show a cleanup plan. Wait for my approval before moving anything.\n\nThis command prepared local evidence; it did not launch an AI or delete files.`);
  },
  setup: async () => {
    if (args.some(a => a !== '--defaults')) throw new Error('usage: diskwatch setup [--defaults]');
    await runOnboarding({useDefaults:hasFlag('--defaults')});
  },
  migrate: cmdMigrate,
  scan: cmdScan,
  ingest: cmdIngest,
  status: cmdStatus,
  report: cmdReport,
  why: cmdWhy,
  doctor: cmdDoctor,
  serve: cmdServe,
  canary: cmdCanary,
  config: cmdConfig,
};

async function main() {
  ensureStateDir();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    process.stdout.write(
      `diskwatch <command>\n` +
        `  migrate | scan | ingest | status --swiftbar | report --json\n` +
        `  why <path> [--json] | doctor [--json] | serve [--port 7381]\n` +
        `  canary | config [--dump] | setup [--defaults]\n` +
        `  candidates [--json] | inventory [--json] | agent [--json] | decisions [--json]\n` +
        `  decide <candidate-id> keep|snooze|clear [--days 30] [--json]\n` +
        `  cleanup plan <candidate-id> | check <plan-id> | verify <plan-id> | history\n`,
    );
    process.exitCode = cmd ? 0 : 2;
    return;
  }
  const fn = COMMANDS[cmd];
  if (!fn) {
    process.stderr.write(`unknown command: ${cmd}\n`);
    process.exitCode = 2;
    return;
  }
  await fn();
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const self = fileURLToPath(import.meta.url);
const isEntry =
  !process.env.DISKWATCH_CLI_AS_LIB &&
  (entry === self ||
    entry.endsWith(`${path.sep}cli.js`) ||
    entry.endsWith(`${path.sep}diskwatch`));

if (isEntry) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${err && err.stack ? err.stack : err}\n`);
    process.exitCode = 1;
  });
}

export { main, COMMANDS };
