/**
 * Path taxonomy: ordered anchored rules. First match wins.
 * No match => class=unknown, protected=1.
 * user_data is always protected=1.
 */

import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();
const HOME_ESC = escapeRegex(HOME);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Expand leading ~ to homedir. Normalize. Strip trailing slash (except root). */
export function expandHome(input) {
  let p = String(input ?? '');
  if (p === '~') p = HOME;
  else if (p.startsWith('~/')) p = path.join(HOME, p.slice(2));
  p = path.normalize(p);
  if (p.length > 1 && p.endsWith(path.sep)) p = p.slice(0, -1);
  return p;
}

/** Absolute path under HOME -> ~/... form. Else return absolute unchanged. */
export function toTilde(absPath) {
  const abs = expandHome(absPath);
  if (abs === HOME) return '~';
  if (abs.startsWith(HOME + path.sep)) return '~' + abs.slice(HOME.length);
  return abs;
}

/**
 * Rule: { patterns: RegExp[], class, owner, regen_command, protected }
 * or { match(abs, tilde) => result|null } for owner extraction.
 */
const RULES = [
  // Agent session stores (before agent roots)
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.codex/sessions(?:/|$)`),
      /^~\/\.codex\/sessions(?:\/|$)/,
    ],
    class: 'agent_sessions',
    owner: 'codex',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.grok/sessions(?:/|$)`),
      /^~\/\.grok\/sessions(?:\/|$)/,
    ],
    class: 'agent_sessions',
    owner: 'grok',
    regen_command: null,
    protected: 0,
  },

  // Claude-mem state
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.claude-mem(?:/|$)`),
      /^~\/\.claude-mem(?:\/|$)/,
    ],
    class: 'agent_state',
    owner: 'claude-mem',
    regen_command: null,
    protected: 0,
  },

  // DiskWatch own state
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.local/state/diskwatch(?:/|$)`),
      /^~\/\.local\/state\/diskwatch(?:\/|$)/,
    ],
    class: 'agent_state',
    owner: 'diskwatch',
    regen_command: null,
    protected: 0,
  },

  // Claude VM bundles (before general Application Support)
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Library/Application Support/Claude/vm_bundles(?:/|$)`),
      /^~\/Library\/Application Support\/Claude\/vm_bundles(?:\/|$)/,
    ],
    class: 'app_data',
    owner: 'Claude',
    regen_command: null,
    protected: 0,
  },

  // Worktrees (before ~/Developer and agent roots)
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.codex/worktrees(?:/|$)`),
      /^~\/\.codex\/worktrees(?:\/|$)/,
    ],
    class: 'worktree',
    owner: 'codex',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [/(?:^|\/)\.worktrees(?:\/|$)/],
    class: 'worktree',
    owner: null,
    regen_command: null,
    protected: 0,
  },

  // Build / package caches embedded in trees
  {
    patterns: [/(?:^|\/)node_modules(?:\/|$)/],
    class: 'regenerable_cache',
    owner: 'npm',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [
      /(?:^|\/)\.next(?:\/|$)/,
      /(?:^|\/)dist(?:\/|$)/,
      /(?:^|\/)build(?:\/|$)/,
    ],
    class: 'build_output',
    owner: null,
    regen_command: null,
    protected: 0,
  },

  // Library/Caches/<name> -> owner from dir name
  {
    match(abs, tilde) {
      const re = new RegExp(`^(?:${HOME_ESC}|~)/Library/Caches/([^/]+)(?:/|$)`);
      const m = abs.match(re) || tilde.match(re);
      if (!m) return null;
      return {
        class: 'regenerable_cache',
        owner: m[1],
        regen_command: null,
        protected: 0,
      };
    },
  },
  // Caches root itself
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Library/Caches(?:/|$)`),
      /^~\/Library\/Caches(?:\/|$)/,
    ],
    class: 'regenerable_cache',
    owner: 'caches',
    regen_command: null,
    protected: 0,
  },

  // Package manager caches with regen commands
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.npm(?:/|$)`),
      /^~\/\.npm(?:\/|$)/,
    ],
    class: 'regenerable_cache',
    owner: 'npm',
    regen_command: 'npm cache clean --force',
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Library/pnpm(?:/|$)`),
      /^~\/Library\/pnpm(?:\/|$)/,
    ],
    class: 'regenerable_cache',
    owner: 'pnpm',
    regen_command: 'pnpm store prune',
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.cache(?:/|$)`),
      /^~\/\.cache(?:\/|$)/,
    ],
    class: 'regenerable_cache',
    owner: 'cache',
    regen_command: null,
    protected: 0,
  },

  // Model weights
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.ollama(?:/|$)`),
      /^~\/\.ollama(?:\/|$)/,
    ],
    class: 'model_weights',
    owner: 'ollama',
    regen_command: null,
    protected: 0,
  },

  // OS staged updates
  {
    patterns: [/^\/Library\/Updates(?:\/|$)/],
    class: 'os_staged',
    owner: 'macos',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [/^\/System\/Volumes\/Update(?:\/|$)/],
    class: 'os_staged',
    owner: 'macos',
    regen_command: null,
    protected: 0,
  },

  // User transient
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Downloads(?:/|$)`),
      /^~\/Downloads(?:\/|$)/,
    ],
    class: 'user_transient',
    owner: 'user',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.Trash(?:/|$)`),
      /^~\/\.Trash(?:\/|$)/,
    ],
    class: 'user_transient',
    owner: 'user',
    regen_command: null,
    protected: 0,
  },

  // User data (always protected)
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Documents(?:/|$)`),
      /^~\/Documents(?:\/|$)/,
    ],
    class: 'user_data',
    owner: 'user',
    regen_command: null,
    protected: 1,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Pictures(?:/|$)`),
      /^~\/Pictures(?:\/|$)/,
    ],
    class: 'user_data',
    owner: 'user',
    regen_command: null,
    protected: 1,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Movies(?:/|$)`),
      /^~\/Movies(?:\/|$)/,
    ],
    class: 'user_data',
    owner: 'user',
    regen_command: null,
    protected: 1,
  },

  // App containers / support (after vm_bundles)
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Library/Containers(?:/|$)`),
      /^~\/Library\/Containers(?:\/|$)/,
    ],
    class: 'app_container',
    owner: null,
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Library/Application Support(?:/|$)`),
      /^~\/Library\/Application Support(?:\/|$)/,
    ],
    class: 'app_data',
    owner: null,
    regen_command: null,
    protected: 0,
  },

  // Agent roots (after sessions / worktrees / mem)
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.claude(?:/|$)`),
      /^~\/\.claude(?:\/|$)/,
    ],
    class: 'agent_state',
    owner: 'claude',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.codex(?:/|$)`),
      /^~\/\.codex(?:\/|$)/,
    ],
    class: 'agent_state',
    owner: 'codex',
    regen_command: null,
    protected: 0,
  },
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/\\.grok(?:/|$)`),
      /^~\/\.grok(?:\/|$)/,
    ],
    class: 'agent_state',
    owner: 'grok',
    regen_command: null,
    protected: 0,
  },

  // Source trees
  {
    patterns: [
      new RegExp(`^${HOME_ESC}/Developer(?:/|$)`),
      /^~\/Developer(?:\/|$)/,
    ],
    class: 'source_tree',
    owner: 'user',
    regen_command: null,
    protected: 0,
  },
];

function applyRule(rule, abs, tilde) {
  if (typeof rule.match === 'function') {
    return rule.match(abs, tilde);
  }
  for (const re of rule.patterns) {
    if (re.test(abs) || re.test(tilde)) {
      return {
        class: rule.class,
        owner: rule.owner,
        regen_command: rule.regen_command,
        protected: rule.protected,
      };
    }
  }
  return null;
}

/**
 * Classify a filesystem path.
 * @returns {{ class: string, owner: string|null, regen_command: string|null, protected: number }}
 */
export function classify(inputPath) {
  const abs = expandHome(inputPath);
  const tilde = toTilde(abs);

  for (const rule of RULES) {
    const hit = applyRule(rule, abs, tilde);
    if (hit) {
      if (hit.class === 'user_data') hit.protected = 1;
      return {
        class: hit.class,
        owner: hit.owner ?? null,
        regen_command: hit.regen_command ?? null,
        protected: hit.protected ? 1 : 0,
      };
    }
  }

  return { class: 'unknown', owner: null, regen_command: null, protected: 1 };
}

/**
 * Map a path to a known-pattern id when applicable.
 * Swap (KP-004) and codesign clones (KP-009) are not watched as paths here.
 * @returns {string|null}
 */
export function kpIdForPath(inputPath) {
  const abs = expandHome(inputPath);
  const tilde = toTilde(abs);
  const both = abs + '\n' + tilde;

  // KP-002: claude-mem observer / claude-mem
  if (/claude-mem/i.test(both)) return 'KP-002';

  // KP-008: Codex sessions (before general worktree / codex checks)
  if (
    new RegExp(`^${HOME_ESC}/\\.codex/sessions(?:/|$)`).test(abs) ||
    /^~\/\.codex\/sessions(?:\/|$)/.test(tilde)
  ) {
    return 'KP-008';
  }

  // KP-003: worktree sprawl
  if (
    /(?:^|\/)\.worktrees(?:\/|$)/.test(abs) ||
    new RegExp(`^${HOME_ESC}/\\.codex/worktrees(?:/|$)`).test(abs) ||
    /^~\/\.codex\/worktrees(?:\/|$)/.test(tilde)
  ) {
    return 'KP-003';
  }

  // KP-005: staged macOS updates
  if (
    /^\/Library\/Updates(?:\/|$)/.test(abs) ||
    /^\/System\/Volumes\/Update(?:\/|$)/.test(abs)
  ) {
    return 'KP-005';
  }

  return null;
}
