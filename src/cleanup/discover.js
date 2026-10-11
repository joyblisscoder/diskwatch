import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const DAY = 86400000;
const GENERATED = new Map([['node_modules', 'dependencies'], ['.next', 'build_output'], ['build', 'build_output'], ['dist', 'build_output'], ['target', 'build_output'], ['coverage', 'build_output'], ['.venv', 'dependencies'], ['__pycache__', 'cache'], ['.gradle', 'cache'], ['.turbo', 'cache'], ['.cache', 'cache'], ['.npm', 'cache']]);
const PROJECT_MARKERS = new Set(['package.json', 'Cargo.toml', 'pyproject.toml', 'setup.py', 'go.mod', 'Gemfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Package.swift', 'CMakeLists.txt', '.git']);
const PROTECTED = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.config', '.local', '.codex', '.claude', '.claude-mem', '.grok', '.agents', '.hermes', '.openclaw', '.cursor', '.vscode', '.npmrc', '.netrc', '.pypirc', '.trash', 'documents', 'desktop', 'pictures', 'photos', 'music', 'movies', 'library']);
export const VCS_METADATA = ['.hg','.svn','.bzr','_darcs','cvs','rcs','.fslckout','.fossil-settings'];
for(const name of VCS_METADATA) PROTECTED.add(name);
const SECRET = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?)$|\.(?:pem|key|p12|pfx|keychain(?:-db)?|photoslibrary|photolibrary)$/i;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|swift|c|cpp|h|java|sh|md|txt|pdf|docx?|xlsx?|pptx?|sqlite(?:3)?|db)$/i;
const foldPath = value => value.normalize('NFC').toLowerCase();
const within = (target, parent) => {
  const a = foldPath(target), b = foldPath(parent);
  return a === b || a.startsWith(b.endsWith(path.sep) ? b : b + path.sep);
};
const digest = values => createHash('sha256').update(JSON.stringify(values)).digest('hex');
const metadata = (target, stat) => [target, stat.dev, stat.ino, stat.mode, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink];
const unchanged = (a, b) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const rank = (a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path);

// Metadata is read-only evidence, never ownership, permission or disposability.
// Budgets apply independently to each explicit root. Incomplete aggregates are
// observed lower bounds, with unknown activity and omitted descendants blocked.
export async function discoverCandidates({ roots, exclude = [], minAgeDays = 30, minBytes = 100 * 1024 * 1024, maxEntries = 200000, maxDepth = 16, maxMs = 5000, maxTotalMs = 30000, now = Date.now(), home = os.homedir() } = {}) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 100 || roots.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Explicit absolute approved roots are required (maximum 100).');
  if (!Array.isArray(exclude) || exclude.length > 1000 || exclude.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Exclusions must be absolute paths (maximum 1000).');
  for (const [name, value, cap] of [['minAgeDays', minAgeDays, 365000], ['minBytes', minBytes, Number.MAX_SAFE_INTEGER], ['maxEntries', maxEntries, 1000000], ['maxDepth', maxDepth, 32], ['maxMs', maxMs, 30000], ['maxTotalMs', maxTotalMs, 30000]]) {
    if (!Number.isFinite(value) || value < 0 || value > cap || !Number.isInteger(value)) throw new Error(`${name} must be an integer between 0 and ${cap}.`);
  }
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid current time.');
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('Home must be an absolute path.');
  const approved = [...new Set(roots.map(p => path.resolve(p)))].sort((a, b) => a.length - b.length || a.localeCompare(b)).filter((p, i, all) => !all.slice(0, i).some(parent => within(p, parent)));
  const excluded = exclude.map(p => path.resolve(p));
  const homePath = path.resolve(home), cachePath = path.join(homePath, 'Library', 'Caches');
  const totalDeadline = performance.now() + maxTotalMs;
  const result = { schema_version: 1, generated_at: new Date(now).toISOString(), candidates: [], coverage: { roots: approved, entries_scanned: 0, bytes_observed: 0, complete: true, limits: { max_entries: maxEntries, max_depth: maxDepth, max_ms: maxMs, max_total_ms: maxTotalMs, max_candidates: 100, budget_scope: 'per_root' }, per_root: [], skipped: [] }, partial: false, errors: [] };
  const protectedPath = target => {
    if (excluded.some(p => within(target, p))) return 'excluded';
    if (target === path.parse(target).root || ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/proc'].some(p => within(target, p))) return 'system_path';
    let components = target.split(path.sep);
    if (within(target, homePath)) components = components.slice(homePath.split(path.sep).length);
    if (within(target, cachePath)) components = components.slice(2);
    if (components.some(p => PROTECTED.has(foldPath(p)) || SECRET.test(p))) return 'protected_path';
    return null;
  };
  const noSymlinkAncestors = target => {
    let current = path.parse(target).root;
    for (const part of target.slice(current.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      if (fs.lstatSync(current).isSymbolicLink()) return false;
    }
    return true;
  };
  const kindFor = target => foldPath(path.dirname(target)) === foldPath(cachePath) ? 'cache' : (path.basename(target) === 'cache' && path.basename(path.dirname(target)) === '.yarn' ? 'cache' : GENERATED.get(path.basename(target)));
  const retain = candidate => {
    result.candidates.push(candidate); result.candidates.sort(rank);
    if (result.candidates.length > 100) result.candidates.pop();
  };
  for (let rootIndex = 0; rootIndex < approved.length; rootIndex++) {
    const root = approved[rootIndex];
    const state = { path: root, entries_scanned: 0, bytes_observed: 0, complete: true, started: performance.now() };
    state.time_budget_ms = Math.max(0, Math.min(maxMs, (totalDeadline - state.started) / (approved.length - rootIndex)));
    const rootDeadline = state.started + state.time_budget_ms;
    const projects = [], aggregates = [], manual = [];
    result.coverage.per_root.push(state);
    const skip = (target, reason, error = false, incomplete = true) => {
      if (incomplete) { state.complete = false; result.partial = true; result.coverage.complete = false; }
      if (result.coverage.skipped.length < 100) result.coverage.skipped.push({ path: target, reason });
      if (error && result.errors.length < 100) result.errors.push({ path: target, code: reason });
    };
    const budget = (target, entryCap = maxEntries, deadline = rootDeadline) => {
      if (state.entries_scanned >= entryCap) { skip(target, 'entry_limit'); return false; }
      if (performance.now() >= deadline) { skip(target, 'time_limit'); return false; }
      return true;
    };
    const statEntry = target => { state.entries_scanned++; result.coverage.entries_scanned++; return fs.lstatSync(target); };
    const observeBytes = bytes => { state.bytes_observed += bytes; result.coverage.bytes_observed += bytes; };
    const recordProject = (project, token, newest = 0) => {
      for (let owner = project; owner; owner = owner.parent) {
        owner.tokens.push(token); owner.newest = Math.max(owner.newest, newest);
      }
    };
    // Bound name enumeration as well as lstat calls. No file contents are read.
    const children = (target, cap, deadline) => {
      const names = [], directory = fs.opendirSync(target, { bufferSize: 128 });
      let complete = true;
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (names.length >= Math.max(0, cap - state.entries_scanned) || performance.now() >= deadline) {
            skip(target, performance.now() >= deadline ? 'time_limit' : 'entry_limit'); complete = false; break;
          }
          names.push(entry.name);
        }
      } finally { directory.closeSync(); }
      names.sort(); return { names, complete };
    };
    const failed = (blocked = false) => ({ bytes: 0, newest: 0, entries: 0, links: 0, complete: false, blocked, tokens: [] });
    function aggregate(target, depth, device, entryCap, deadline, initialStat) {
      if (!initialStat && !budget(target, entryCap, deadline)) return failed();
      const protection = protectedPath(target);
      if (protection) { skip(target, protection); return failed(true); }
      try {
        const stat = initialStat || statEntry(target);
        if (stat.dev !== device) { skip(target, 'filesystem_boundary'); return failed(true); }
        const data = { bytes: 0, newest: stat.mtimeMs, entries: 1, links: 0, complete: true, blocked: false, tokens: [metadata(target, stat)] };
        if (stat.isSymbolicLink()) {
          // Count only link metadata. Never readlink or traverse the target.
          data.bytes = stat.size; data.links = 1; observeBytes(stat.size); return data;
        }
        if (stat.isFile()) {
          if (stat.nlink > 1) { skip(target, 'hard_link'); return failed(true); }
          data.bytes = stat.size; observeBytes(stat.size); return data;
        }
        if (!stat.isDirectory()) { skip(target, 'special_file'); return failed(true); }
        if (depth >= maxDepth) { skip(target, 'depth_limit'); data.complete = false; return data; }
        const listing = children(target, entryCap, deadline); data.complete = listing.complete;
        for (const name of listing.names) {
          if (!budget(target, entryCap, deadline)) { data.complete = false; break; }
          const child = aggregate(path.join(target, name), depth + 1, device, entryCap, deadline);
          data.bytes += child.bytes; data.newest = Math.max(data.newest, child.newest); data.entries += child.entries; data.links += child.links;
          data.complete &&= child.complete; data.blocked ||= child.blocked;
          for (const token of child.tokens) data.tokens.push(token);
        }
        if (!unchanged(stat, fs.lstatSync(target))) { skip(target, 'directory_changed_during_scan'); return failed(true); }
        return data;
      } catch (error) { skip(target, error.code || 'metadata_error', true); return failed(true); }
    }
    let skeletonComplete = true;
    const queue = [{ target: root, depth: 0, device: undefined, project: null }];
    try {
      if (!noSymlinkAncestors(root)) { skip(root, 'symlink'); queue.length = 0; skeletonComplete = false; }
    } catch (error) { skip(root, error.code || 'metadata_error', true); queue.length = 0; skeletonComplete = false; }
    // Breadth-first source discovery exposes later projects before their large
    // generated trees consume the root's budget.
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const item = queue[cursor], { target, depth, device } = item;
      if (!budget(target)) { skeletonComplete = false; break; }
      const protection = protectedPath(target);
      if (protection) { skip(target, protection); if (item.project) item.project.complete = false; continue; }
      try {
        const stat = statEntry(target);
        if (device !== undefined && stat.dev !== device) { skip(target, 'filesystem_boundary'); if (item.project) item.project.complete = false; continue; }
        if (stat.isSymbolicLink()) { skip(target, 'symlink'); if (item.project) item.project.complete = false; continue; }
        if (stat.isFile()) {
          if (stat.nlink > 1) { skip(target, 'hard_link'); if (item.project) item.project.complete = false; continue; }
          observeBytes(stat.size);
          recordProject(item.project, metadata(target, stat), stat.mtimeMs);
          if (!SOURCE.test(path.basename(target)) && !PROJECT_MARKERS.has(path.basename(target))) manual.push({ target, stat, project: item.project });
          continue;
        }
        if (!stat.isDirectory()) { skip(target, 'special_file'); if (item.project) item.project.complete = false; continue; }
        const kind = kindFor(target);
        if (kind) { aggregates.push({ target, depth, stat, project: item.project, kind }); continue; }
        if (depth >= maxDepth) { skip(target, 'depth_limit'); skeletonComplete = false; continue; }
        const listing = children(target, maxEntries, rootDeadline); skeletonComplete &&= listing.complete;
        let project = item.project;
        if (listing.names.some(name => PROJECT_MARKERS.has(name))) {
          project = { path: target, newest: 0, complete: listing.complete, git_kind: null, tokens: [], parent: item.project }; projects.push(project);
        }
        recordProject(project, metadata(target, stat));
        for (const name of listing.names) {
          const child = path.join(target, name);
          if (name !== '.git' || !project) { queue.push({ target: child, depth: depth + 1, device: stat.dev, project }); continue; }
          // Sample narrowly named Git metadata, without opening configuration,
          // objects, or the destination named by a worktree .git file.
          if (excluded.some(p => within(child, p))) { skip(child, 'excluded'); project.complete = false; continue; }
          if (!budget(child)) { project.complete = false; skeletonComplete = false; continue; }
          const git = statEntry(child); recordProject(project, metadata(child, git), git.isFile() ? git.mtimeMs : 0);
          if (git.isSymbolicLink() || git.dev !== stat.dev || (!git.isFile() && !git.isDirectory())) { skip(child, 'protected_git_metadata'); project.complete = false; continue; }
          project.git_kind = git.isDirectory() ? 'directory' : 'worktree_file';
          if (git.isDirectory()) for (const relative of ['HEAD', 'index', 'logs/HEAD']) {
            const gitPath = path.join(child, relative);
            if (excluded.some(p => within(gitPath, p))) { project.complete = false; skip(gitPath, 'excluded'); continue; }
            if (!budget(gitPath)) { project.complete = false; skeletonComplete = false; break; }
            try {
              if (!noSymlinkAncestors(gitPath)) { skip(gitPath, 'symlink'); project.complete = false; continue; }
              const gitStat = statEntry(gitPath);
              if (!gitStat.isFile() || gitStat.dev !== stat.dev || gitStat.nlink > 1) { project.complete = false; skip(gitPath, 'protected_git_metadata'); continue; }
              recordProject(project, metadata(gitPath, gitStat), gitStat.mtimeMs);
            } catch (error) { if (error.code !== 'ENOENT') { project.complete = false; skip(gitPath, error.code || 'metadata_error', true); } }
          }
        }
        if (!unchanged(stat, fs.lstatSync(target))) { skip(target, 'directory_changed_during_scan'); skeletonComplete = false; if (project) project.complete = false; }
      } catch (error) { skip(target, error.code || 'metadata_error', true); skeletonComplete = false; if (item.project) item.project.complete = false; }
    }
    // A nested package still belongs to its ancestor Git/project context. Any
    // observed source or Git activity in that context blocks the package's old
    // output, and uncertainty propagates through the same ownership chain.
    for (const project of [...projects].reverse()) if (project.parent) project.parent.complete &&= project.complete;
    for (const project of projects) {
      project.complete &&= skeletonComplete;
      project.tokens.sort((a, b) => a[0].localeCompare(b[0])); project.own_fingerprint = digest(project.tokens);
    }
    for (const project of projects) {
      const lineage = [];
      for (let owner = project; owner; owner = owner.parent) {
        lineage.push(owner); project.newest = Math.max(project.newest, owner.newest); project.complete &&= owner.complete;
        project.git_kind ||= owner.git_kind;
      }
      project.activity_roots = lineage.map(owner => owner.path);
      project.fingerprint = digest(lineage.map(owner => owner.own_fingerprint));
    }
    const offer = (target, kind, data, project) => {
      const minimumSizeMet = data.bytes >= minBytes;
      if (data.blocked || (!minimumSizeMet && (data.complete || data.bytes === 0)) || now - data.newest < minAgeDays * DAY) return;
      if (project?.newest && now - project.newest < minAgeDays * DAY) { skip(target, 'active_project', false, false); return; }
      try {
        if (!noSymlinkAncestors(target)) { skip(target, 'symlink'); return; }
        if (digest(metadata(target, fs.lstatSync(target))) !== digest(data.tokens[0])) { skip(target, 'item_changed_during_scan'); return; }
      } catch (error) { skip(target, error.code || 'metadata_error', true); return; }
      data.tokens.sort((a, b) => a[0].localeCompare(b[0]));
      const projectInfo = project ? { path: project.path, newest_mtime: project.newest ? new Date(project.newest).toISOString() : null, age_days: project.newest ? Math.floor((now - project.newest) / DAY) : null, activity_complete: project.complete, git_kind: project.git_kind, activity_roots: project.activity_roots } : null;
      retain({ path: target, kind, bytes: data.bytes, newest_mtime: new Date(data.newest).toISOString(), age_days: Math.floor((now - data.newest) / DAY), fingerprint: digest([data.tokens, data.complete, project?.fingerprint || null, project?.complete ?? null]), project: projectInfo,
        confidence: 'metadata_only', requires_approval: true, eligible_for_deletion: false,
        blockers: ['owner_approval_required', 'active_use_not_checked', 'recoverability_not_verified', ...(kind === 'manual_review' ? ['user_content_or_unknown_purpose'] : ['generated_name_does_not_prove_disposability']), ...(!data.complete ? ['incomplete_metadata_scan'] : []), ...(!minimumSizeMet ? ['size_threshold_not_established'] : []), ...(data.links ? ['symlink_targets_not_inspected'] : []), ...(!project ? ['owning_project_not_identified'] : !project.complete || !project.newest ? ['project_activity_incomplete'] : [])],
        evidence: { traversal_complete: data.complete, entries: data.entries, oldest_threshold_days: minAgeDays, basis: data.complete ? 'newest_descendant_modification_time' : 'observed_descendant_modification_time', allocated_bytes: false, content_read: false, bytes_lower_bound: !data.complete, minimum_size_met: minimumSizeMet, minimum_threshold_bytes: minBytes, symlink_metadata_entries: data.links },
      });
    };
    for (const { target, stat, project } of manual) offer(target, 'manual_review', { bytes: stat.size, newest: stat.mtimeMs, entries: 1, links: 0, complete: true, blocked: false, tokens: [metadata(target, stat)] }, project);
    // Expensive aggregates share the remaining root budget fairly. Unused
    // shares flow forward, and exhausting one share never stops later roots.
    for (let i = 0; i < aggregates.length; i++) {
      const item = aggregates[i], remaining = aggregates.length - i;
      const entryCap = state.entries_scanned + Math.floor((maxEntries - state.entries_scanned) / remaining);
      const deadline = performance.now() + Math.max(0, rootDeadline - performance.now()) / remaining;
      const data = aggregate(item.target, item.depth, item.stat.dev, entryCap, deadline, item.stat); offer(item.target, item.kind, data, item.project);
    }
    state.elapsed_ms = Math.ceil(performance.now() - state.started); delete state.started;
  }
  return result;
}
