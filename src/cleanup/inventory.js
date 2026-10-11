import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import {VCS_METADATA} from './discover.js';

const GIT = '/usr/bin/git';
const TOTAL_MS = 10000;
const COMMAND_MS = 2000;
const MAX_ENTRIES = 5000;
const MAX_OUTPUT = 1024 * 1024;
const PROTECTED = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.config', '.local', '.codex', '.claude', '.claude-mem', '.grok', '.agents', '.hermes', '.openclaw', '.cursor', '.vscode', '.trash', 'documents', 'desktop', 'pictures', 'photos', 'music', 'movies', 'library']);
for(const name of VCS_METADATA) PROTECTED.add(name);
const GENERATED = new Set(['node_modules', 'target', '.venv', 'venv', '__pycache__', '.gradle', '.turbo', '.yarn', '.next', 'dist', 'build', '.cache', '.npm']);
const fold = value => value.normalize('NFC').toLowerCase();
const within = (target, parent) => fold(target) === fold(parent) || fold(target).startsWith(fold(parent) + path.sep);

function noSymlinkAncestors(target) {
  let current = path.parse(target).root;
  for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return { missing: true };
    if (stat.isSymbolicLink()) return { symlink: true };
  }
  return {};
}

function gitEnvironment() {
  // Inherited GIT_DIR, config injection, tracing and executable overrides must
  // not redirect this metadata command or leak output into an external log.
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GIT_NO_REPLACE_OBJECTS: '1' };
}

function parseWorktrees(output) {
  if (!output.endsWith('\0')) throw new Error('invalid_git_output');
  const records = [];
  let current = null;
  for (const field of output.split('\0')) {
    if (!field) { if (current) records.push(current); current = null; continue; }
    if (field.startsWith('worktree ')) {
      if (current) throw new Error('invalid_git_output');
      current = { path: field.slice(9), branch: null, detached: false, bare: false, locked: false, locked_reason: null, prunable: false, prunable_reason: null };
    } else if (current) {
      if (field.startsWith('branch ')) current.branch = field.slice(7);
      else if (field === 'detached') current.detached = true;
      else if (field === 'bare') current.bare = true;
      else if (field === 'locked' || field.startsWith('locked ')) { current.locked = true; current.locked_reason = field.slice(7) || null; }
      else if (field === 'prunable' || field.startsWith('prunable ')) { current.prunable = true; current.prunable_reason = field.slice(9) || null; }
      // HEAD object IDs and unknown future attributes are not needed here.
    } else throw new Error('invalid_git_output');
  }
  if (!records.length) throw new Error('invalid_git_output');
  return records;
}

/** Read-only scoped Git/worktree metadata. Flags are findings, never removal authority. */
export async function developerInventory({ roots, exclude = [], home = os.homedir(), maxProjects = 30, maxDepth = 3 } = {}) {
  for (const [name, values, limit] of [['roots', roots, 100], ['exclude', exclude, 1000]]) {
    if (!Array.isArray(values) || values.length > limit || (name === 'roots' && !values.length) || values.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error(`${name} must contain explicit absolute paths (maximum ${limit}).`);
  }
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('home must be absolute.');
  if (!Number.isInteger(maxProjects) || maxProjects < 1 || maxProjects > 100) throw new Error('maxProjects must be between 1 and 100.');
  if (!Number.isInteger(maxDepth) || maxDepth < 0 || maxDepth > 12) throw new Error('maxDepth must be between 0 and 12.');
  const approved = [...new Set(roots.map(p => path.resolve(p)))].sort((a, b) => a.length - b.length || a.localeCompare(b)).filter((p, i, all) => !all.slice(0, i).some(parent => within(p, parent)));
  const excluded = exclude.map(p => path.resolve(p));
  const homePath = path.resolve(home);
  const started = performance.now();
  const result = { schema_version: 1, generated_at: new Date().toISOString(), projects: [], worktrees: [], coverage: { roots: approved, complete: true, entries_scanned: 0, git_commands: 0, blockedOutsideScope: 0, blockedWithinScope: 0, limits: { max_projects: maxProjects, max_depth: maxDepth, max_entries: MAX_ENTRIES, max_ms: TOTAL_MS, command_ms: COMMAND_MS }, skipped: [] }, errors: [] };
  const skip = (target, reason, error = false) => {
    result.coverage.complete = false;
    if (result.coverage.skipped.length < 100) result.coverage.skipped.push({ path: target, reason });
    if (error && result.errors.length < 100) result.errors.push({ path: target, code: reason });
  };
  const protectedPath = target => {
    if (excluded.some(p => within(target, p))) return 'excluded';
    if (target === path.parse(target).root || ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/proc', '/private/etc', '/private/var/db', '/private/var/root', '/var/db', '/var/root'].some(p => within(target, p))) return 'system_path';
    const components = within(target, homePath) ? path.relative(homePath, target).split(path.sep) : target.split(path.sep);
    return components.some(p => PROTECTED.has(fold(p))) ? 'protected_path' : null;
  };
  const budget = target => {
    if (performance.now() - started >= TOTAL_MS) { skip(target, 'time_limit'); return false; }
    if (result.coverage.entries_scanned >= MAX_ENTRIES) { skip(target, 'entry_limit'); return false; }
    if (result.projects.length >= maxProjects) { skip(target, 'project_limit'); return false; }
    return true;
  };
  const seenDirectories = new Set();
  const projectIdentities = new Map();
  function visit(target, depth, device) {
    if (!budget(target)) return;
    if (protectedPath(target) || GENERATED.has(fold(path.basename(target)))) return;
    try {
      const ancestors = noSymlinkAncestors(target);
      if (ancestors.symlink) { skip(target, 'symlink'); return; }
      if (ancestors.missing) { skip(target, 'missing_path'); return; }
      const before = fs.lstatSync(target);
      if (!before.isDirectory()) return;
      if (device !== undefined && before.dev !== device) { skip(target, 'filesystem_boundary'); return; }
      const identity = `${before.dev}:${before.ino}`;
      if (seenDirectories.has(identity)) return;
      seenDirectories.add(identity);
      result.coverage.entries_scanned++;
      const marker = fs.lstatSync(path.join(target, '.git'), { throwIfNoEntry: false });
      if (marker?.isSymbolicLink()) { skip(path.join(target, '.git'), 'symlink'); return; }
      if (marker?.isDirectory() || marker?.isFile()) {
        result.projects.push({ path: target, git_kind: marker.isDirectory() ? 'directory' : 'worktree_file', active_use_checked: false, eligible_for_deletion: false });
        projectIdentities.set(target, { dev: before.dev, ino: before.ino, markerDev: marker.dev, markerIno: marker.ino });
        return; // A project is a boundary; do not crawl its sources/dependencies.
      }
      if (depth >= maxDepth) { skip(target, 'depth_limit'); return; }
      const entries = [];
      const directory = fs.opendirSync(target, { bufferSize: 32 });
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (performance.now() - started >= TOTAL_MS) { skip(target, 'time_limit'); break; }
          if (entries.length >= MAX_ENTRIES - result.coverage.entries_scanned) { skip(target, 'entry_limit'); break; }
          entries.push(entry);
        }
      } finally { directory.closeSync(); }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (!budget(target)) break;
        const child = path.join(target, entry.name);
        if (protectedPath(child) || GENERATED.has(fold(entry.name))) continue;
        if (entry.isSymbolicLink()) { skip(child, 'symlink'); continue; }
        if (entry.isDirectory()) visit(child, depth + 1, before.dev);
        else result.coverage.entries_scanned++;
      }
      const after = fs.lstatSync(target);
      if (after.dev !== before.dev || after.ino !== before.ino || after.mtimeMs !== before.mtimeMs || noSymlinkAncestors(target).symlink) skip(target, 'directory_changed_during_scan');
    } catch (error) { skip(target, typeof error.code === 'string' ? error.code : 'metadata_error', true); }
  }
  for (const root of approved) visit(root, 0);
  const seenWorktrees = new Set();
  const seenBlockedOutside = new Set();
  const sameProject = project => {
    const ancestors = noSymlinkAncestors(project.path);
    if (ancestors.symlink || ancestors.missing) return false;
    const identity = projectIdentities.get(project.path);
    const directory = fs.lstatSync(project.path);
    const marker = fs.lstatSync(path.join(project.path, '.git'));
    return directory.isDirectory() && !marker.isSymbolicLink() && directory.dev === identity.dev && directory.ino === identity.ino && marker.dev === identity.markerDev && marker.ino === identity.markerIno;
  };
  for (const project of result.projects) {
    const remaining = TOTAL_MS - (performance.now() - started);
    if (remaining <= 0) { skip(project.path, 'time_limit'); break; }
    try {
      if (!sameProject(project)) { skip(project.path, 'project_changed_during_inventory'); continue; }
      result.coverage.git_commands++;
      const command = spawnSync(GIT, ['--no-pager', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', project.path, 'worktree', 'list', '--porcelain', '-z'], { env: gitEnvironment(), encoding: 'utf8', timeout: Math.max(1, Math.floor(Math.min(COMMAND_MS, remaining))), maxBuffer: MAX_OUTPUT, stdio: ['ignore', 'pipe', 'pipe'] });
      if (command.error || command.status !== 0) { skip(project.path, command.error?.code === 'ETIMEDOUT' ? 'git_timeout' : 'git_failed', true); continue; }
      if (!sameProject(project)) { skip(project.path, 'project_changed_during_inventory'); continue; }
      for (const item of parseWorktrees(command.stdout)) {
        if (!path.isAbsolute(item.path) || item.path.includes('\0')) { skip(project.path, 'invalid_git_output', true); continue; }
        const target = path.resolve(item.path);
        if (!approved.some(root => within(target, root))) {
          // Do not stat, expose, or retain a path outside the approved scope.
          if (!seenBlockedOutside.has(target)) { seenBlockedOutside.add(target); result.coverage.blockedOutsideScope++; }
          continue;
        }
        if (seenWorktrees.has(target)) continue;
        seenWorktrees.add(target);
        if (protectedPath(target)) { result.coverage.blockedWithinScope++; continue; }
        const ancestors = noSymlinkAncestors(target);
        if (ancestors.symlink) { skip(target, 'symlink'); result.coverage.blockedWithinScope++; continue; }
        result.worktrees.push({ ...item, path: target, exists: !ancestors.missing, metadata_only: true, requires_approval: true, eligible_for_deletion: false, blockers: ['owner_approval_required', 'active_use_not_checked', 'recoverability_not_verified', 'worktree_flags_do_not_prove_disposability'] });
      }
    } catch (error) { skip(project.path, error.message === 'invalid_git_output' ? error.message : 'metadata_error', true); }
  }
  result.projects.sort((a, b) => a.path.localeCompare(b.path));
  result.worktrees.sort((a, b) => a.path.localeCompare(b.path));
  return result;
}
