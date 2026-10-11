import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cleanupPolicy } from '../onboarding.js';
import { discoverCandidates } from '../cleanup/discover.js';
import {applyDecisions,decisionList,listOutcomes} from '../cleanup/memory.js';
import {candidateId} from '../cleanup/workflow.js';
import {developerInventory} from '../cleanup/inventory.js';

export async function inventoryFor({config,state,home=os.homedir()}) {
  const p=policyFor(config);
  if (!p.roots.length) return {projects:[],worktrees:[],coverage:{complete:true,roots:[]},errors:[]};
  return developerInventory({roots:p.roots.map(x=>expand(x,home)),exclude:[state,...p.exclude.map(x=>expand(x,home))],home});
}

const templates = fileURLToPath(new URL('../../agent/',import.meta.url));
const expand = (p,home) => p.startsWith('~/') ? path.join(home,p.slice(2)) : path.resolve(p);
export function policyFor(config) {
  if (!config.cleanup) throw new Error('Choose your scope first: run diskwatch setup.');
  return cleanupPolicy(config.cleanup);
}

export async function candidatesFor({config,state,home=os.homedir()}) {
  const p=policyFor(config);
  if (!p.roots.length) return {schema_version:1,generated_at:new Date().toISOString(),candidates:[],partial:false,errors:[],coverage:{roots:[],complete:true,entries_scanned:0},note:'No investigation roots approved. Run diskwatch setup.'};
  const result=await discoverCandidates({roots:p.roots.map(x=>expand(x,home)),exclude:[state,...p.exclude.map(x=>expand(x,home))],minAgeDays:p.min_age_days,minBytes:p.min_size_mb*1024*1024,home});
  result.candidates=result.candidates.map(item=>({...item,id:candidateId(item)}));
  return applyDecisions({state,result});
}

function directory(dir) {
  const st=fs.lstatSync(dir,{throwIfNoEntry:false});
  if (st && (!st.isDirectory() || st.uid !== process.getuid())) throw new Error('Refusing unsafe agent workspace directory.');
  if (!st) fs.mkdirSync(dir,{mode:0o700});
  fs.chmodSync(dir,0o700);
}
function write(file,data) { fs.writeFileSync(file,data,{flag:'wx',mode:0o600}); }
function json(file,data) { write(file,JSON.stringify(data,null,2)+'\n'); }

export async function refreshAgent({config,state,report={stale:true,note:'Run diskwatch scan --once for a volume baseline.'},scheduled=false,home=os.homedir()} = {}) {
  const policy=policyFor(config);
  if (scheduled && policy.mode !== 'agent') return {skipped:true,reason:'mode'};
  const root=path.join(state,'agent');
  directory(state); directory(root);
  const latest=path.join(root,'latest.json');
  const st=fs.lstatSync(latest,{throwIfNoEntry:false});
  if (st && (!st.isFile() || st.uid !== process.getuid())) throw new Error('Refusing unsafe agent index.');
  const fingerprint=createHash('sha256').update(JSON.stringify(policy)).digest('hex');
  if (scheduled && st) {
    const previous=JSON.parse(fs.readFileSync(latest,'utf8'));
    const age=Date.now()-Date.parse(previous.generated_at);
    if (previous.policy_fingerprint === fingerprint && age >= 0 && age < 86400000) return {skipped:true,reason:'recent',workspace:previous.workspace};
  }
  // Complete discovery before publishing a new run. No other run is overwritten.
  const candidates=await candidatesFor({config,state,home});
  const runs=path.join(root,'runs'); directory(runs);
  const workspace=path.join(runs,new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));
  directory(workspace);
  json(path.join(workspace,'runtime.json'),{argv:[process.execPath,fileURLToPath(new URL('../../bin/diskwatch',import.meta.url))],env:{DISKWATCH_STATE_DIR:state,HOME:home}});
  write(path.join(workspace,'CONTEXT.md'),fs.readFileSync(path.join(templates,'CONTEXT.md'),'utf8'));
  fs.symlinkSync('CONTEXT.md',path.join(workspace,'AGENTS.md'));
  fs.symlinkSync('CONTEXT.md',path.join(workspace,'CLAUDE.md'));
  for (const stage of ['01_observe','02_investigate','03_decide']) {
    directory(path.join(workspace,stage)); directory(path.join(workspace,stage,'output'));
    write(path.join(workspace,stage,'CONTEXT.md'),fs.readFileSync(path.join(templates,stage,'CONTEXT.md'),'utf8'));
    fs.symlinkSync('CONTEXT.md',path.join(workspace,stage,'AGENTS.md'));
    fs.symlinkSync('CONTEXT.md',path.join(workspace,stage,'CLAUDE.md'));
  }
  json(path.join(workspace,'01_observe/output/report.json'),report);
  json(path.join(workspace,'01_observe/output/policy.json'),{...policy,generated_at:new Date().toISOString(),state_directory:state});
  json(path.join(workspace,'02_investigate/output/candidates.json'),candidates);
  json(path.join(workspace,'02_investigate/output/inventory.json'),await inventoryFor({config,state,home}));
  json(path.join(workspace,'02_investigate/output/decisions.json'),decisionList({state}));
  json(path.join(workspace,'03_decide/output/outcomes.json'),listOutcomes({state,limit:10}));
  write(path.join(workspace,'03_decide/output/plan.md'),fs.readFileSync(path.join(templates,'plan-template.md'),'utf8'));
  const result={schema_version:1,generated_at:new Date().toISOString(),workspace,policy_fingerprint:fingerprint,candidate_count:candidates.candidates.length,suppressed_count:candidates.suppressed?.length || 0,partial:candidates.partial,requires_approval:true};
  const pending=path.join(root,`latest-${randomUUID()}.tmp`);
  json(pending,result); fs.renameSync(pending,latest);
  return result;
}
