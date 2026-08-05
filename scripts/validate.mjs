import { discoverPluginIds, readManifest } from './lib.mjs';

const pluginIds = await discoverPluginIds();
if (pluginIds.length === 0) throw new Error('Каталог plugins пуст');

for (const pluginId of pluginIds) {
  const manifest = await readManifest(pluginId);
  console.log(`✓ ${pluginId}@${manifest.version}`);
}
