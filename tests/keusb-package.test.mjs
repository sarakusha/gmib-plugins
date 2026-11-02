import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { unzipSync } from 'fflate';
import { buildPlugin } from '../scripts/lib.mjs';

test('KeUSB archive loads backend with all runtime dependencies outside source tree', async () => {
  const { archivePath } = await buildPlugin('keusb-24r');
  const files = unzipSync(await readFile(archivePath));
  assert.ok(files['dist/lib/protocol.cjs']);
  assert.ok(files['dist/lib/automation.cjs']);
  const root = await mkdtemp(path.join(os.tmpdir(), 'keusb-install-'));
  try {
    for (const [name, bytes] of Object.entries(files)) {
      const file = path.join(root, name);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }
    const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
    const require = createRequire(path.join(root, 'manifest.json'));
    assert.equal(typeof require(path.join(root, manifest.main)).activate, 'function');
  } finally { await rm(root, { recursive: true, force: true }); }
});
