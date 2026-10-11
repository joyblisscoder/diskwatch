import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../..');

test('CLI remembers an owner decision, clears it, plans and records external verification',()=>{
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'diskwatch-steward-')));
  const watched=path.join(home,'project'); fs.mkdirSync(watched);
  const target=path.join(watched,'node_modules'); fs.mkdirSync(target);
  const file=path.join(target,'data.bin'); fs.writeFileSync(file,Buffer.alloc(1024*1024));
  const old=new Date(Date.now()-90*86400000); fs.utimesSync(file,old,old); fs.utimesSync(target,old,old);
  const state=path.join(home,'state'); fs.mkdirSync(state);
  fs.writeFileSync(path.join(state,'config.json'),JSON.stringify({notifications:{channel:'none'},integrations:{},watchlist:[],cleanup:{mode:'suggest',roots:[watched],exclude:[],min_age_days:30,min_size_mb:1,require_approval:true}}));
  const run=(...args)=>{
    const r=spawnSync(process.execPath,['bin/diskwatch',...args,'--json'],{cwd:root,encoding:'utf8',timeout:20000,env:{...process.env,HOME:home,DISKWATCH_STATE_DIR:state}});
    assert.equal(r.status,0,r.stderr); return JSON.parse(r.stdout);
  };
  const candidate=run('candidates').candidates[0];
  run('decide',candidate.id,'keep');
  const hidden=run('candidates'); assert.equal(hidden.candidates.length,0); assert.equal(hidden.suppressed.length,1);
  assert.equal(run('decisions')[0].decision,'keep');
  run('decide',candidate.id,'clear');
  const plan=run('cleanup','plan',candidate.id);
  assert.equal(run('cleanup','check',plan.id).status,'still_present_unchanged');
  assert.equal(run('cleanup','history').length,0,'a preflight is not an executed action');
  fs.renameSync(target,path.join(home,'fixture-trash'));
  const result=run('cleanup','verify',plan.id);
  assert.equal(result.status,'path_absent'); assert.equal(result.reclaimed_bytes,null);
  assert.equal(run('cleanup','history')[0].plan_id,plan.id);
});
