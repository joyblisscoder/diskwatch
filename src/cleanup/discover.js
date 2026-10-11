import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const DAY = 86400000;
const GENERATED = new Map([['node_modules', 'dependencies'], ['.next', 'build_output'], ['build', 'build_output'], ['dist', 'build_output'], ['.cache', 'cache'], ['.npm', 'cache']]);
const PROTECTED = new Set(['.git', '.ssh', '.gnupg', '.aws', '.azure', '.config', '.local', '.codex', '.claude', '.agents', '.hermes', '.openclaw', '.cursor', '.vscode', '.npmrc', '.netrc', '.pypirc', '.trash', 'documents', 'desktop', 'pictures', 'photos', 'music', 'movies', 'library']);
const SECRET = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|ed25519|ecdsa)(?:\..*)?)$|\.(?:pem|key|p12|pfx|keychain(?:-db)?|photoslibrary|photolibrary)$/i;
const SOURCE = /\.(?:[cm]?[jt]sx?|py|rb|go|rs|swift|c|cpp|h|java|sh|md|txt|pdf|docx?|xlsx?|pptx?|sqlite(?:3)?|db)$/i;
const within = (target, parent) => target === parent || target.startsWith(parent + path.sep);

// Metadata is evidence of age and size, never evidence of ownership or permission.
export async function discoverCandidates({ roots, exclude = [], minAgeDays = 30, minBytes = 100 * 1024 * 1024, maxEntries = 20000, maxDepth = 8, maxMs = 5000, now = Date.now(), home = os.homedir() } = {}) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 100 || roots.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Explicit absolute approved roots are required (maximum 100).');
  if (!Array.isArray(exclude) || exclude.length > 1000 || exclude.some(p => typeof p !== 'string' || !path.isAbsolute(p))) throw new Error('Exclusions must be absolute paths (maximum 1000).');
  for (const [name, value, cap] of [['minAgeDays', minAgeDays, 365000], ['minBytes', minBytes, Number.MAX_SAFE_INTEGER], ['maxEntries', maxEntries, 100000], ['maxDepth', maxDepth, 32], ['maxMs', maxMs, 30000]]) {
    if (!Number.isFinite(value) || value < 0 || value > cap || !Number.isInteger(value)) throw new Error(`${name} must be an integer between 0 and ${cap}.`);
  }
  if (!Number.isFinite(now) || !Number.isFinite(new Date(now).getTime())) throw new Error('Invalid current time.');
  if (typeof home !== 'string' || !path.isAbsolute(home)) throw new Error('Home must be an absolute path.');
  const approved = [...new Set(roots.map(p => path.resolve(p)))].sort((a, b) => a.length - b.length).filter((p, i, all) => !all.slice(0, i).some(parent => within(p, parent)));
  const excluded = exclude.map(p => path.resolve(p));
  const homePath = path.resolve(home);
  const cachePath = path.join(homePath, 'Library', 'Caches');
  const started = performance.now();
  const result = { schema_version: 1, generated_at: new Date(now).toISOString(), candidates: [], coverage: { roots: approved, entries_scanned: 0, bytes_observed: 0, complete: true, limits: { max_entries: maxEntries, max_depth: maxDepth, max_ms: maxMs, max_candidates: 100 }, skipped: [] }, partial: false, errors: [] };
  const skip = (target, reason, error = false) => {
    result.partial = true;
    result.coverage.complete = false;
    if (result.coverage.skipped.length < 100) result.coverage.skipped.push({ path: target, reason });
    if (error && result.errors.length < 100) result.errors.push({ path: target, code: reason });
  };
  const budget = target => {
    if (result.coverage.entries_scanned >= maxEntries) { skip(target, 'entry_limit'); return false; }
    if (performance.now() - started >= maxMs) { skip(target, 'time_limit'); return false; }
    return true;
  };
  const protectedPath = target => {
    if (excluded.some(p => within(target, p))) return 'excluded';
    if (target === path.parse(target).root || ['/System', '/Library', '/usr', '/bin', '/sbin', '/etc', '/dev', '/proc'].some(p => within(target, p))) return 'system_path';
    let components = (within(target, homePath) ? path.relative(homePath, target) : target).split(path.sep);
    // Only this explicitly approved Library subtree is discoverable. Other
    // application state stays protected, including nested Library directories.
    if (within(target.toLowerCase(), cachePath.toLowerCase())) components = components.slice(2);
    if (components.some(p => PROTECTED.has(p.toLowerCase()) || SECRET.test(p))) return 'protected_path';
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
  const candidate = (target, kind, data) => ({
    path: target, kind, bytes: data.bytes, newest_mtime: new Date(data.newest).toISOString(), age_days: Math.floor((now - data.newest) / DAY),
    confidence: 'metadata_only', requires_approval: true, eligible_for_deletion: false,
    blockers: ['owner_approval_required', 'active_use_not_checked', 'recoverability_not_verified', ...(kind === 'manual_review' ? ['user_content_or_unknown_purpose'] : ['generated_name_does_not_prove_disposability'])],
    evidence: { traversal_complete: true, entries: data.entries, oldest_threshold_days: minAgeDays, basis: 'newest_descendant_modification_time', allocated_bytes: false, content_read: false },
  });
  const stale = data => data.complete && data.bytes >= minBytes && now - data.newest >= minAgeDays * DAY;
  const failed = () => ({ bytes: 0, newest: 0, entries: 0, complete: false, candidates: [] });
  function visit(target, depth, device, insideAggregate = false) {
    if (!budget(target)) return failed();
    const protection = protectedPath(target);
    if (protection) { skip(target, protection); return failed(); }
    result.coverage.entries_scanned++;
    try {
      if (!noSymlinkAncestors(target)) { skip(target, 'symlink'); return failed(); }
      const stat = fs.lstatSync(target);
      if (device !== undefined && stat.dev !== device) { skip(target, 'filesystem_boundary'); return failed(); }
      const data = { bytes: 0, newest: stat.mtimeMs, entries: 1, complete: true, candidates: [] };
      if (stat.isFile()) {
        if (stat.nlink > 1) { skip(target, 'hard_link'); return failed(); }
        data.bytes = stat.size;
        result.coverage.bytes_observed += stat.size;
        if (!insideAggregate && !SOURCE.test(path.basename(target)) && stale(data)) data.candidates.push(candidate(target, 'manual_review', data));
        return data;
      }
      if (!stat.isDirectory()) { skip(target, 'special_file'); return failed(); }
      if (depth >= maxDepth) { skip(target, 'depth_limit'); return failed(); }
      const kind = path.dirname(target).toLowerCase() === cachePath.toLowerCase() ? 'cache' : GENERATED.get(path.basename(target));
      const directory = fs.opendirSync(target, { bufferSize: 32 });
      try {
        let entry;
        while ((entry = directory.readSync()) !== null) {
          if (!budget(target)) { data.complete = false; break; }
          const child = visit(path.join(target, entry.name), depth + 1, stat.dev, insideAggregate || !!kind);
          data.bytes += child.bytes;
          data.newest = Math.max(data.newest, child.newest);
          data.entries += child.entries;
          data.complete &&= child.complete;
          if (!kind && !insideAggregate) {
            data.candidates.push(...child.candidates.slice(0, 100 - data.candidates.length));
            if (data.candidates.length >= 100) { skip(target, 'candidate_limit'); data.complete = false; break; }
          }
        }
      } finally { directory.closeSync(); }
      const after = fs.lstatSync(target);
      if (!noSymlinkAncestors(target) || after.ino !== stat.ino || after.dev !== stat.dev || after.mtimeMs !== stat.mtimeMs) {
        skip(target, 'directory_changed_during_scan'); return failed();
      }
      if (kind && !insideAggregate && stale(data)) data.candidates.push(candidate(target, kind, data));
      return data;
    } catch (error) {
      skip(target, typeof error.code === 'string' ? error.code : 'metadata_error', true);
      return failed();
    }
  }
  for (const root of approved) {
    const data = visit(root, 0);
    result.candidates.push(...data.candidates.slice(0, 100 - result.candidates.length));
    if (result.candidates.length >= 100) { skip(root, 'candidate_limit'); break; }
  }
  result.candidates.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path));
  return result;
}
