import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname,'../..');
function fixture(mode='agent') {
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'diskwatch-agent-')));
  const state=path.join(home,'state'); fs.mkdirSync(state);
  const downloads=path.join(home,'Downloads'); fs.mkdirSync(downloads);
  const file=path.join(downloads,'old installer.dmg'); fs.writeFileSync(file,Buffer.alloc(1024*1024));
  const old=new Date(Date.now()-90*86400000); fs.utimesSync(file,old,old);
  fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({notifications:{channel:'none'},integrations:{},watchlist:[],cleanup:{mode,roots:[downloads],exclude:[],min_age_days:30,min_size_mb:1,require_approval:true}}));
  return {home,state,file};
}
function run(args,f) {
  return spawnSync(process.execPath,['bin/diskwatch',...args],{cwd:root,encoding:'utf8',timeout:15000,env:{...process.env,HOME:f.home,DISKWATCH_STATE_DIR:f.state}});
}

test('agent handoff creates private inspectable evidence without changing monitored files',()=>{
  const f=fixture(); const before=fs.statSync(f.file);
  const r=run(['agent','--json'],f); assert.equal(r.status,0,r.stderr);
  const data=JSON.parse(r.stdout);
  const candidates=JSON.parse(fs.readFileSync(path.join(data.workspace,'02_investigate/output/candidates.json')));
  assert.equal(candidates.candidates[0].path,f.file);
  assert.equal(candidates.candidates[0].requires_approval,true);
  assert.equal(fs.statSync(f.file).mtimeMs,before.mtimeMs);
  assert.equal(fs.statSync(path.join(data.workspace,'01_observe/output/report.json')).mode & 0o777,0o600);
  assert.equal(fs.readlinkSync(path.join(data.workspace,'AGENTS.md')),'CONTEXT.md');
  const runtime=JSON.parse(fs.readFileSync(path.join(data.workspace,'runtime.json')));
  const command=spawnSync(runtime.argv[0],[...runtime.argv.slice(1),'config','--json'],{cwd:data.workspace,encoding:'utf8',env:{...process.env,...runtime.env}});
  assert.equal(command.status,0,command.stderr);
  assert.equal(JSON.parse(command.stdout).state,f.state);
  const rerun=run(['agent','--json'],f); assert.equal(rerun.status,0,rerun.stderr);
  assert.notEqual(JSON.parse(rerun.stdout).workspace,data.workspace);
  assert.ok(fs.existsSync(path.join(data.workspace,'03_decide/output/plan.md')));
});

test('background discovery respects mode and daily cooldown, while explicit refresh works',async()=>{
  const {refreshAgent}=await import('../../src/agent/workspace.js');
  const f=fixture('monitor');
  const cfg=JSON.parse(fs.readFileSync(path.join(f.state,'config.json')));
  assert.deepEqual(await refreshAgent({config:cfg,state:f.state,scheduled:true}),{skipped:true,reason:'mode'});
  cfg.cleanup.mode='agent';
  const first=await refreshAgent({config:cfg,state:f.state,scheduled:true,report:{stale:true},home:f.home});
  assert.ok(first.workspace);
  const next=await refreshAgent({config:cfg,state:f.state,scheduled:true,report:{stale:true},home:f.home});
  assert.equal(next.reason,'recent');
  cfg.cleanup.exclude=[path.dirname(f.file)];
  const changed=await refreshAgent({config:cfg,state:f.state,scheduled:true,report:{stale:true},home:f.home});
  assert.ok(changed.workspace,'changed preferences invalidate previous snapshot');
});

test('agent refuses injected workspace symlinks and invalid approval policy',()=>{
  const f=fixture(); const elsewhere=path.join(f.home,'elsewhere'); fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere,path.join(f.state,'agent'));
  const r=run(['agent','--json'],f); assert.notEqual(r.status,0);
  assert.deepEqual(fs.readdirSync(elsewhere),[]);
  const cfg=JSON.parse(fs.readFileSync(path.join(f.state,'config.json'))); cfg.cleanup.require_approval=false;
  fs.writeFileSync(path.join(f.state,'config.json'),JSON.stringify(cfg));
  const invalid=run(['candidates','--json'],f); assert.notEqual(invalid.status,0);
  assert.match(invalid.stderr,/approval/);
});

test('collector command automatically discovers once and honors the saved cooldown',()=>{
  const f=fixture();
  const first=run(['scan','--once'],f); assert.equal(first.status,0,first.stderr);
  const output=JSON.parse(first.stdout);
  assert.equal(output.ok,true);
  assert.equal(output.discovery.candidate_count,1);
  const second=run(['scan','--once'],f); assert.equal(second.status,0,second.stderr);
  assert.equal(JSON.parse(second.stdout).discovery.reason,'recent');
});
