import fs from 'node:fs';

import { discoverPluginIds, readManifest } from './lib.mjs';

const tag = process.argv[2];
if (!tag) throw new Error('Не передан тег релиза');
for (const pluginId of await discoverPluginIds()) {
  const manifest = await readManifest(pluginId);
  if (tag !== `${pluginId}-v${manifest.version}`) continue;
  const output = `id=${pluginId}\nversion=${manifest.version}\nname=${manifest.name}\n`;
  if (process.env.GITHUB_OUTPUT) await fs.promises.appendFile(process.env.GITHUB_OUTPUT, output);
  else process.stdout.write(output);
  process.exit(0);
}
throw new Error(`Тег ${tag} не соответствует версии ни одного плагина`);
