import fs from 'node:fs';
import path from 'node:path';
import {policyFingerprint} from './workflow.js';

/** Small snapshot for reports and the menu. Never trigger a filesystem scan. */
export function cleanupSummary({state,config,now=Date.now()}) {
  if(!config.cleanup) return null;
  try {
    const dir=path.join(state,'agent');
    const directory=fs.lstatSync(dir,{throwIfNoEntry:false});
    if(!directory) return {status:'not_scanned',candidate_count:0,suppressed_count:0};
    if(!directory.isDirectory() || directory.uid !== process.getuid()) throw new Error('unsafe index');
    const file=path.join(dir,'latest.json');
    const st=fs.lstatSync(file,{throwIfNoEntry:false});
    if(!st) return {status:'not_scanned',candidate_count:0,suppressed_count:0};
    if(!st.isFile() || st.uid !== process.getuid() || st.size > 65536) throw new Error('invalid index');
    const latest=JSON.parse(fs.readFileSync(file,'utf8'));
    if(!Number.isInteger(latest.candidate_count) || latest.candidate_count < 0 || !Number.isFinite(Date.parse(latest.generated_at))) throw new Error('invalid summary');
    const changed=latest.policy_fingerprint !== policyFingerprint(config);
    const age=now-Date.parse(latest.generated_at);
    return {status:changed ? 'policy_changed' : age < 0 || age > 86400000 ? 'stale' : 'ready',as_of:latest.generated_at,
      candidate_count:latest.candidate_count,suppressed_count:latest.suppressed_count || 0,partial:latest.partial === true,
      next_command:'diskwatch agent'};
  } catch {return {status:'unavailable',next_command:'diskwatch agent'};}
}
