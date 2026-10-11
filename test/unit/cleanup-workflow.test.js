import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCandidates } from '../../src/cleanup/discover.js';

async function fixture() {
  const home=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'diskwatch-plan-')));
  const root=path.join(home,'projects'); fs.mkdirSync(root);
  const artifact=path.join(root,'node_modules'); fs.mkdirSync(artifact);
  fs.writeFileSync(path.join(artifact,'data.bin'),Buffer.alloc(1024));
  const old=new Date(Date.now()-90*86400000);
  fs.utimesSync(path.join(artifact,'data.bin'),old,old); fs.utimesSync(artifact,old,old);
  const config={cleanup:{mode:'suggest',roots:[root],exclude:[],min_age_days:30,min_size_mb:1,require_approval:true}};
  const result=await discoverCandidates({roots:[root],home,minBytes:1});
  const state=path.join(home,'state'); fs.mkdirSync(state);
  return {home,root,artifact,config,result,state};
}

test('plan captures an exact item and verification distinguishes unchanged, changed, absent and recreated',async()=>{
  const {createCleanupPlan,verifyCleanupPlan,candidateId}=await import('../../src/cleanup/workflow.js');
  const f=await fixture();
  const id=candidateId(f.result.candidates[0]);
  const plan=createCleanupPlan({...f,reference:id});
  assert.equal(plan.items[0].path,f.artifact);
  assert.equal(plan.approval,'required');
  assert.ok(Number.isFinite(plan.before_free_bytes));
  const unchanged=verifyCleanupPlan({...f,id:plan.id});
  assert.equal(unchanged.status,'still_present_unchanged');
  assert.equal(unchanged.verified,false);
  fs.writeFileSync(path.join(f.artifact,'data.bin'),'changed');
  const changedResult=await discoverCandidates({roots:[f.root],home:f.home,minBytes:1});
  assert.equal(verifyCleanupPlan({...f,result:changedResult,id:plan.id}).status,'still_present_changed');
  const moved=path.join(f.home,'test-trash'); fs.renameSync(f.artifact,moved);
  const missing=verifyCleanupPlan({...f,id:plan.id,result:{candidates:[],partial:false}});
  assert.equal(missing.status,'path_absent');
  assert.equal(missing.verified,true);
  assert.equal(missing.reclaimed_bytes,null);
  assert.equal(missing.measured_delta_bytes,missing.after_free_bytes-missing.before_free_bytes);
  fs.mkdirSync(f.artifact);
  const recreated=verifyCleanupPlan({...f,id:plan.id,result:{candidates:[],partial:false}});
  assert.equal(recreated.status,'recreated');
});

test('plans refuse incomplete candidates and verification refuses changed policy or symlink ancestors',async()=>{
  const {createCleanupPlan,verifyCleanupPlan,candidateId}=await import('../../src/cleanup/workflow.js');
  const f=await fixture(); const item=f.result.candidates[0];
  const incomplete=structuredClone(f.result); incomplete.candidates[0].evidence.traversal_complete=false;
  assert.throws(()=>createCleanupPlan({...f,result:incomplete,reference:candidateId(item)}),/incomplete/i);
  const partialProject=structuredClone(f.result); partialProject.candidates[0].blockers.push('project_activity_incomplete');
  assert.throws(()=>createCleanupPlan({...f,result:partialProject,reference:candidateId(item)}),/incomplete/i);
  const plan=createCleanupPlan({...f,reference:candidateId(item)});
  const cfg=structuredClone(f.config); cfg.cleanup.exclude=[f.root];
  assert.equal(verifyCleanupPlan({...f,config:cfg,id:plan.id}).status,'policy_changed');
  fs.renameSync(f.root,path.join(f.home,'elsewhere')); fs.symlinkSync(path.join(f.home,'elsewhere'),f.root);
  assert.equal(verifyCleanupPlan({...f,id:plan.id}).status,'verification_incomplete');
});

test('a newer owner keep or snooze blocks an existing plan until explicitly cleared',async()=>{
  const {createCleanupPlan,verifyCleanupPlan,candidateId}=await import('../../src/cleanup/workflow.js');
  const {rememberDecision,applyDecisions}=await import('../../src/cleanup/memory.js');
  const f=await fixture(); const item=f.result.candidates[0];
  const plan=createCleanupPlan({...f,reference:candidateId(item)});
  for(const decision of ['keep','snooze']) {
    rememberDecision({state:f.state,candidate:item,decision});
    const blocked=verifyCleanupPlan({...f,result:applyDecisions({state:f.state,result:f.result}),id:plan.id,record:false});
    assert.equal(blocked.status,'verification_incomplete');
    assert.equal(blocked.verification.source_unchanged,false);
    assert.match(blocked.verification.reason,/kept or snoozed/i);
    rememberDecision({state:f.state,candidate:item,decision:'clear'});
    assert.equal(verifyCleanupPlan({...f,result:applyDecisions({state:f.state,result:f.result}),id:plan.id,record:false}).status,'still_present_unchanged');
  }
});
