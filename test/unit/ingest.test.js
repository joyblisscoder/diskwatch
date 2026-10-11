import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseDiskguardLine, DISKGUARD_SOURCE } from '../../src/ingest/diskguard-log.js';
import { parseJanitorBlocks } from '../../src/ingest/janitor-log.js';
import { nowSec } from '../../src/util/time.js';
import { openTempDb } from '../helpers.js';

describe('ingest parsers', () => {
  it('parses reaped worktree line', () => {
    const line =
      '2026-08-28 20:24:27 reaped /Users/example/Developer/example-app/.worktrees/feature (merged+clean, idle 4d)';
    const p = parseDiskguardLine(line);
    assert.equal(p.type, 'action');
    assert.equal(p.action.rule_key, 'worktree.reap');
    assert.equal(p.action.mode, 'external');
    assert.equal(p.action.outcome, 'success');
    assert.equal(
      p.action.target_path,
      '/Users/example/Developer/example-app/.worktrees/feature',
    );
    assert.equal(p.action.detail, 'merged+clean, idle 4d');
    assert.ok(typeof p.action.started_at === 'number');
  });

  it('parses PRUNED codesign clone line', () => {
    const line =
      'PRUNED /private/var/folders/example/test-user/X/ai.perplexity.comet.code_sign_clone/code_sign_clone.example (1433796 KiB logical)';
    const p = parseDiskguardLine(line, { fileMtimeSec: 1756638000 });
    assert.equal(p.type, 'action');
    assert.equal(p.action.rule_key, 'codesign.clones');
    assert.equal(p.action.freed_kb, 1433796);
    assert.match(p.action.target_path, /code_sign_clone/);
  });

  it('parses disk alert delivery failed as event', () => {
    const line = '2026-08-31 12:01:28 disk alert delivery failed';
    const p = parseDiskguardLine(line);
    assert.equal(p.type, 'event');
    assert.equal(p.event.kind, 'external_alert_lost');
    assert.equal(p.event.severity, 'critical');
    assert.match(p.event.headline, /delivery failed/);
  });

  it('ignores SKIP lines', () => {
    const line = '2026-08-31 12:00:00 SKIP worktree /tmp/foo (dirty)';
    const p = parseDiskguardLine(line);
    assert.equal(p.type, 'ignored');
  });

  it('blank line is blank', () => {
    assert.equal(parseDiskguardLine('').type, 'blank');
    assert.equal(parseDiskguardLine('   ').type, 'blank');
  });

  it('unparsed line returns type unparsed', () => {
    const raw = 'THIS IS NOT A REAL LINE xyz';
    const p = parseDiskguardLine(raw);
    assert.equal(p.type, 'unparsed');
    assert.equal(p.raw, raw);
  });

  it('stores unparsed into ingest_unparsed on a temp db', () => {
    const { db } = openTempDb();
    try {
      const raw = 'THIS IS NOT A REAL LINE xyz';
      const parsed = parseDiskguardLine(raw);
      assert.equal(parsed.type, 'unparsed');
      db.prepare(
        `INSERT INTO ingest_unparsed (source, line_no, raw, first_seen)
         VALUES (?, ?, ?, ?)`,
      ).run(DISKGUARD_SOURCE, 1, parsed.raw, nowSec());
      const row = db
        .prepare(`SELECT source, line_no, raw FROM ingest_unparsed WHERE line_no = 1`)
        .get();
      assert.equal(row.source, DISKGUARD_SOURCE);
      assert.equal(row.raw, raw);
    } finally {
      db.close();
    }
  });

  it('parses janitor run block with freed ~79MB', () => {
    const text = [
      '=== disk-janitor run 2026-08-16 11:30 ===',
      'trimming sessions older than 7d',
      'freed ~79MB',
      '',
    ].join('\n');
    const blocks = parseJanitorBlocks(text);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].freed_kb, 79 * 1024);
    assert.ok(typeof blocks[0].started_at === 'number');
    assert.match(blocks[0].header, /disk-janitor run 2026-08-16 11:30/);
  });
});
