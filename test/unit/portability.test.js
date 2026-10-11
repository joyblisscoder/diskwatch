import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
function probe(code, config, extraEnv = {}) {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-portable-'));
  if (config) fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify(config));
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv, DISKWATCH_STATE_DIR: state, HERMES_BIN: path.join(state, 'no-network-helper') },
  });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
}

test('fresh installs work without personal helpers and do not expose an agent action', () => {
  const result = probe(`
    import {loadConfig} from './src/config.js';
    import {discoverWorktrees} from './src/scan/watchlist.js';
    import {runDoctor} from './src/doctor.js';
    import {migrate} from './src/db/migrate.js';
    import {open,close} from './src/db/db.js';
    import {buildSwiftbar} from './src/report/report.js';
    loadConfig(); migrate(); const db = open();
    const t = Math.floor(Date.now()/1000);
    db.prepare("INSERT INTO scans(kind,scanner,started_at,finished_at,vol_total_kb,vol_free_kb,ok) VALUES('hourly','collector',?,?,100000000,80000000,1)").run(t,t);
    console.log(JSON.stringify({doctor:runDoctor({db}),worktrees:discoverWorktrees(),menu:buildSwiftbar(db)})); close(db);
  `);
  assert.deepEqual(result.worktrees, { ok: true, paths: [], skipped: true });
  assert.deepEqual(result.doctor.failing, []);
  assert.doesNotMatch(result.menu, /Open agent/);
  assert.match(result.menu, /Open dashboard/);
});

test('existing config retains the original integrations', () => {
  const cfg = probe(`import {loadConfig} from './src/config.js'; console.log(JSON.stringify(loadConfig()));`, { watchlist: [] });
  assert.equal(cfg.notifications.channel, 'telegram');
  assert.equal(cfg.integrations.worktree_helper, true);
  assert.equal(cfg.integrations.external_logs, true);
  assert.equal(cfg.integrations.agent_menu, true);
});

test('reports and health checks honor custom thresholds including zero', () => {
  const result=probe(`
    import {migrate} from './src/db/migrate.js'; import {open,close} from './src/db/db.js';
    import {buildReport} from './src/report/report.js'; import {runDoctor} from './src/doctor.js';
    migrate(); const db=open(); const t=Math.floor(Date.now()/1000)-90;
    db.prepare("INSERT INTO scans(kind,scanner,started_at,finished_at,vol_total_kb,vol_free_kb,ok) VALUES('hourly','collector',?,?,100000000,20971520,1)").run(t,t);
    console.log(JSON.stringify({report:buildReport(db),doctor:runDoctor({db})})); close(db);
  `,{notifications:{channel:'none'},integrations:{},watchlist:[],thresholds:{free_warn_gb:10,staleness_stale_sec:30,scan_stale_min:1,db_warn_mb:0,db_fail_mb:1000000}});
  assert.equal(result.report.stale,true);
  assert.equal(result.report.data.triage,false);
  assert.equal(result.doctor.checks.find(c=>c.id==='scan_freshness').status,'warn');
  assert.equal(result.doctor.checks.find(c=>c.id==='db_size').status,'warn');
});

test('legacy job checks discover the installed namespace without a personal default', () => {
  const toolsDir=fs.mkdtempSync(path.join(os.tmpdir(),'diskwatch-launchctl-'));
  fs.writeFileSync(path.join(toolsDir,'launchctl'),`#!${process.execPath}\nif(process.argv[2]==='list'){console.log('123\\t0\\tcom.example.diskwatch.collector');}else{console.error('Could not find service');process.exit(113);}\n`,{mode:0o755});
  const result=probe(`import {runDoctor} from './src/doctor.js'; console.log(JSON.stringify(runDoctor()));`,
    {notifications:{channel:'none'},integrations:{worktree_helper:true},watchlist:[]},
    {PATH:toolsDir+path.delimiter+process.env.PATH});
  const jobs=result.checks.find(c=>c.id==='launchd_jobs');
  assert.match(jobs.measured,/com\.example\.diskwatch\.collector=not_installed/);
  assert.match(jobs.measured,/com\.example\.diskwatch\.server=not_installed/);
  assert.match(jobs.measured,/com\.example\.diskwatch\.canary=not_installed/);
});

test('legacy menu keeps the original optional agent action', () => {
  const result = probe(`
    import {migrate} from './src/db/migrate.js'; import {open,close} from './src/db/db.js';
    import {buildSwiftbar} from './src/report/report.js'; migrate(); const db=open();
    console.log(JSON.stringify(buildSwiftbar(db))); close(db);
  `, {notifications:{channel:'none'}, integrations:{agent_menu:true},watchlist:[]});
  assert.match(result,/Open agent/);
});

test('Mac notifications pass user text as arguments and journal submission', () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-native-'));
  const stub = path.join(state, 'osascript');
  const proof = path.join(state,'argv.json');
  fs.writeFileSync(stub, `#!${process.execPath}\nrequire('node:fs').writeFileSync(process.env.PROOF,JSON.stringify(process.argv.slice(2)));\n`, {mode:0o755});
  fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({notifications:{channel:'macos'},integrations:{},watchlist:[]}));
  const r = spawnSync(process.execPath,['--input-type=module','-e',`
    import {migrate} from './src/db/migrate.js'; import {open,close} from './src/db/db.js';
    import {send} from './src/notify/notify.js'; migrate(); const db=open();
    const result=send(db,'Title "quoted"','Body \\"quoted\\"; $HOME','mac-test');
    console.log(JSON.stringify({result,row:db.prepare('SELECT channel,body,delivered_at FROM notifications').get()})); close(db);
  `],{cwd:root,encoding:'utf8',env:{...process.env,DISKWATCH_STATE_DIR:state,PATH:state+path.delimiter+process.env.PATH,PROOF:proof}});
  assert.equal(r.status,0,r.stderr);
  const result = JSON.parse(r.stdout);
  assert.equal(result.result.delivered,true);
  assert.equal(result.row.channel,'macos');
  assert.ok(result.row.delivered_at);
  const argv=JSON.parse(fs.readFileSync(proof,'utf8'));
  assert.equal(argv.at(-2),'Title "quoted"');
  assert.equal(argv.at(-1),'Body "quoted"; $HOME');
});

test('disabled notifications leave no undelivered rows or send attempts', () => {
  const result = probe(`
    import {loadConfig} from './src/config.js'; import {migrate} from './src/db/migrate.js';
    import {open,close} from './src/db/db.js'; import {send} from './src/notify/notify.js';
    loadConfig(); migrate(); const db = open();
    const result = send(db,'test','body','disabled');
    console.log(JSON.stringify({result, count:db.prepare('SELECT COUNT(*) AS n FROM notifications').get().n})); close(db);
  `, { notifications: {channel:'none'}, integrations: {}, watchlist: [] });
  assert.deepEqual(result.result, {skipped:true, reason:'disabled'});
  assert.equal(result.count, 0);
});

test('installer handles spaces and ampersands and refuses another app’s binary', async () => {
  const { install } = await import('../../scripts/install.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch friend & '));
  const state = path.join(home, 'state');
  const result = install({ home, state, project:root, node:process.execPath, start:false });
  const wrapper = path.join(home, '.local/bin/diskwatch');
  const run = spawnSync(wrapper, ['config', '--json'], { encoding:'utf8', env:{...process.env, DISKWATCH_STATE_DIR:state} });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).state, state);
  for (const plist of result.plists) {
    const check = spawnSync('plutil', ['-lint', plist], {encoding:'utf8'});
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
  assert.equal(result.plists.length, 2);
  install({ home, state, project:root, node:process.execPath, start:false });
  fs.chmodSync(wrapper, 0o644);
  fs.chmodSync(state, 0o755);
  install({ home, state, project:root, node:process.execPath, start:false });
  assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  assert.ok(fs.statSync(wrapper).mode & 0o100);
  fs.writeFileSync(wrapper, '#!/bin/sh\necho someone else\n');
  assert.throws(() => install({ home, state, project:root, node:process.execPath, start:false }), /refusing/i);
  assert.match(fs.readFileSync(wrapper,'utf8'), /someone else/);
});

test('installer refuses a running job from a different install before writing', async () => {
  const { install } = await import('../../scripts/install.js');
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'diskwatch-collision-'));
  const fake='gui/501/com.diskwatch.collector = {\n path = /old/place/com.diskwatch.collector.plist\n arguments = {\n /old/node\n /old/diskwatch\n scan\n --once\n }\n environment = {\n DISKWATCH_STATE_DIR => /old/state\n }\n}';
  fs.writeFileSync(path.join(home,'launchctl'),`#!${process.execPath}\nconsole.log(${JSON.stringify(fake)});\n`,{mode:0o755});
  const prev=process.env.PATH;
  process.env.PATH=home+path.delimiter+prev;
  try {
    assert.throws(()=>install({home,project:root,start:true}),/running.*different|different.*installation/i);
    assert.equal(fs.existsSync(path.join(home,'.local/bin/diskwatch')),false);
  } finally {process.env.PATH=prev;}
});

test('doctor returns diagnostic JSON for broken settings', () => {
  for (const text of ['{"watchlist":[],}', '{"notifications":{"channel":"typo"}}']) {
    const state=fs.mkdtempSync(path.join(os.tmpdir(),'diskwatch-broken-settings-'));
    fs.writeFileSync(path.join(state,'config.json'),text);
    const result=spawnSync(process.execPath,['bin/diskwatch','doctor','--json'],{cwd:root,encoding:'utf8',env:{...process.env,DISKWATCH_STATE_DIR:state}});
    assert.equal(result.status,2,result.stderr);
    const diagnostic=JSON.parse(result.stdout);
    assert.equal(diagnostic.status,'fail');
    assert.ok(diagnostic.failing.includes('config_parse'));
  }
});
