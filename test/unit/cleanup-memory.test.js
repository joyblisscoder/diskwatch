import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { rememberDecision, applyDecisions, decisionList, recordOutcome, listOutcomes, savePlan, getPlan } from '../../src/cleanup/memory.js';

const temporary = () => fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'diskwatch-memory-'));
const now = Date.UTC(2026, 9, 11);
const candidate = { path: '/synthetic/Café/node_modules', fingerprint: 'sha256-original', bytes: 1000, eligible_for_deletion: false, requires_approval: true };
const result = { candidates: [candidate], partial: true, coverage: { complete: false } };

test('keep persists across a new process and preserves read-only discovery evidence', () => {
  const state = temporary();
  rememberDecision({ state, candidate, decision: 'keep', now });
  const moduleUrl = pathToFileURL(path.resolve('src/cleanup/memory.js')).href;
  const script = `import {applyDecisions} from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(applyDecisions(${JSON.stringify({ state, result, now: now + 86400000 })})));`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  const filtered = JSON.parse(child.stdout);
  assert.deepEqual(filtered.candidates, []);
  assert.equal(filtered.suppressed[0].previous_decision.decision, 'keep');
  assert.equal(filtered.suppressed[0].eligible_for_deletion, false);
  assert.deepEqual(filtered.coverage, result.coverage);
  assert.equal(filtered.partial, true);
  assert.equal(result.candidates.length, 1);
  assert.equal(decisionList({ state, now })[0].status, 'active');
  assert.equal(fs.statSync(state).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(state, 'cleanup.db')).mode & 0o777, 0o600);
});

test('matching paths use NFC and casefold while changed fingerprints resurface', () => {
  const state = temporary();
  rememberDecision({ state, candidate, decision: 'keep', now });
  const same = { ...candidate, path: '/SYNTHETIC/Cafe\u0301/NODE_MODULES' };
  assert.equal(applyDecisions({ state, result: { candidates: [same] }, now }).suppressed.length, 1);
  const changed = { ...same, fingerprint: 'sha256-changed' };
  const found = applyDecisions({ state, result: { candidates: [changed] }, now });
  assert.equal(found.candidates.length, 1);
  assert.equal(found.candidates[0].previous_decision.reason, 'fingerprint_changed');
  assert.equal(found.candidates[0].eligible_for_deletion, false);
});

test('snooze expires exactly at its deadline and clear removes the path rule', () => {
  const state = temporary();
  rememberDecision({ state, candidate, decision: 'snooze', days: 2, now });
  assert.equal(applyDecisions({ state, result, now: now + 2 * 86400000 - 1 }).suppressed.length, 1);
  const expired = applyDecisions({ state, result, now: now + 2 * 86400000 });
  assert.equal(expired.candidates.length, 1);
  assert.equal(expired.candidates[0].previous_decision.reason, 'snooze_expired');
  assert.equal(decisionList({ state, now: now + 2 * 86400000 })[0].status, 'expired');
  rememberDecision({ state, candidate: { path: candidate.path }, decision: 'clear', now });
  assert.equal(decisionList({ state, now }).length, 0);
  assert.deepEqual(applyDecisions({ state, result, now }).candidates, result.candidates);
});

test('paths containing SQL punctuation remain data and invalid decisions grant no approval', () => {
  const state = temporary();
  const quoted = { ...candidate, path: "/synthetic/'); DROP TABLE decisions; --" };
  rememberDecision({ state, candidate: quoted, decision: 'keep', now });
  assert.equal(decisionList({ state, now })[0].path, quoted.path);
  assert.throws(() => rememberDecision({ state, candidate, decision: 'approve', now }), /decision/i);
  assert.throws(() => rememberDecision({ state, candidate, decision: 'snooze', days: -1, now }), /days/i);
  assert.throws(() => rememberDecision({ state, candidate: { ...candidate, path: '/synthetic/\nunsafe' }, decision: 'keep', now }), /path/i);
  assert.throws(() => rememberDecision({ state, candidate: { ...candidate, fingerprint: '' }, decision: 'keep', now }), /fingerprint/i);
});

test('outcomes preserve measurement and verification without attributing freed bytes', () => {
  const state = temporary();
  const outcome = { action_id: 'action_0123', path: candidate.path, method: 'native_trash', status: 'moved_to_trash', before_free_bytes: 1000, after_free_bytes: 900, measured_delta_bytes: -100, observed_at: new Date(now).toISOString(), verification: { source_absent: true, volume_changed: false } };
  recordOutcome({ state, ...outcome });
  assert.deepEqual(listOutcomes({ state }), [outcome]);
  assert.throws(() => recordOutcome({ state, ...outcome, status: 'failed' }), /already|duplicate|unique/i);
  assert.deepEqual(listOutcomes({ state }), [outcome]);
  assert.throws(() => recordOutcome({ state, ...outcome, action_id: 'unsafe\ncommand' }), /action_id/i);
  assert.throws(() => recordOutcome({ state, ...outcome, action_id: 'other', measured_delta_bytes: 100 }), /delta/i);
  assert.throws(() => listOutcomes({ state, limit: 100000 }), /limit/i);
});

test('external observations record absence without claiming execution or attributing space', () => {
  const state = temporary();
  const outcome = { action_id: 'observation_123', path: candidate.path, method: 'external_observation', status: 'path_absent', verified: true, before_free_bytes: null, after_free_bytes: 2000, measured_delta_bytes: null, observed_at: new Date(now).toISOString(), verification: { source_absent: true, volume_changed: false } };
  recordOutcome({ state, ...outcome });
  assert.deepEqual(listOutcomes({ state }), [outcome]);
  assert.throws(() => recordOutcome({ state, ...outcome, action_id: 'invalid', verification: { source_absent: false, volume_changed: false } }), /verified/i);
});

test('missing memory stays read-only and does not create state', () => {
  const state = path.join(temporary(), 'absent');
  assert.deepEqual(applyDecisions({ state, result, now }).candidates, result.candidates);
  assert.deepEqual(decisionList({ state, now }), []);
  assert.deepEqual(listOutcomes({ state }), []);
  assert.equal(getPlan({ state, id: 'missing' }), null);
  assert.equal(fs.existsSync(state), false);
});

test('plans persist unchanged and cannot be overwritten or store unbounded payloads', () => {
  const state = temporary();
  const plan = { id: 'plan_123', created_at: new Date(now).toISOString(), items: [candidate], before_free_bytes: 2000, policy_fingerprint: 'policy-abc' };
  savePlan({ state, plan });
  assert.deepEqual(getPlan({ state, id: plan.id }), plan);
  assert.throws(() => savePlan({ state, plan: { ...plan, items: [] } }), /already|duplicate|unique/i);
  assert.deepEqual(getPlan({ state, id: plan.id }), plan);
  assert.throws(() => savePlan({ state, plan: { ...plan, id: 'oversized', evidence: 'x'.repeat(1024 * 1024) } }), /large|size|MiB/i);
  assert.throws(() => getPlan({ state, id: 'unsafe\ncommand' }), /id/i);
});

test('plans reject non-JSON data, cycles, and excessive nesting before creating state', () => {
  const state = path.join(temporary(), 'absent');
  const plan = { id: 'plan_123', created_at: new Date(now).toISOString(), items: [], before_free_bytes: 2000, policy_fingerprint: 'policy-abc' };
  assert.throws(() => savePlan({ state, plan: { ...plan, evidence: () => 'hidden' } }), /JSON/i);
  const cycle = {}; cycle.self = cycle;
  assert.throws(() => savePlan({ state, plan: { ...plan, evidence: cycle } }), /JSON/i);
  let nested = {};
  for (let index = 0; index < 70; index++) nested = { child: nested };
  assert.throws(() => savePlan({ state, plan: { ...plan, evidence: nested } }), /nest|depth/i);
  assert.equal(fs.existsSync(state), false);
});

test('symlinked state and database files are rejected without touching their targets', () => {
  const parent = temporary();
  const real = path.join(parent, 'real');
  fs.mkdirSync(real);
  const linked = path.join(parent, 'linked');
  fs.symlinkSync(real, linked);
  assert.throws(() => rememberDecision({ state: linked, candidate, decision: 'keep', now }), /unsafe|symlink/i);
  assert.deepEqual(fs.readdirSync(real), []);
  const target = path.join(parent, 'target');
  fs.writeFileSync(target, 'do not touch');
  const state = temporary();
  fs.symlinkSync(target, path.join(state, 'cleanup.db'));
  assert.throws(() => rememberDecision({ state, candidate, decision: 'keep', now }), /unsafe|symlink/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch');
});

test('symlinked state ancestors are rejected without creating files in the target', () => {
  const parent = temporary();
  const real = path.join(parent, 'real');
  fs.mkdirSync(real);
  const linked = path.join(parent, 'linked');
  fs.symlinkSync(real, linked);
  assert.throws(() => rememberDecision({ state: path.join(linked, 'state'), candidate, decision: 'keep', now }), /unsafe|symlink/i);
  assert.deepEqual(fs.readdirSync(real), []);
});

test('symlinked SQLite sidecars and hard-linked database files are rejected', () => {
  for (const sidecar of ['cleanup.db-wal', 'cleanup.db-shm']) {
    const state = temporary();
    const target = path.join(temporary(), 'target');
    fs.writeFileSync(target, 'do not touch');
    fs.symlinkSync(target, path.join(state, sidecar));
    assert.throws(() => rememberDecision({ state, candidate, decision: 'keep', now }), /unsafe|symlink/i);
    assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch');
  }
  const state = temporary();
  const target = path.join(temporary(), 'target');
  fs.writeFileSync(target, 'do not touch');
  fs.linkSync(target, path.join(state, 'cleanup.db'));
  assert.throws(() => rememberDecision({ state, candidate, decision: 'keep', now }), /unsafe/i);
  assert.equal(fs.readFileSync(target, 'utf8'), 'do not touch');
});
