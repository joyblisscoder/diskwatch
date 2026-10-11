import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const xml = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&apos;'}[c]));
const sh = value => "'" + String(value).replace(/'/g, "'\\''") + "'";

export function install({home = os.homedir(), state = process.env.DISKWATCH_STATE_DIR || path.join(home,'.local/state/diskwatch'), project = projectRoot, node = process.execPath, start = false, dryRun = false} = {}) {
  if (process.platform !== 'darwin') throw new Error('DiskWatch supports macOS only.');
  [home,state,project,node].forEach(p => {
    if (!path.isAbsolute(p) || /[\r\n\0]/.test(p)) throw new Error('Installation paths must be absolute and contain no line breaks.');
  });
  const probe = spawnSync(node, ['-e', "require('node:sqlite'); if(Number(process.versions.node.split('.')[0])<22)process.exit(1)"], {encoding:'utf8'});
  if (probe.status !== 0) throw new Error('Install Node.js 22.13 or later with built-in SQLite first.');
  const cli = path.join(project,'bin/diskwatch');
  if (!fs.existsSync(cli)) throw new Error(`Missing DiskWatch source: ${cli}`);
  const bin = path.join(home,'.local/bin/diskwatch');
  const agents = path.join(home,'Library/LaunchAgents');
  const logs = path.join(state,'logs');
  const jobs = ['collector','server'];
  const files = new Map([[bin, `#!/bin/sh\n# Managed by DiskWatch installer\nexport DISKWATCH_STATE_DIR=${sh(state)}\nexec ${sh(node)} ${sh(cli)} "$@"\n`]]);
  for (const job of jobs) {
    const label = `com.diskwatch.${job}`;
    const args = [node,cli,...(job === 'collector' ? ['scan','--once'] : ['serve','--port','7381'])];
    const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<!-- Managed by DiskWatch installer -->\n<plist version="1.0"><dict>\n<key>Label</key><string>${label}</string>\n<key>ProgramArguments</key><array>${args.map(a => `<string>${xml(a)}</string>`).join('')}</array>\n<key>EnvironmentVariables</key><dict><key>DISKWATCH_STATE_DIR</key><string>${xml(state)}</string></dict>\n${job === 'collector' ? '<key>StartInterval</key><integer>900</integer><key>Nice</key><integer>10</integer><key>LowPriorityIO</key><true/>' : '<key>KeepAlive</key><true/>'}\n<key>RunAtLoad</key><true/>\n<key>StandardOutPath</key><string>${xml(path.join(logs,job+'.stdout.log'))}</string>\n<key>StandardErrorPath</key><string>${xml(path.join(logs,job+'.stderr.log'))}</string>\n</dict></plist>\n`;
    files.set(path.join(agents,label+'.plist'),plist);
  }
  // Preflight every destination before writing anything. Never replace an
  // unrelated binary, symlink, or modified launch agent.
  for (const [file, content] of files) {
    const stat = fs.lstatSync(file,{throwIfNoEntry:false});
    if (stat && (!stat.isFile() || stat.uid !== process.getuid() || fs.readFileSync(file,'utf8') !== content)) throw new Error(`Refusing to replace existing file: ${file}`);
  }
  const plists = [...files.keys()].filter(p => p.endsWith('.plist'));
  const loadedJobs = new Set();
  const domain = `gui/${process.getuid()}`;
  if (start) {
    for (let i=0; i<plists.length; i++) {
      const label=path.basename(plists[i],'.plist');
      const loaded=spawnSync('launchctl',['print',`${domain}/${label}`],{encoding:'utf8'});
      if (loaded.status !== 0) {
        const message=`${loaded.stdout || ''}${loaded.stderr || ''}`;
        if (![113,125].includes(loaded.status) && !/could not find service|no such|not found/i.test(message)) throw new Error(`Could not inspect ${label}: ${message}`);
        continue;
      }
      const lines=loaded.stdout.split('\n').map(line=>line.trim());
      const argsBlock=/^\s*arguments = \{\n([\s\S]*?)^\s*\}/m.exec(loaded.stdout);
      const actualArgs=argsBlock ? argsBlock[1].split('\n').map(s=>s.trim()).filter(Boolean) : [];
      const expectedArgs=[node,cli,...(jobs[i] === 'collector' ? ['scan','--once'] : ['serve','--port','7381'])];
      if (!lines.includes(`path = ${plists[i]}`) || !lines.includes(`DISKWATCH_STATE_DIR => ${state}`) || JSON.stringify(actualArgs) !== JSON.stringify(expectedArgs)) {
        throw new Error(`Running job ${label} belongs to a different installation. Stop it explicitly before installing here.`);
      }
      loadedJobs.add(label);
    }
  }
  if (dryRun) return {bin,plists,state,start,files:Object.fromEntries(files)};
  for (const directory of [state,logs,path.dirname(bin),agents]) {
    const stat=fs.lstatSync(directory,{throwIfNoEntry:false});
    if (stat && (!stat.isDirectory() || stat.uid !== process.getuid())) throw new Error(`Refusing unsafe installation directory: ${directory}`);
  }
  const configFile = path.join(state,'config.json');
  const configStat=fs.lstatSync(configFile,{throwIfNoEntry:false});
  if (configStat && (!configStat.isFile() || configStat.uid !== process.getuid())) throw new Error(`Refusing unsafe configuration: ${configFile}`);
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile,'utf8')) : null;
  if (config?.installation && config.installation.project !== project) throw new Error('Refusing to replace another DiskWatch installation.');
  fs.mkdirSync(path.dirname(bin),{recursive:true});
  fs.mkdirSync(agents,{recursive:true});
  fs.mkdirSync(logs,{recursive:true,mode:0o700});
  fs.chmodSync(state,0o700);
  fs.chmodSync(logs,0o700);
  for (const [file,content] of files) {
    const mode=file === bin ? 0o755 : 0o644;
    fs.writeFileSync(file,content,{mode});
    fs.chmodSync(file,mode);
  }
  const init = spawnSync(node,[cli,'migrate'],{encoding:'utf8',env:{...process.env,DISKWATCH_STATE_DIR:state}});
  if (init.status !== 0) throw new Error(`Database initialization failed: ${init.stderr}`);
  const seed = spawnSync(node,[cli,'config','--json'],{encoding:'utf8',env:{...process.env,DISKWATCH_STATE_DIR:state}});
  if (seed.status !== 0) throw new Error(`Configuration initialization failed: ${seed.stderr}`);
  const cfg = JSON.parse(fs.readFileSync(configFile,'utf8'));
  cfg.installation = { project, jobs:jobs.map(j => `com.diskwatch.${j}`) };
  fs.writeFileSync(configFile,JSON.stringify(cfg,null,2)+'\n',{mode:0o600});
  fs.chmodSync(configFile,0o600);
  if (start) {
    for (const plist of plists) {
      const label = path.basename(plist,'.plist');
      if (loadedJobs.has(label)) continue;
      const boot = spawnSync('launchctl',['bootstrap',domain,plist],{encoding:'utf8'});
      if (boot.status !== 0) throw new Error(`Could not start ${label}: ${boot.stderr}`);
    }
  }
  return {bin,plists,state,start};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.some(a => !['--start','--dry-run'].includes(a))) throw new Error('Usage: node scripts/install.js [--start] [--dry-run]');
    console.log(JSON.stringify(install({start:args.includes('--start'),dryRun:args.includes('--dry-run')}),null,2));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
