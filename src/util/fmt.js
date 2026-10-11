import os from 'node:os';
import path from 'node:path';

export function bytesFromKb(kb) {
  return Number(kb) * 1024;
}

/** Human size from bytes: GB or MB (or KB under 1 MB). */
export function fmtBytes(bytes) {
  const n = Number(bytes);
  const gb = n / (1024 ** 3);
  if (Math.abs(gb) >= 1) return fmtGb(gb);
  const mb = n / (1024 ** 2);
  if (Math.abs(mb) >= 1) return `${mb.toFixed(1)} MB`;
  const kb = n / 1024;
  return `${Math.round(kb)} KB`;
}

/** Human size from KiB input. */
export function fmtKb(kb) {
  return fmtBytes(bytesFromKb(kb));
}

export function fmtGb(gbNumber, digits = 1) {
  return `${Number(gbNumber).toFixed(digits)} GB`;
}

/** green >=80, amber >=40, red <40. */
export function freeColor(freeGb) {
  const g = Number(freeGb);
  if (g >= 80) return 'green';
  if (g >= 40) return 'amber';
  return 'red';
}

/** Replace leading ~/ with homedir. Absolute paths pass through. */
export function expandHome(p) {
  if (p == null) return p;
  const s = String(p);
  if (s === '~') return os.homedir();
  if (s.startsWith('~/') || s.startsWith('~' + path.sep)) {
    return path.join(os.homedir(), s.slice(2));
  }
  return s;
}

/** Replace homedir prefix with ~. */
export function collapseHome(p) {
  if (p == null) return p;
  const s = String(p);
  const home = os.homedir();
  if (s === home) return '~';
  const prefix = home.endsWith(path.sep) ? home : home + path.sep;
  if (s.startsWith(prefix)) return '~/' + s.slice(prefix.length);
  return s;
}
