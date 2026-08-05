import fs from 'node:fs';
import path from 'node:path';

import { buildPlugin, discoverPluginIds, repositoryRoot } from './lib.mjs';

const repository = process.env.GITHUB_REPOSITORY || 'sarakusha/gmib-plugins';
const plugins = [];
for (const pluginId of await discoverPluginIds()) {
  const { manifest, sha256, size } = await buildPlugin(pluginId);
  const tag = `${pluginId}-v${manifest.version}`;
  plugins.push({
    manifest,
    publisher: {
      id: 'sarakusha',
      name: 'gmib official',
      verified: true,
    },
    repository: `https://github.com/${repository}`,
    release: {
      url: `https://github.com/${repository}/releases/download/${tag}/${pluginId}.gmib-plugin`,
      sha256,
      size,
    },
  });
}

const catalog = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  source: `https://github.com/${repository}`,
  plugins,
};
const siteRoot = path.join(repositoryRoot, 'site');
await fs.promises.mkdir(siteRoot, { recursive: true });
await fs.promises.writeFile(
  path.join(siteRoot, 'index.json'),
  `${JSON.stringify(catalog, null, 2)}\n`,
  'utf8',
);
console.log(`✓ ${path.join(siteRoot, 'index.json')} (${plugins.length} плагина)`);
