import { createInterface } from 'node:readline/promises';
import { runOnboarding } from '../src/onboarding.js';
import { install } from './install.js';

try {
  if (process.argv.length > 2) throw new Error('Run node scripts/setup.js in an interactive terminal. For unattended configuration use node bin/diskwatch setup --defaults.');
  // Detect collisions before asking the user to configure an unusable install.
  install({dryRun:true});
  if (await runOnboarding()) {
    const rl = createInterface({input:process.stdin,output:process.stdout});
    let start;
    try { start = (await rl.question('\nInstall the command and start scans every 15 minutes plus the local dashboard at login? [y/N]: ')).trim().toLowerCase() === 'y'; }
    finally { rl.close(); }
    if (start) {
      const result = install({start:true});
      console.log(`\nDiskWatch is running. First scan may take a few minutes.\nDashboard: http://127.0.0.1:7381\nCommand: ${JSON.stringify(result.bin)}\nNext: ${JSON.stringify(result.bin)} agent\nChange preferences: ${JSON.stringify(result.bin)} setup`);
    } else {
      console.log('\nPreferences saved; no background jobs installed.\nTry: node bin/diskwatch migrate\n     node bin/diskwatch scan --once\n     node bin/diskwatch agent\nInstall later: node scripts/install.js --start');
    }
  }
} catch (err) { console.error(err.message); process.exitCode = 1; }
