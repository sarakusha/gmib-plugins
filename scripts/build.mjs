import { buildPlugin, discoverPluginIds } from './lib.mjs';

const pluginFlag = process.argv.indexOf('--plugin');
const requested = pluginFlag >= 0 ? process.argv[pluginFlag + 1] : undefined;
const available = await discoverPluginIds();
const pluginIds = requested ? [requested] : available;
if (requested && !available.includes(requested)) throw new Error(`Плагин не найден: ${requested}`);

for (const pluginId of pluginIds) {
  const result = await buildPlugin(pluginId);
  console.log(`✓ ${result.archivePath} (${result.size} байт, sha256 ${result.sha256})`);
}
