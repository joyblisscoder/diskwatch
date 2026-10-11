import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../',import.meta.url));
// Explicit file allowlist. Never copy directories recursively: new files may
// contain private state or notes and require deliberate inclusion.
export const RELEASE_FILES = [
  'README.md','LICENSE','CONTRIBUTING.md','SECURITY.md','package.json','.gitignore',
  '.github/workflows/ci.yml','docs/PUBLIC-CONTEXT.md',
  'bin/diskwatch','swiftbar/diskwatch.60s.sh','scripts/install.js','scripts/package-release.js',
  'public/app.js','public/chart.js','public/index.html','public/styles.css',
  'src/cli.js','src/config.js','src/doctor.js',
  'src/db/db.js','src/db/migrate.js','src/db/schema.sql',
  'src/ingest/diskguard-log.js','src/ingest/janitor-log.js','src/ingest/run.js',
  'src/learn/classify.js','src/learn/rollup.js','src/notify/notify.js','src/report/report.js',
  'src/scan/collector.js','src/scan/volume.js','src/scan/watchlist.js',
  'src/server/routes.js','src/server/server.js','src/util/fmt.js','src/util/log.js','src/util/time.js',
  'test/run-all.sh','test/helpers.js','test/fixtures/hermes-stub.sh',
  'test/unit/classify.test.js','test/unit/collector-events.test.js','test/unit/db.test.js',
  'test/unit/fmt.test.js','test/unit/ingest.test.js','test/unit/notify.test.js',
  'test/unit/report.test.js','test/unit/rollup.test.js','test/unit/swiftbar.test.js',
  'test/unit/portability.test.js','test/unit/release.test.js',
  'scripts/setup.js','src/onboarding.js','src/agent/workspace.js','src/cleanup/discover.js',
  'test/unit/onboarding.test.js','test/unit/agent-workflow.test.js','test/unit/discover.test.js',
  'agent/CONTEXT.md','agent/01_observe/CONTEXT.md','agent/02_investigate/CONTEXT.md',
  'agent/03_decide/CONTEXT.md','agent/plan-template.md','docs/AGENT-WORKFLOW.md',
];

export function exportSource({source=root,destination} = {}) {
  if (!destination || fs.lstatSync(destination,{throwIfNoEntry:false})) throw new Error('Release destination is missing or already exists.');
  const selected = RELEASE_FILES.map(file => {
    const src = path.join(source,file);
    if (!fs.lstatSync(src).isFile()) throw new Error(`Release input is not a regular file: ${file}`);
    const text = fs.readFileSync(src,'utf8');
    if (/\/Users\/(?!example\/)[^/\s]+/.test(text) || /\/(?:private\/)?var\/folders\/(?!example\/)[^/\s]+\/[^/\s]+/.test(text)) {
      throw new Error(`Personal filesystem path in release input: ${file}`);
    }
    return {file,src};
  });
  for (const {file,src} of selected) {
    const target = path.join(destination,file);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.copyFileSync(src,target);
    fs.chmodSync(target,fs.statSync(src).mode & 0o777);
  }
  fs.copyFileSync(path.join(destination,'docs/PUBLIC-CONTEXT.md'),path.join(destination,'CONTEXT.md'));
  fs.symlinkSync('CONTEXT.md',path.join(destination,'AGENTS.md'));
  fs.symlinkSync('CONTEXT.md',path.join(destination,'CLAUDE.md'));
  for (const dir of ['agent','agent/01_observe','agent/02_investigate','agent/03_decide']) {
    for (const alias of ['AGENTS.md','CLAUDE.md']) fs.symlinkSync('CONTEXT.md',path.join(destination,dir,alias));
  }
  return destination;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const version = JSON.parse(fs.readFileSync(path.join(root,'package.json'),'utf8')).version;
    if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Expected a numeric release version.');
    const releases = path.join(root,'releases');
    fs.mkdirSync(releases,{recursive:true});
    const stage = fs.mkdtempSync(path.join(releases,'.stage-'));
    const destination = exportSource({destination:path.join(stage,`diskwatch-${version}`)});
    const archive = path.join(releases,`diskwatch-${version}-${Date.now()}.zip`);
    const result = spawnSync('ditto',['-c','-k','--keepParent','--norsrc',destination,archive],{encoding:'utf8'});
    if (result.status !== 0) throw new Error(`Archive failed: ${result.stderr}`);
    const sha256 = createHash('sha256').update(fs.readFileSync(archive)).digest('hex');
    fs.writeFileSync(archive+'.sha256',`${sha256}  ${path.basename(archive)}\n`,{flag:'wx'});
    console.log(JSON.stringify({version,source:destination,archive,sha256},null,2));
  } catch (err) { console.error(err.message); process.exitCode = 1; }
}
