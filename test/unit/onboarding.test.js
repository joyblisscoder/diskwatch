import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '../..');
const temporary = () => fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-onboard-'));
function cli(args, home) {
  return spawnSync(process.execPath, ['bin/diskwatch', ...args], {
    cwd: root, encoding: 'utf8', timeout: 10000,
    env: {...process.env, HOME:home, DISKWATCH_STATE_DIR:path.join(home, 'state')},
  });
}

test('piped onboarding refuses to assume consent and leaves settings absent', () => {
  const home = temporary();
  const result = cli(['setup'], home);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /interactive terminal|--defaults/);
  assert.equal(fs.existsSync(path.join(home, 'state/config.json')), false);
});

test('explicit defaults produce a private, read-only policy and narrow watchlist', () => {
  const home = temporary();
  const result = cli(['setup', '--defaults'], home);
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(home, 'state/config.json');
  const cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(cfg.cleanup.mode, 'suggest');
  assert.equal(cfg.cleanup.require_approval, true);
  assert.equal(cfg.notifications.channel, 'none');
  assert.ok(!cfg.watchlist.some(x => /Documents|Pictures|Application Support|\.codex/.test(x.path)));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.match(result.stdout, /scope|Scope/);
});

test('rerunning defaults preserves existing preferences rather than expanding authority', () => {
  const home = temporary();
  fs.mkdirSync(path.join(home, 'state'));
  const cfg = {notifications:{channel:'none'}, watchlist:[], cleanup:{mode:'monitor',roots:[],exclude:[],min_age_days:90,min_size_mb:50,require_approval:true}};
  fs.writeFileSync(path.join(home, 'state/config.json'), JSON.stringify(cfg));
  const result = cli(['setup', '--defaults'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'state/config.json'))).cleanup.mode, 'monitor');
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, 'state/config.json'))).watchlist, []);
});

test('wizard cancellation does not write, and choices persist without altering unrelated settings', async () => {
  const { configure } = await import('../../src/onboarding.js');
  const home = temporary();
  const existing = {notifications:{channel:'none'},watchlist:[],custom:'kept'};
  const answers = ['2','3','','45','25','35','n','n'];
  const output = [];
  const result = await configure({existing,home,ask:async()=>answers.shift(),write:x=>output.push(x)});
  assert.equal(result, null);
  assert.equal(existing.custom,'kept');
  assert.ok(output.join('\n').includes('approval'));
  const yes = ['2','3','','45','25','35','n','y'];
  const config = await configure({existing,home,ask:async()=>yes.shift(),write:()=>{}});
  assert.equal(config.cleanup.mode,'agent');
  assert.equal(config.cleanup.min_age_days,45);
  assert.equal(config.cleanup.min_size_mb,25);
  assert.equal(config.thresholds.free_warn_gb,35);
  assert.equal(config.custom,'kept');
  assert.equal(config.cleanup.require_approval,true);
});

test('setup refuses a symlinked config without modifying the target', () => {
  const home = temporary();
  const victim = path.join(home,'private.json');
  fs.writeFileSync(victim,'{"watchlist":[]}');
  fs.mkdirSync(path.join(home,'state'));
  fs.symlinkSync(victim,path.join(home,'state/config.json'));
  const result = cli(['setup','--defaults'],home);
  assert.notEqual(result.status,0);
  assert.equal(fs.readFileSync(victim,'utf8'),'{"watchlist":[]}');
});

test('keeping the watchlist preserves a narrower discovery scope and exclusions',async()=>{
  const {configure}=await import('../../src/onboarding.js');
  const existing={watchlist:[{path:'~/Downloads'},{path:'~/Developer'}],cleanup:{mode:'agent',roots:['~/Downloads'],exclude:['~/Downloads/private'],min_age_days:90,min_size_mb:25,require_approval:true}};
  const answers=['3','','','','','','n','y'];
  const config=await configure({existing,ask:async()=>answers.shift(),write:()=>{}});
  assert.deepEqual(config.cleanup.roots,['~/Downloads']);
  assert.deepEqual(config.cleanup.exclude,['~/Downloads/private']);
  assert.equal(config.cleanup.mode,'agent');
  assert.equal(config.cleanup.min_age_days,90);
});
