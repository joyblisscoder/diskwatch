/** Unix epoch seconds helpers. Display formatting stays at the edge. */

export function nowSec() {
  return Math.floor(Date.now() / 1000);
}

/** YYYY-MM-DD in local time for the given epoch seconds. */
export function dayKey(sec) {
  const d = new Date(sec * 1000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse "YYYY-MM-DD HH:MM:SS" as local time to epoch seconds. */
export function parseLocalTs(str) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(str).trim());
  if (!m) throw new Error(`bad local timestamp: ${str}`);
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  return Math.floor(new Date(y, mo - 1, d, h, mi, s).getTime() / 1000);
}

/** Seconds elapsed since the given epoch timestamp. */
export function agoSec(sec) {
  return nowSec() - sec;
}

/** Human age from an epoch timestamp: "N min ago", "N hr ago", etc. */
export function formatAgo(sec) {
  const age = agoSec(sec);
  if (age < 0) return 'just now';
  if (age < 60) return `${age} sec ago`;
  const min = Math.floor(age / 60);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr} hr ago`;
  const days = Math.floor(hr / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
