import { ingestDiskguard } from './diskguard-log.js';
import { ingestJanitor } from './janitor-log.js';
import { getConfig } from '../config.js';

/** Run all Phase 1 external log ingests. */
export function runIngest(db) {
  if (!getConfig().integrations.external_logs) return { skipped: true, reason: 'disabled' };
  const diskguard = ingestDiskguard(db);
  const janitor = ingestJanitor(db);
  return { diskguard, janitor };
}

export { ingestDiskguard, ingestJanitor };
