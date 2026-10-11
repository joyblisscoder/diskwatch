import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { developerInventory } from '../../src/cleanup/inventory.js';

function fixture(t) {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-inventory-')));
  t.after(() => {
    const result = spawnSync('/usr/bin/trash', [home], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, 'task-owned fixture cleanup succeeded');
  });
  const root = path.join(home, 'Developer');
  fs.mkdirSync(root);
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' });
  const git = (cwd, ...args) => {
    const r = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd, env, encoding: 'utf8', timeout: 2000 });
    assert.equal(r.status, 0, 'fixture Git command succeeded');
    return r.stdout;
  };
  const repo = (name) => {
    const target = path.join(root, name);
    fs.mkdirSync(target, { recursive: true });
    git(target, '-c', 'init.templateDir=', 'init', '--initial-branch=main');
    git(target, 'commit', '--allow-empty', '-m', 'Synthetic fixture');
    return target;
  };
  return { home, root, git, repo, options: { roots: [root], home } };
}

test('inventory does not enter other version-control history directories',async t=>{
  const f=fixture(t);
  for(const name of ['.hg','.svn','.bzr','_darcs','CVS','RCS','.fossil-settings']) f.repo(`${name}/history`);
  const result=await developerInventory(f.options);
  assert.equal(result.projects.length,0);
  assert.equal(result.worktrees.length,0);
  assert.equal(result.coverage.git_commands,0);
});

test('native inventory discovers repositories and locked linked worktrees without removal authority', async t => {
  const f = fixture(t);
  const repo = f.repo('app');
  const linked = path.join(f.root, 'linked\nworkspace');
  f.git(repo, 'worktree', 'add', '-b', 'fixture-linked', linked);
  f.git(repo, 'worktree', 'lock', '--reason', 'Keep this checkout', linked);
  const result = await developerInventory(f.options);
  assert.equal(result.projects.length, 2);
  assert.equal(result.projects.find(p => p.path === linked).git_kind, 'worktree_file');
  assert.equal(result.worktrees.length, 2, 'same shared worktrees are deduplicated');
  const item = result.worktrees.find(w => w.path === linked);
  assert.equal(item.branch, 'refs/heads/fixture-linked');
  assert.equal(item.locked, true);
  assert.equal(item.locked_reason, 'Keep this checkout');
  assert.equal(item.eligible_for_deletion, false);
  assert.equal(item.requires_approval, true);
  assert.ok(item.blockers.includes('active_use_not_checked'));
  assert.equal(result.coverage.complete, true);
});

test('outside worktree paths stay private and are never scanned', async t => {
  const f = fixture(t);
  const repo = f.repo('app');
  const outside = path.join(f.home, 'private-outside');
  f.git(repo, 'worktree', 'add', '-b', 'outside', outside);
  const result = await developerInventory(f.options);
  assert.deepEqual(result.worktrees.map(w => w.path), [repo]);
  assert.equal(result.coverage.blockedOutsideScope, 1);
  assert.equal(JSON.stringify(result).includes(outside), false);
});

test('missing registered worktrees retain prunable evidence without recommending removal', async t => {
  const f = fixture(t);
  const repo = f.repo('app');
  const linked = path.join(f.root, 'missing');
  f.git(repo, 'worktree', 'add', '-b', 'missing', linked);
  assert.equal(spawnSync('/usr/bin/trash', [linked]).status, 0);
  const result = await developerInventory(f.options);
  const item = result.worktrees.find(w => w.path === linked);
  assert.equal(item.exists, false);
  assert.equal(item.prunable, true);
  assert.equal(item.eligible_for_deletion, false);
  assert.ok(item.prunable_reason);
});

test('exclusions use normalized case and protected application roots stay uninspected', async t => {
  const f = fixture(t);
  f.repo('Café');
  const hidden = f.repo('.codex/project');
  const app = f.repo('Library/Application Support/app');
  const result = await developerInventory({ ...f.options, exclude: [path.join(f.root, 'CAFE\u0301')] });
  assert.deepEqual(result.projects, []);
  assert.deepEqual(result.worktrees, []);
  assert.equal(JSON.stringify(result).includes(hidden), false);
  assert.equal(JSON.stringify(result).includes(app), false);
});

test('root aliases and symlink markers cannot widen inventory scope', async t => {
  const f = fixture(t);
  const repo = f.repo('real');
  const alias = path.join(f.home, 'alias');
  fs.symlinkSync(f.root, alias);
  const linked = path.join(f.root, 'marker-link');
  fs.mkdirSync(linked);
  fs.symlinkSync(path.join(repo, '.git'), path.join(linked, '.git'));
  const result = await developerInventory({ ...f.options, roots: [alias, f.root] });
  assert.deepEqual(result.projects.map(p => p.path), [repo]);
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.skipped.some(s => s.reason === 'symlink'));
});

test('project and directory budgets report incomplete inventory instead of crawling generated trees', async t => {
  const f = fixture(t);
  f.repo('a'); f.repo('b');
  f.repo('node_modules/not-a-project');
  const result = await developerInventory({ ...f.options, maxProjects: 1 });
  assert.equal(result.projects.length, 1);
  assert.equal(result.projects[0].path, path.join(f.root, 'a'));
  assert.equal(result.coverage.complete, false);
  assert.ok(result.coverage.skipped.some(s => s.reason === 'project_limit'));
  const shallow = await developerInventory({ ...f.options, maxDepth: 0 });
  assert.equal(shallow.projects.length, 0);
  assert.equal(shallow.coverage.complete, false);
});

test('malformed git markers return bounded errors without printing tool stderr', async t => {
  const f = fixture(t);
  const target = path.join(f.root, 'broken');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, '.git'), 'invalid private marker contents');
  const result = await developerInventory(f.options);
  assert.equal(result.projects.length, 1);
  assert.equal(result.worktrees.length, 0);
  assert.ok(result.errors.some(e => e.code === 'git_failed'));
  assert.equal(JSON.stringify(result).includes('invalid private marker contents'), false);
  assert.equal(result.coverage.complete, false);
});

test('inherited git overrides cannot redirect the command to a different repository', async t => {
  const f = fixture(t);
  const repo = f.repo('expected');
  const elsewhere = f.repo('excluded');
  f.git(elsewhere, 'branch', '-m', 'wrong-branch');
  const previous = process.env.GIT_DIR;
  process.env.GIT_DIR = path.join(elsewhere, '.git');
  t.after(() => { if (previous === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous; });
  const result = await developerInventory({ ...f.options, exclude: [elsewhere] });
  assert.equal(result.worktrees[0].path, repo);
  assert.equal(result.worktrees[0].branch, 'refs/heads/main');
});

test('inventory requires explicit bounded absolute scope', async () => {
  for (const options of [{}, { roots: ['relative'] }, { roots: ['/'], maxProjects: -1 }, { roots: ['/'], maxDepth: 100 }]) {
    await assert.rejects(developerInventory(options));
  }
});
