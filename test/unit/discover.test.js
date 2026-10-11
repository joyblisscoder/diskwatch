import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const modulePath = '../../src/cleanup/discover.js';
const now = Date.UTC(2026, 8, 1);
const old = new Date(now - 90 * 86400000);
function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-discover-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, 'work');
  fs.mkdirSync(root);
  function file(name, size = 200, date = old) {
    const target = path.join(root, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.alloc(size));
    fs.utimesSync(target, date, date);
    return target;
  }
  function age(dir) { fs.utimesSync(path.join(root, dir), old, old); }
  const options = { roots: [root], home, now, minBytes: 100 };
  return { home, root, file, age, options };
}

test('complete old build aggregate uses newest descendant and never grants deletion', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('dist/a', 150); f.file('dist/nested/b', 200);
  f.age('dist/nested'); f.age('dist');
  const result = await discoverCandidates(f.options);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].bytes, 350);
  assert.equal(result.candidates[0].kind, 'build_output');
  assert.equal(result.candidates[0].requires_approval, true);
  assert.equal(result.candidates[0].eligible_for_deletion, false);
});

test('old directory with fresh descendant is not a stale aggregate', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('dist/old'); f.file('dist/fresh', 200, new Date(now)); f.age('dist');
  assert.deepEqual((await discoverCandidates(f.options)).candidates, []);
});

test('symlink root, ancestor and descendant never expose outside files', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('outside/secret'); f.age('outside');
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.home, 'link'));
  for (const root of [path.join(f.home, 'link'), path.join(f.home, 'link', 'secret')]) {
    const result = await discoverCandidates({ ...f.options, roots: [root] });
    assert.equal(result.candidates.length, 0);
    assert.equal(result.partial, true);
  }
  fs.mkdirSync(path.join(f.root, 'dist'));
  fs.symlinkSync(path.join(f.root, 'outside'), path.join(f.root, 'dist', 'escape'));
  f.age('dist');
  assert.equal((await discoverCandidates({ ...f.options, roots: [path.join(f.root, 'dist')] })).candidates.length, 0);
});

test('entry, depth and time limits never describe incomplete aggregate as stale', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('dist/nested/a'); f.age('dist/nested'); f.age('dist');
  for (const limits of [{ maxEntries: 1 }, { maxDepth: 1 }, { maxMs: 0 }]) {
    const result = await discoverCandidates({ ...f.options, ...limits });
    assert.equal(result.partial, true);
    assert.deepEqual(result.candidates, []);
  }
});

test('protected and excluded descendants cannot be packaged into candidates', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('dist/.env'); f.file('dist/large'); f.age('dist');
  f.file('Documents/important'); f.file('.codex/state');
  const result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates, []);
  const excluded = fixture(t);
  excluded.file('dist/a'); excluded.age('dist');
  assert.deepEqual((await discoverCandidates({ ...excluded.options, exclude: [path.join(excluded.root, 'dist', 'a')] })).candidates, []);
});

test('overlapping roots and nested build outputs do not double count; names remain inert', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('dist/build/a', 200); f.age('dist/build'); f.age('dist');
  const strange = f.file('$(touch PWNED); newline\nfile', 300);
  const result = await discoverCandidates({ ...f.options, roots: [f.root, path.join(f.root, 'dist'), f.root] });
  assert.equal(result.candidates.length, 2);
  assert.equal(result.candidates.reduce((sum, candidate) => sum + candidate.bytes, 0), 500);
  assert.equal(result.candidates.find(c => c.path === strange).kind, 'manual_review');
  assert.equal(fs.existsSync(path.join(f.root, 'PWNED')), false);
});

test('requires explicit absolute roots and finite bounded options', async () => {
  const { discoverCandidates } = await import(modulePath);
  for (const options of [{ roots: [] }, { roots: ['relative'] }, { roots: ['/'], maxEntries: Infinity }]) {
    await assert.rejects(() => discoverCandidates(options));
  }
});

test('credential files and agent memory stay protected even inside generated folders', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('dist/.npmrc'); f.age('dist');
  f.file('.openclaw/memory.bin');
  assert.deepEqual((await discoverCandidates(f.options)).candidates, []);
});

test('hard links are not offered as independent reclaimable bytes', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  const file = f.file('original.bin');
  fs.linkSync(file, path.join(f.root, 'copy.bin'));
  const result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates, []);
  assert.equal(result.partial, true);
});

test('approved home Library caches are inspectable but documents and application state remain protected', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  const caches = path.join(f.home, 'Library', 'Caches');
  const app = path.join(caches, 'example-app');
  fs.mkdirSync(app, { recursive: true });
  const cacheFile = path.join(app, 'artifact');
  fs.writeFileSync(cacheFile, Buffer.alloc(300));
  fs.utimesSync(cacheFile, old, old); fs.utimesSync(app, old, old);
  const oldCaches = await discoverCandidates({ ...f.options, roots: [caches] });
  assert.equal(oldCaches.candidates.length, 1);
  assert.equal(oldCaches.candidates[0].kind, 'cache');
  assert.equal(oldCaches.candidates[0].path, app);
  fs.utimesSync(cacheFile, new Date(now), new Date(now));
  assert.deepEqual((await discoverCandidates({ ...f.options, roots: [caches] })).candidates, []);
  f.file('documents/keep.bin'); f.file('Library/Application Support/keep.bin'); f.file('source/main.js');
  const download = f.file('Downloads/old.zip');
  const result = await discoverCandidates(f.options);
  assert.deepEqual(result.candidates.map(c => c.path), [download]);
  assert.equal(result.candidates[0].kind, 'manual_review');
});

test('explicit npm cache root remains approval required', async t => {
  const { discoverCandidates } = await import(modulePath);
  const f = fixture(t);
  f.file('.npm/content', 300); f.age('.npm');
  const result = await discoverCandidates({ ...f.options, roots: [path.join(f.root, '.npm')] });
  assert.equal(result.candidates[0].kind, 'cache');
  assert.equal(result.candidates[0].requires_approval, true);
});
