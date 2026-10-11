import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expandHome } from './util/fmt.js';

function stateRoot() {
  if (process.env.DISKWATCH_STATE_DIR) return process.env.DISKWATCH_STATE_DIR;
  return path.join(os.homedir(), '.local', 'state', 'diskwatch');
}

export const THRESHOLDS = {
  free_warn_gb: 40,
  free_critical_gb: 20,
  swap_cap_gb: 15,
  caps: {
    '~/.claude/projects': 10,
    '~/.codex/sessions': 12,
    '~/.grok/sessions': 6,
    '~/.claude-mem': 15,
    '~/Library/Application Support/Claude/vm_bundles': 20,
  },
  worktrees_total_gb: 35,
  db_warn_mb: 250,
  db_fail_mb: 500,
  scan_stale_min: 45,
  staleness_stale_sec: 2700,
};

/** Seed watchlist written into config.json on first run. */
export const WATCHLIST_SEED = [
  { path: '~/.codex/sessions', mode: 'leaf' },
  { path: '~/.codex', mode: 'leaf' },
  { path: '~/.claude', mode: 'leaf' },
  { path: '~/.claude-mem', mode: 'leaf' },
  { path: '~/.grok/sessions', mode: 'leaf' },
  { path: '~/Library/Application Support/Claude/vm_bundles', mode: 'leaf' },
  { path: '~/Library/pnpm', mode: 'leaf' },
  { path: '~/.npm', mode: 'leaf' },
  { path: '~/.cache', mode: 'leaf' },
  { path: '~/.local/share', mode: 'leaf' },
  { path: '~/.ollama', mode: 'leaf' },
  { path: '~/Downloads', mode: 'leaf' },
  { path: '~/.Trash', mode: 'leaf' },
  { path: '/Library/Updates', mode: 'leaf' },
  { path: '~/.local/state/diskwatch', mode: 'leaf' },
  { path: '~/Documents', mode: 'leaf', protected: 1, tier: 'slow' },
  { path: '~/Pictures', mode: 'leaf', protected: 1 },
  { path: '~/Movies', mode: 'leaf', protected: 1 },
  { path: '~/.claude/projects', mode: 'expand' },
  { path: '~/Developer', mode: 'expand' },
  { path: '~/Library/Caches', mode: 'expand' },
  { path: '~/Library/Developer', mode: 'expand' },
  { path: '~/Library/Containers', mode: 'expand' },
  { path: '~/Library/Application Support', mode: 'expand' },
];

export function ensureStateDir() {
  const root = stateRoot();
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(root, 'logs'), { recursive: true, mode: 0o700 });
  return root;
}

export function statePath(...parts) {
  return path.join(stateRoot(), ...parts);
}

export function dbPath() {
  return statePath('diskwatch.db');
}

export function configPath() {
  return statePath('config.json');
}

function mergeThresholds(fromFile) {
  const merged = { ...THRESHOLDS, ...(fromFile || {}) };
  merged.caps = { ...THRESHOLDS.caps, ...((fromFile && fromFile.caps) || {}) };
  return merged;
}

/**
 * Load ~/.local/state/diskwatch/config.json.
 * Creates it on first run with thresholds + watchlist seed.
 * File thresholds overlay the built-in defaults.
 */
export function loadConfig() {
  ensureStateDir();
  const p = configPath();
  if (!fs.existsSync(p)) {
    const cfg = {
      notifications: { channel: 'none' },
      integrations: { worktree_helper: false, external_logs: false, agent_menu: false },
      thresholds: structuredClone(THRESHOLDS),
      watchlist: structuredClone(WATCHLIST_SEED),
    };
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
    return cfg;
  }
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  return {
    ...parsed,
    notifications: parsed.notifications || { channel: 'telegram' },
    integrations: parsed.integrations || { worktree_helper: true, external_logs: true, agent_menu: true },
    thresholds: mergeThresholds(parsed.thresholds),
    watchlist: Array.isArray(parsed.watchlist) ? parsed.watchlist : structuredClone(WATCHLIST_SEED),
  };
}

export function notificationChannel() {
  const channel = getConfig().notifications.channel;
  if (!['none', 'macos', 'telegram'].includes(channel)) {
    throw new Error(`Unknown notifications.channel: ${channel}`);
  }
  return channel;
}

let cached = null;

export function getConfig() {
  if (!cached) cached = loadConfig();
  return cached;
}

export { expandHome };
