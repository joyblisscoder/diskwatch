import fs from 'node:fs';
import path from 'node:path';

const MAX_BYTES = 10 * 1024 * 1024;
const KEEP = 5;

function logsDir(stateDir) {
  return path.join(stateDir, 'logs');
}

function ensureLogsDir(stateDir) {
  fs.mkdirSync(logsDir(stateDir), { recursive: true, mode: 0o700 });
}

function rotateIfNeeded(filePath) {
  let size = 0;
  try {
    size = fs.statSync(filePath).size;
  } catch {
    return;
  }
  if (size < MAX_BYTES) return;

  const oldest = `${filePath}.${KEEP}`;
  try {
    fs.unlinkSync(oldest);
  } catch {
    /* absent is fine */
  }
  for (let i = KEEP - 1; i >= 1; i--) {
    const from = i === 1 ? filePath : `${filePath}.${i}`;
    const to = `${filePath}.${i + 1}`;
    try {
      fs.renameSync(from, to);
    } catch {
      /* skip missing generations */
    }
  }
}

/**
 * Append one line to stateDir/logs/<name>.log.
 * Rotates at 10MB, keeps name.log.1 .. name.log.5.
 */
export function append(stateDir, name, line) {
  ensureLogsDir(stateDir);
  const base = name.endsWith('.log') ? name.slice(0, -4) : name;
  const filePath = path.join(logsDir(stateDir), `${base}.log`);
  rotateIfNeeded(filePath);
  const text = String(line).endsWith('\n') ? String(line) : `${line}\n`;
  fs.appendFileSync(filePath, text, { encoding: 'utf8' });
}

export { ensureLogsDir, logsDir };
