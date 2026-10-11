import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {
  fmtKb,
  fmtGb,
  freeColor,
  expandHome,
  collapseHome,
} from '../../src/util/fmt.js';

describe('fmt', () => {
  it('fmtKb and fmtGb format sizes', () => {
    assert.equal(fmtGb(42.16), '42.2 GB');
    assert.match(fmtKb(1024 * 1024), /GB/);
    assert.match(fmtKb(2048), /MB/);
    assert.match(fmtKb(10), /KB/);
  });

  it('freeColor thresholds', () => {
    assert.equal(freeColor(80), 'green');
    assert.equal(freeColor(100), 'green');
    assert.equal(freeColor(40), 'amber');
    assert.equal(freeColor(79.9), 'amber');
    assert.equal(freeColor(39.9), 'red');
    assert.equal(freeColor(0), 'red');
  });

  it('expandHome and collapseHome round-trip home paths', () => {
    const home = os.homedir();
    assert.equal(expandHome('~'), home);
    assert.equal(expandHome('~/Developer/x'), path.join(home, 'Developer/x'));
    assert.equal(expandHome('/tmp/abs'), '/tmp/abs');
    assert.equal(collapseHome(home), '~');
    assert.equal(collapseHome(path.join(home, 'Developer/x')), '~/Developer/x');
    assert.equal(collapseHome('/tmp/abs'), '/tmp/abs');
  });
});
