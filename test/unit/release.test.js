import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('source export excludes history, local notes, state and unlisted files', async () => {
  const { exportSource, RELEASE_FILES } = await import('../../scripts/package-release.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'diskwatch-export-'));
  const source = path.join(base,'source');
  const output = path.join(base,'output');
  for (const file of RELEASE_FILES) {
    fs.mkdirSync(path.dirname(path.join(source,file)),{recursive:true});
    fs.writeFileSync(path.join(source,file),file === 'package.json' ? '{"version":"0.1.0"}' : 'public fixture\n');
  }
  for (const file of ['.git/config','tasks/lessons.md','src/private.json','state/diskwatch.db','docs/KNOWN-PATTERNS.md']) {
    fs.mkdirSync(path.dirname(path.join(source,file)),{recursive:true});
    fs.writeFileSync(path.join(source,file),'PRIVATE SENTINEL');
  }
  exportSource({source,destination:output});
  assert.ok(fs.existsSync(path.join(output,'scripts/install.js')));
  assert.equal(fs.readlinkSync(path.join(output,'AGENTS.md')),'CONTEXT.md');
  assert.equal(fs.readFileSync(path.join(output,'CONTEXT.md'),'utf8'),'public fixture\n');
  for (const file of ['.git','tasks','state','src/private.json','docs/KNOWN-PATTERNS.md']) assert.equal(fs.existsSync(path.join(output,file)),false,file);
  assert.throws(() => exportSource({source,destination:output}), /exists/i);
  fs.writeFileSync(path.join(source,'README.md'),['','private','var','folders','aa','synthetic-user-id','X','cache'].join('/'));
  const rejected=path.join(base,'private-output');
  assert.throws(()=>exportSource({source,destination:rejected}),/personal.*path/i);
  assert.equal(fs.existsSync(rejected),false);
});
