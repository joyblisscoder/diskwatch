import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { classify, kpIdForPath } from '../../src/learn/classify.js';

const HOME = os.homedir();

describe('classify', () => {
  it('maps each taxonomy class from a representative path', () => {
    const cases = [
      { p: path.join(HOME, '.codex/sessions/abc'), class: 'agent_sessions' },
      { p: path.join(HOME, '.claude-mem'), class: 'agent_state' },
      { p: path.join(HOME, '.npm/_cacache'), class: 'regenerable_cache' },
      { p: path.join(HOME, 'Developer/app/node_modules/x'), class: 'regenerable_cache' },
      { p: path.join(HOME, 'Developer/app/.next/cache'), class: 'build_output' },
      { p: path.join(HOME, 'Developer/foo/.worktrees/bar'), class: 'worktree' },
      { p: path.join(HOME, 'Developer/diskwatch'), class: 'source_tree' },
      { p: path.join(HOME, '.ollama/models'), class: 'model_weights' },
      { p: path.join(HOME, 'Library/Containers/com.apple.foo'), class: 'app_container' },
      {
        p: path.join(HOME, 'Library/Application Support/Claude/vm_bundles/x'),
        class: 'app_data',
      },
      { p: '/Library/Updates/000-1234', class: 'os_staged' },
      { p: path.join(HOME, 'Downloads/file.zip'), class: 'user_transient' },
      { p: path.join(HOME, 'Documents/notes.txt'), class: 'user_data' },
    ];

    for (const c of cases) {
      const hit = classify(c.p);
      assert.equal(hit.class, c.class, `${c.p} -> ${c.class}`);
    }
  });

  it('unknown path is class unknown and protected=1', () => {
    const hit = classify('/tmp/diskwatch-totally-unknown-path-xyz');
    assert.equal(hit.class, 'unknown');
    assert.equal(hit.protected, 1);
  });

  it('user_data is always protected', () => {
    for (const p of [
      path.join(HOME, 'Documents'),
      path.join(HOME, 'Pictures/vacation'),
      path.join(HOME, 'Movies/clip.mov'),
    ]) {
      const hit = classify(p);
      assert.equal(hit.class, 'user_data');
      assert.equal(hit.protected, 1);
    }
  });

  it('kpIdForPath maps known patterns', () => {
    assert.equal(kpIdForPath(path.join(HOME, '.codex/sessions')), 'KP-008');
    assert.equal(kpIdForPath(path.join(HOME, '.claude-mem')), 'KP-002');
    assert.equal(kpIdForPath(path.join(HOME, 'Developer/x/.worktrees/y')), 'KP-003');
    assert.equal(kpIdForPath('/Library/Updates'), 'KP-005');
  });
});
