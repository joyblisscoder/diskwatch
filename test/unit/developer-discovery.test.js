import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverCandidates } from '../../src/cleanup/discover.js';

const now = Date.UTC(2026, 8, 1);
const old = new Date(now - 90 * 86400000);
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-developer-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const write = (name, size = 200, date = old) => {
    const target = path.join(home, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(size));
    fs.utimesSync(target, date, date);
    return target;
  };
  const age = () => {
    function visit(dir) {
      for (const name of fs.readdirSync(dir)) {
        const child = path.join(dir, name);
        if (fs.lstatSync(child).isDirectory()) visit(child);
      }
      fs.utimesSync(dir, old, old);
    }
    visit(home);
  };
  return { home, write, age, options: { roots: [home], home, now, minBytes: 100 } };
}

test('normal dependency executable links are metadata, never traversed', async t => {
  const f = fixture(t);
  f.write('repo/package.json', 2);
  f.write('repo/node_modules/pkg/bin.js', 300);
  const outside = f.write('outside.bin', 900);
  fs.mkdirSync(path.join(f.home, 'repo/node_modules/.bin'));
  const link = path.join(f.home, 'repo/node_modules/.bin/pkg');
  fs.symlinkSync(outside, link);
  fs.lutimesSync(link, old, old); f.age();
  const result = await discoverCandidates(f.options);
  const candidate = result.candidates.find(c => c.kind === 'dependencies');
  assert.ok(candidate);
  assert.equal(candidate.bytes, 300 + fs.lstatSync(link).size);
  assert.equal(candidate.evidence.symlink_metadata_entries, 1);
  assert.equal(candidate.evidence.traversal_complete, true);
  assert.ok(candidate.blockers.includes('symlink_targets_not_inspected'));
});

test('version-control history is protected under approved roots and as an explicit root', async t => {
  const f=fixture(t);
  const names=['.hg','.svn','.bzr','_darcs','CVS','RCS','.fossil-settings'];
  for(const name of names) f.write(`repo/${name}/history.bin`,400);
  for(const name of ['.fslckout','_FOSSIL_','project.fossil','project.fossil-wal','_FOSSIL_-journal','.fslckout-shm']) f.write(`repo/${name}`,400);
  f.age();
  assert.equal((await discoverCandidates(f.options)).candidates.length,0);
  for(const name of names) {
    const result=await discoverCandidates({...f.options,roots:[path.join(f.home,'repo',name)]});
    assert.equal(result.candidates.length,0);
    assert.ok(result.coverage.skipped.some(x=>x.reason === 'protected_path'));
  }
});

test('each explicit root gets an independent budget and incomplete bytes are labelled', async t => {
  const f = fixture(t);
  for (let i = 0; i < 20; i++) f.write(`a/node_modules/${i}`, 200);
  f.write('b/dist/a', 400); f.age();
  const result = await discoverCandidates({ ...f.options, roots: [path.join(f.home, 'a'), path.join(f.home, 'b')], maxEntries: 6 });
  assert.ok(result.candidates.some(c => c.path === path.join(f.home, 'b/dist')));
  const partial = result.candidates.find(c => c.path === path.join(f.home, 'a/node_modules'));
  assert.ok(partial);
  assert.equal(partial.evidence.traversal_complete, false);
  assert.equal(partial.evidence.bytes_lower_bound, true);
  assert.ok(partial.blockers.includes('incomplete_metadata_scan'));
  assert.equal(result.coverage.per_root.length, 2);
  assert.ok(result.coverage.per_root.every(r => r.entries_scanned <= 6));
});

test('bounded generated estimates remain useful when the size threshold is still unknown', async t => {
  const f = fixture(t);
  f.write('repo/node_modules/a', 200); f.write('repo/node_modules/b', 200); f.age();
  const result = await discoverCandidates({ ...f.options, roots: [path.join(f.home, 'repo')], maxEntries: 3, minBytes: 100 * 1024 * 1024 });
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].evidence.bytes_lower_bound, true);
  assert.equal(result.candidates[0].evidence.minimum_size_met, false);
  assert.ok(result.candidates[0].blockers.includes('size_threshold_not_established'));
});

test('largest 100 are selected across every inspected item', async t => {
  const f = fixture(t);
  for (let i = 0; i < 130; i++) f.write(`artifact-${String(i).padStart(3, '0')}.zip`, i + 100);
  const largest = f.write('zz-last.zip', 10000); f.age();
  const result = await discoverCandidates(f.options);
  assert.equal(result.candidates.length, 100);
  assert.equal(result.candidates[0].path, largest);
  assert.equal(result.coverage.complete, true);
});

test('developer generated types are review findings with no deletion inference', async t => {
  const f = fixture(t);
  const names = ['target', '.venv', '__pycache__', '.gradle', '.turbo', '.yarn/cache', 'coverage'];
  for (const name of names) f.write(`repo/${name}/artifact`, 200);
  f.write('repo/pyproject.toml', 2); f.age();
  const result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates.map(c => path.relative(path.join(f.home, 'repo'), c.path)).sort(), names.sort());
  assert.ok(result.candidates.every(c => !c.eligible_for_deletion && c.requires_approval));
});

test('source activity excludes old outputs while git directories and worktree files are metadata only', async t => {
  const f = fixture(t);
  f.write('active/package.json', 2);
  f.write('active/src/app.js', 2, new Date(now));
  f.write('active/dist/artifact', 400);
  f.write('old/.git/HEAD', 10);
  f.write('old/src/main.rs', 2);
  f.write('old/target/artifact', 500);
  f.write('worktree/.git', 20);
  f.write('worktree/dist/artifact', 600); f.age();
  const result = await discoverCandidates(f.options);
  assert.ok(!result.candidates.some(c => c.path.includes('/active/')));
  assert.ok(result.coverage.skipped.some(s => s.reason === 'active_project'));
  assert.equal(result.candidates.find(c => c.path.endsWith('/old/target')).project.git_kind, 'directory');
  assert.equal(result.candidates.find(c => c.path.endsWith('/worktree/dist')).project.git_kind, 'worktree_file');
});

test('fingerprints are stable and change for nested metadata and project source edits', async t => {
  const f = fixture(t);
  f.write('repo/package.json', 2);
  const source = f.write('repo/src/main.js', 2);
  const artifact = f.write('repo/dist/nested/artifact', 400); f.age();
  const get = async () => (await discoverCandidates(f.options)).candidates[0];
  const a = await get();
  assert.match(a.fingerprint, /^[a-f0-9]{64}$/);
  assert.equal((await get()).fingerprint, a.fingerprint);
  fs.chmodSync(artifact, 0o600);
  const b = await get(); assert.notEqual(b.fingerprint, a.fingerprint);
  fs.utimesSync(source, new Date(now - 60 * 86400000), new Date(now - 60 * 86400000));
  assert.notEqual((await get()).fingerprint, b.fingerprint);
});

test('nested package outputs respect activity in their owning Git project', async t => {
  const f = fixture(t);
  const head = f.write('repo/.git/HEAD', 2, new Date(now));
  f.write('repo/packages/child/package.json', 2);
  f.write('repo/packages/child/dist/artifact', 200); f.age();
  let result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates, []);
  assert.ok(result.coverage.skipped.some(s => s.reason === 'active_project'));
  fs.utimesSync(head, old, old);
  f.write('repo/packages/sibling/package.json', 2);
  f.write('repo/packages/sibling/src/main.js', 2, new Date(now)); f.age();
  result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates, []);
});

test('workspace budgets inspect later projects before dependency aggregation', async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    f.write(`repo-${String(i).padStart(2, '0')}/package.json`, 2);
    for (let n = 0; n < 20; n++) f.write(`repo-${String(i).padStart(2, '0')}/node_modules/pkg-${n}`, 200);
  }
  f.age();
  const result = await discoverCandidates({ ...f.options, maxEntries: 250 });
  assert.equal(result.candidates.length, 30);
  assert.ok(result.candidates.every(c => c.evidence.bytes_lower_bound));
});

test('a total time budget is bounded and reported independently of per-root limits', async t => {
  const f = fixture(t);
  f.write('a/dist/artifact', 200); f.write('b/dist/artifact', 200); f.age();
  const result = await discoverCandidates({ ...f.options, roots: [path.join(f.home, 'a'), path.join(f.home, 'b')], maxTotalMs: 0 });
  assert.deepEqual(result.candidates, []);
  assert.equal(result.coverage.limits.max_total_ms, 0);
  assert.equal(result.coverage.per_root.length, 2);
  assert.ok(result.coverage.per_root.every(r => !r.complete));
  await assert.rejects(() => discoverCandidates({ ...f.options, maxTotalMs: Infinity }));
});

test('active-project exclusions retain complete coverage when every tree was inspected', async t => {
  const f = fixture(t);
  f.write('repo/package.json', 2); f.write('repo/main.js', 2, new Date(now)); f.write('repo/dist/artifact', 200); f.age();
  const result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.partial, false);
  assert.equal(result.coverage.complete, true);
  assert.ok(result.coverage.skipped.some(s => s.reason === 'active_project'));
});

test('representative 30-repository workspace accounts for 120000 dependency metadata entries', async t => {
  const f = fixture(t);
  for (let i = 0; i < 30; i++) {
    const repo = `repo-${String(i).padStart(2, '0')}`;
    f.write(`${repo}/package.json`, 2);
    f.write(`${repo}/node_modules/artifact`, 200);
    for (let n = 0; n < 4000; n++) f.write(`${repo}/node_modules/empty-${n}`, 0);
  }
  f.age();
  const started = performance.now();
  // This checks full accounting, not shared-runner I/O speed. Strict time and
  // entry exhaustion have separate tests; preserve all completeness assertions.
  const result = await discoverCandidates({...f.options,maxMs:30000,maxTotalMs:30000});
  const elapsed = Math.round(performance.now() - started);
  t.diagnostic(`120000 empty dependency files, 30 repositories: ${result.coverage.entries_scanned} entries in ${elapsed}ms, ${result.candidates.length} findings`);
  assert.equal(result.candidates.length, 30);
  assert.equal(result.coverage.complete, true);
  assert.ok(result.candidates.every(c => c.evidence.traversal_complete && c.bytes === 200 && c.project.activity_complete));
  assert.ok(result.coverage.entries_scanned >= 120000);
});
