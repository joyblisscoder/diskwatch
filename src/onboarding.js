import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { THRESHOLDS, configPath } from './config.js';

export const MODES = ['monitor', 'suggest', 'agent'];
const BASIC = ['~/Downloads', '~/Library/Caches', '~/.npm'];
const DEVELOPER = [...BASIC, '~/Developer', '~/.cache'];
const AGENT_MONITORING = ['~/.claude/projects','~/.codex/sessions','~/.codex/worktrees','~/.grok/sessions','~/Library/Developer','~/Library/Containers','~/Library/Application Support/Claude/vm_bundles','~/.local/share/pnpm/store','~/Library/pnpm','~/.ollama','~/.Trash'];

export function cleanupPolicy(value = {}) {
  const policy = {mode:'suggest',roots:[],exclude:[],min_age_days:30,min_size_mb:100,require_approval:true,...value};
  if (!MODES.includes(policy.mode)) throw new Error('cleanup.mode must be monitor, suggest, or agent.');
  if (policy.require_approval !== true) throw new Error('Cleanup requires approval of the exact items. Automatic deletion is not supported.');
  for (const key of ['roots','exclude']) {
    if (!Array.isArray(policy[key]) || policy[key].some(p => typeof p !== 'string' || !p || /[\x00-\x1f\x7f]/.test(p) || !(path.isAbsolute(p) || p.startsWith('~/')))) throw new Error(`cleanup.${key} must contain absolute or ~/ paths.`);
  }
  for (const [key,min,max] of [['min_age_days',1,3650],['min_size_mb',1,1048576]]) {
    if (!Number.isInteger(policy[key]) || policy[key] < min || policy[key] > max) throw new Error(`cleanup.${key} must be a whole number between ${min} and ${max}.`);
  }
  return policy;
}

function defaults(existing = null) {
  return {
    notifications:{channel:'none'},
    integrations:{worktree_helper:false,external_logs:false,agent_menu:false},
    thresholds:structuredClone(THRESHOLDS),
    watchlist:BASIC.map(p => ({path:p,mode:p.endsWith('Caches') ? 'expand' : 'leaf'})),
    ...existing,
    cleanup:cleanupPolicy(existing?.cleanup || {roots:existing ? [] : BASIC}),
  };
}

async function choose(ask, text, values, fallback) {
  for (;;) {
    const answer = String(await ask(text)).trim() || fallback;
    if (values.includes(answer)) return answer;
  }
}

async function number(ask, text, fallback, min, max) {
  for (;;) {
    const answer = String(await ask(text)).trim();
    const n = answer ? Number(answer) : fallback;
    if (Number.isInteger(n) && n >= min && n <= max) return n;
  }
}

export async function configure({existing = null,home = os.homedir(),state = path.join(home,'.local/state/diskwatch'),ask,write = console.log} = {}) {
  const cfg = defaults(existing);
  write('\nWelcome to DiskWatch. Let’s agree on the scope first.\n' +
    'It measures folder sizes, free space, swap and growth. Metadata stays on this Mac.\n' +
    'It does not read file contents, send telemetry, or delete monitored files.\n' +
    'Agents get evidence and a review workflow. Every cleanup needs your approval.\n' +
    'No model runs or paid services are started by setup. Ctrl-C cancels.\n');
  const scope = await choose(ask,
    `What should it watch and investigate?\n  1. Downloads and caches\n  2. Those plus developer projects\n  3. Keep current watchlist and investigation scope\n  4. Agentic coder (recommended): projects/caches, plus SIZE MONITORING of agent history, worktrees, native developer/container stores and models. No transcript reads or cleanup permission.\nScope [${existing ? '3' : '4'}]: `, ['1','2','3','4'], existing ? '3' : '4');
  if (scope !== '3') cfg.watchlist = (scope === '1' ? BASIC : DEVELOPER).map(p => ({path:p,mode:'expand'}));
  if (scope === '4') cfg.watchlist.push(...AGENT_MONITORING.map(p=>({path:p,mode:'leaf',protected:1})));
  const modeDefault = String(MODES.indexOf(cfg.cleanup.mode)+1);
  const mode = await choose(ask,
    `\nHow automatic?\n  1. Monitor only. No scheduled stale-file search.\n  2. Suggest when I ask (recommended).\n  3. Discover daily. Prepare fresh evidence for my agent automatically.\nAll modes require approval before cleanup; mode 3 does not launch an AI.\nChoice [${modeDefault}]: `, ['1','2','3'], modeDefault);
  cfg.cleanup.mode = MODES[Number(mode)-1];
  if (scope !== '3') cfg.cleanup.roots = (scope === '4' ? DEVELOPER.filter(p=>p !== '~/Downloads') : cfg.watchlist.map(x => x.path)).filter(p => p !== '~/.Trash');
  write('\nFolders excluded from investigation stay out of candidate results.\n' +
    'Documents, photos, credentials, app state and agent history remain protected.');
  for (;;) {
    write('Current exclusions: '+JSON.stringify(cfg.cleanup.exclude));
    const answer = String(await ask('Add exclusions separated by semicolons (~/path). Enter keeps current; type CLEAR to remove all: ')).trim();
    const exclude = answer === 'CLEAR' ? [] : answer ? [...new Set([...cfg.cleanup.exclude,...answer.split(';').map(x=>x.trim())])] : cfg.cleanup.exclude;
    try { cfg.cleanup = cleanupPolicy({...cfg.cleanup,exclude}); break; }
    catch (err) { write(err.message); }
  }
  cfg.cleanup.min_age_days = await number(ask,`Look for items unchanged for how many days? [${cfg.cleanup.min_age_days}]: `,cfg.cleanup.min_age_days,1,3650);
  cfg.cleanup.min_size_mb = await number(ask,`Smallest candidate size in MB? [${cfg.cleanup.min_size_mb}]: `,cfg.cleanup.min_size_mb,1,1048576);
  const warnDefault=cfg.thresholds?.free_warn_gb ?? 40;
  const warn = await number(ask,`Warn below how many GB free? [${warnDefault}]: `,warnDefault,1,1048576);
  cfg.thresholds = {...THRESHOLDS,...cfg.thresholds,free_warn_gb:warn,free_critical_gb:Math.min(cfg.thresholds?.free_critical_gb ?? 20,warn)};
  cfg.notifications = {channel:(await choose(ask,'Enable local Mac notifications? [y/N]: ',['y','n','Y','N'],'n')).toLowerCase() === 'y' ? 'macos' : 'none'};
  cfg.onboarding = {version:1,completed_at:new Date().toISOString()};
  write('\nReview your scope:\n' + cfg.watchlist.map(x=>'  '+JSON.stringify(x.path)).join('\n') +
    `\nInvestigation roots: ${JSON.stringify(cfg.cleanup.roots)}\nAutomation: ${cfg.cleanup.mode}; cleanup approval: always\n` +
    `Candidates: ${cfg.cleanup.min_age_days}+ days unchanged, ${cfg.cleanup.min_size_mb}+ MB\n` +
    `Excluded: ${JSON.stringify(cfg.cleanup.exclude)}\nNotifications: ${cfg.notifications.channel}\n` +
    `Local state: ${JSON.stringify(state)}\n` +
    'Old does not mean unused. Candidates are investigation leads, never permission to delete.');
  const save = await choose(ask,'Save these preferences? [y/N]: ',['y','n','Y','N'],'n');
  return save.toLowerCase() === 'y' ? cfg : null;
}

export function readSettings(file = configPath()) {
  const stat = fs.lstatSync(file,{throwIfNoEntry:false});
  if (!stat) return null;
  if (!stat.isFile() || stat.uid !== process.getuid()) throw new Error('Refusing unsafe configuration file.');
  return JSON.parse(fs.readFileSync(file,'utf8'));
}

export function saveSettings(cfg, file = configPath()) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir,{recursive:true,mode:0o700});
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid()) throw new Error('Refusing unsafe state directory.');
  readSettings(file);
  const temporary = path.join(dir,`.config-${process.pid}-${Date.now()}.tmp`);
  fs.writeFileSync(temporary,JSON.stringify(cfg,null,2)+'\n',{flag:'wx',mode:0o600});
  fs.renameSync(temporary,file);
  fs.chmodSync(dir,0o700);
}

export async function runOnboarding({useDefaults = false} = {}) {
  if (!useDefaults && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new Error('Setup needs an interactive terminal. Run it directly, or use --defaults for read-only defaults without background jobs.');
  const existing = readSettings();
  let cfg;
  if (useDefaults) {
    cfg = defaults(existing);
    console.log('Scope: '+JSON.stringify(cfg.watchlist.map(x=>x.path))+'\nRead-only preferences; cleanup always requires approval. Existing preferences are preserved.');
  } else {
    const rl = createInterface({input:process.stdin,output:process.stdout});
    try { cfg = await configure({existing,state:path.dirname(configPath()),ask:q=>rl.question(q)}); }
    finally { rl.close(); }
  }
  if (!cfg) { console.log('Cancelled. Preferences were not changed.'); return false; }
  saveSettings(cfg);
  console.log(`Saved preferences to ${JSON.stringify(configPath())}. Re-run diskwatch setup to change them.`);
  return true;
}
