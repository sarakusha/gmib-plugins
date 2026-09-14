import fs from 'node:fs';
import path from 'node:path';

import { pluginsRoot, repositoryRoot } from './lib.mjs';

for (const entry of await fs.promises.readdir(pluginsRoot, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pluginDirectory = path.join(pluginsRoot, entry.name);
  const configPath = path.join(pluginDirectory, 'sports-libraries.json');
  const mappings = await fs.promises
    .readFile(configPath, 'utf8')
    .then(JSON.parse)
    .catch(error => {
      if (error.code === 'ENOENT') return undefined;
      throw error;
    });
  if (!mappings) continue;
  for (const [target, source] of Object.entries(mappings)) {
    const targetPath = path.join(pluginDirectory, target);
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(path.join(repositoryRoot, source), targetPath);
    console.log(`✓ ${entry.name}/${target} ← ${source}`);
  }
}
