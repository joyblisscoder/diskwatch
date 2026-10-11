import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {cleanupPolicy} from '../onboarding.js';
import {savePlan,getPlan,recordOutcome} from './memory.js';

const canonical = value => path.resolve(value).normalize('NFC').toLowerCase();
const inside = (target,parent) => canonical(target) === canonical(parent) || canonical(target).startsWith(canonical(parent)+path.sep);
const expand = (value,home) => value.startsWith('~/') ? path.join(home,value.slice(2)) : path.resolve(value);
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export const candidateId = item => digest([canonical(item.path),item.fingerprint]);
export const policyFingerprint = config => digest(cleanupPolicy(config.cleanup));

export function selectCandidate(result,reference) {
  if (typeof reference !== 'string' || !reference) throw new Error('Choose a candidate ID from diskwatch candidates.');
  const all=[...(result.candidates || []),...(result.suppressed || [])];
  const matches=all.filter(item=>item.path === reference || (reference.length >= 8 && candidateId(item).startsWith(reference)));
  if (matches.length !== 1) throw new Error(matches.length ? 'Ambiguous candidate ID; use the full ID.' : 'Candidate not found in the current scan. Refresh candidates and check coverage.');
  return matches[0];
}

// Refuse aliases at every component. These checks establish observation scope;
// they are not an atomic authorization boundary for an external file operation.
function checkedStat(target) {
  let current=path.parse(target).root;
  const parts=target.slice(current.length).split(path.sep).filter(Boolean);
  for (let index=0;index<parts.length;index++) {
    current=path.join(current,parts[index]);
    const stat=fs.lstatSync(current,{throwIfNoEntry:false});
    if (!stat) {
      if(index === parts.length-1) return null;
      throw new Error('An ancestor is missing; verification is incomplete.');
    }
    if(stat.isSymbolicLink()) throw new Error('Symlink path requires a new investigation.');
    if(index < parts.length-1 && !stat.isDirectory()) throw new Error('Invalid path ancestor.');
    if(index === parts.length-1) return stat;
  }
  throw new Error('Filesystem root is not a cleanup item.');
}

function assertScope(item,config,state,home) {
  const policy=cleanupPolicy(config.cleanup);
  if (!path.isAbsolute(item.path) || !policy.roots.some(root=>inside(item.path,expand(root,home))) || policy.exclude.some(root=>inside(item.path,expand(root,home))) || inside(item.path,state) || inside(state,item.path)) throw new Error('Item is outside current investigation scope or contains DiskWatch state.');
}

function space(anchor) {
  const stat=checkedStat(anchor);
  if(!stat?.isDirectory()) throw new Error('Measurement anchor is missing.');
  const volume=fs.statfsSync(anchor,{bigint:true});
  const available=Number(volume.bavail*volume.bsize);
  if(!Number.isSafeInteger(available) || available < 0) throw new Error('Free-space measurement is unavailable.');
  return {free_bytes:available,device:stat.dev};
}

export function createCleanupPlan({state,config,result,reference,home=os.homedir()}) {
  const item=selectCandidate(result,reference);
  assertScope(item,config,state,home);
  if(!item.evidence?.traversal_complete || item.blockers?.includes('project_activity_incomplete') || !/^[a-f0-9]{64}$/.test(item.fingerprint || '')) throw new Error('An incomplete candidate cannot become a cleanup plan.');
  if((result.suppressed || []).some(x=>candidateId(x) === candidateId(item))) throw new Error('This item is kept or snoozed. Clear that decision before planning cleanup.');
  const stat=checkedStat(item.path);
  if(!stat || (!stat.isDirectory() && !stat.isFile()) || stat.uid !== process.getuid()) throw new Error('Item is missing, special, or not owned by this user.');
  const anchor=path.dirname(item.path);
  const measured=space(anchor);
  if(measured.device !== stat.dev) throw new Error('Item is on a different filesystem from its parent.');
  const plan={schema_version:1,id:randomUUID(),created_at:new Date().toISOString(),approval:'required',
    policy_fingerprint:policyFingerprint(config),items:[{...item,id:candidateId(item),identity:{device:stat.dev,inode:stat.ino}}],
    measurement_anchor:anchor,measurement_device:measured.device,before_free_bytes:measured.free_bytes,
    required_checks:['Confirm ownership and current project/app activity','Verify a recovery or regeneration route without running project scripts','Show the exact path and method; wait for owner approval','Recheck this plan immediately before external action'],
    execution:'External owner-approved tool or Finder only. This plan is not permission to act.'};
  plan.verification=`Run diskwatch cleanup verify ${plan.id} after the approved action. Absence does not prove deletion or Trash placement. Free-space delta is observed, not attributed.`;
  savePlan({state,plan});
  return plan;
}

export function verifyCleanupPlan({state,config,result,id,home=os.homedir(),record=true}) {
  const plan=getPlan({state,id});
  if(!plan) throw new Error('Cleanup plan not found.');
  const item=plan.items[0];
  let status='verification_incomplete',reason=null,after=null;
  try {
    if(policyFingerprint(config) !== plan.policy_fingerprint) status='policy_changed';
    else {
      assertScope(item,config,state,home);
      const stat=checkedStat(item.path);
      const measured=space(plan.measurement_anchor);
      if(measured.device !== plan.measurement_device) throw new Error('Measurement filesystem changed.');
      after=measured.free_bytes;
      if(!stat) status='path_absent';
      else if(stat.dev !== item.identity.device || stat.ino !== item.identity.inode) status='recreated';
      else {
        if((result.suppressed || []).some(x=>canonical(x.path) === canonical(item.path))) throw new Error('This item is kept or snoozed. Owner-directed clearing or fresh investigation is required.');
        const current=[...(result.candidates || []),...(result.suppressed || [])].find(x=>canonical(x.path) === canonical(item.path));
        if(current?.evidence?.traversal_complete) status=current.fingerprint === item.fingerprint ? 'still_present_unchanged' : 'still_present_changed';
        else if(!result.partial) status='still_present_changed';
      }
    }
  } catch(err) { reason=err.message; }
  const outcome={action_id:randomUUID(),plan_id:plan.id,path:item.path,method:'external_observation',status,
    observed_at:new Date().toISOString(),verified:status === 'path_absent',external_action_reported:false,
    before_free_bytes:plan.before_free_bytes,after_free_bytes:after,
    measured_delta_bytes:after === null ? null : after-plan.before_free_bytes,reclaimed_bytes:null,
    verification:{source_absent:status === 'path_absent',source_unchanged:status === 'still_present_unchanged',volume_changed:after !== null && after !== plan.before_free_bytes,reason},
    note:'Verification observes the original location and volume. It does not prove which tool acted or attribute free-space changes. Trash usually does not free space.'};
  if(record) recordOutcome({state,...outcome});
  return outcome;
}
