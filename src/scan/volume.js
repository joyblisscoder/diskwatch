import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const DU_TIMEOUT_MS = 20_000;
const DATA_VOL = '/System/Volumes/Data';
const VM_DIR = '/System/Volumes/VM';
const SLEEPIMAGE = path.join(VM_DIR, 'sleepimage');
const UPDATES = ['/Library/Updates', '/System/Volumes/Update'];

/**
 * spawnSync with timeout flag. Used by duSk; exported for timeout unit tests.
 * @returns {{ timedOut: boolean, status: number|null, stdout: string, stderr: string, error: Error|null }}
 */
export function timedSpawn(cmd, args, timeoutMs) {
  const r = spawnSync(cmd, args, {
    timeout: timeoutMs,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const timedOut = Boolean(r.error && (r.error.code === 'ETIMEDOUT' || r.error.killed));
  return {
    timedOut,
    status: r.status,
    stdout: r.stdout == null ? '' : String(r.stdout),
    stderr: r.stderr == null ? '' : String(r.stderr),
    error: r.error || null,
  };
}

/**
 * `du -sk <path>` with timeout. stderr discarded.
 * @returns {{ size_kb: number, timedOut: boolean, partial: boolean, ok: boolean, missing?: boolean }}
 */
export function duSk(target, timeoutMs = DU_TIMEOUT_MS) {
  let exists = true;
  try {
    fs.accessSync(target);
  } catch {
    exists = false;
  }
  if (!exists) {
    return { size_kb: 0, timedOut: false, partial: false, ok: true, missing: true };
  }

  const r = timedSpawn('du', ['-sk', target], timeoutMs);
  const m = /^(\d+)/.exec(r.stdout.trim());
  const size_kb = m ? Number(m[1]) : 0;
  const usable = m != null;

  if (r.timedOut) {
    return { size_kb: usable ? size_kb : 0, timedOut: true, partial: true, ok: false };
  }

  if (r.status !== 0 && r.status != null) {
    if (usable) {
      return { size_kb, timedOut: false, partial: true, ok: true };
    }
    // permission-denied / other failure with no size
    return { size_kb: 0, timedOut: false, partial: false, ok: false };
  }

  return { size_kb, timedOut: false, partial: false, ok: true };
}

function parseDfDataVolume() {
  const r = spawnSync('df', ['-k', DATA_VOL], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0 && !r.stdout) {
    throw new Error(`df failed: ${r.stderr || r.error || r.status}`);
  }
  const lines = String(r.stdout || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  const dataLine =
    lines.find((l) => l.includes(DATA_VOL)) ||
    lines.find((l) => /^\S+\s+\d+/.test(l) && !/^Filesystem/i.test(l));
  if (!dataLine) throw new Error('df: Data volume line not found');
  // Filesystem 1024-blocks Used Available Capacity ... Mounted on
  const parts = dataLine.split(/\s+/);
  // Handle filesystem names with spaces by taking last numeric block near Available
  // Standard: [fs, blocks, used, avail, capacity%, ...]
  let vol_total_kb = 0;
  let vol_free_kb = 0;
  if (parts.length >= 4 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[3])) {
    vol_total_kb = Number(parts[1]);
    vol_free_kb = Number(parts[3]);
  } else {
    const nums = parts.filter((p) => /^\d+$/.test(p)).map(Number);
    if (nums.length < 3) throw new Error(`df: unparseable line: ${dataLine}`);
    vol_total_kb = nums[0];
    vol_free_kb = nums[2];
  }
  return { vol_total_kb, vol_free_kb };
}

/** Parse sysctl vm.swapusage "used = NNNN.NNM" -> integer MB. */
export function parseSwapUsedMb(text) {
  const m = /used\s*=\s*([\d.]+)M/i.exec(String(text));
  if (!m) return 0;
  return Math.round(Number(m[1]));
}

function swapUsedMbFromSysctl() {
  const r = spawnSync('sysctl', ['-n', 'vm.swapusage'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return parseSwapUsedMb(r.stdout || '');
}

/** Sum sizes of /System/Volumes/VM/swapfile* in KB. Unreadable files contribute 0. */
function swapfilesKb() {
  let sum = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(VM_DIR);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.startsWith('swapfile')) continue;
    try {
      const st = fs.statSync(path.join(VM_DIR, name));
      if (st.isFile()) sum += Math.floor(st.size / 1024);
    } catch {
      /* permission-denied or raced away */
    }
  }
  return sum;
}

function sleepimageKb() {
  try {
    const st = fs.statSync(SLEEPIMAGE);
    return Math.floor(st.size / 1024);
  } catch {
    return 0;
  }
}

/**
 * Volume free/total, swap used MB, and restart-reclaimable KB.
 * restart_reclaim_kb = max(sysctl swap KB, swapfile* KB) + sleepimage + Updates dus.
 */
export function measureVolume() {
  const { vol_total_kb, vol_free_kb } = parseDfDataVolume();
  const swap_used_mb = swapUsedMbFromSysctl();
  const swapSysctlKb = swap_used_mb * 1024;
  const swapFilesKb = swapfilesKb();
  const swapPartKb = Math.max(swapSysctlKb, swapFilesKb);

  let updatesKb = 0;
  for (const p of UPDATES) {
    const d = duSk(p, DU_TIMEOUT_MS);
    updatesKb += d.size_kb || 0;
  }

  const restart_reclaim_kb = swapPartKb + sleepimageKb() + updatesKb;
  return { vol_total_kb, vol_free_kb, swap_used_mb, restart_reclaim_kb };
}
