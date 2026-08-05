import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { zipSync } from 'fflate';
import semver from 'semver';

export const repositoryRoot = path.resolve(import.meta.dirname, '..');
export const pluginsRoot = path.join(repositoryRoot, 'plugins');
export const outputRoot = path.join(repositoryRoot, 'dist');

const ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const allowedPermissions = new Set(['http.routes', 'storage', 'realtime', 'output.pages']);
// ZIP stores calendar fields without a timezone. A local Date constructor therefore produces the
// same metadata in every timezone, unlike parsing an absolute UTC timestamp.
const fixedArchiveTime = new Date(2000, 0, 1, 0, 0, 0);

const requiredString = (value, field) => {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`Поле "${field}" должно быть непустой строкой`);
  }
  return value.trim();
};

const normalizeRelativePath = (value, field) => {
  const input = requiredString(value, field).replaceAll('\\', '/');
  const normalized = path.posix.normalize(input);
  if (
    normalized === '.' ||
    normalized.startsWith('../') ||
    normalized.includes('/../') ||
    path.posix.isAbsolute(normalized) ||
    /^[a-zA-Z]:/.test(normalized)
  ) {
    throw new Error(`Поле "${field}" содержит недопустимый путь`);
  }
  return normalized.replace(/^\.\//, '');
};

const assertFile = async (pluginDirectory, relative, field) => {
  const target = path.join(pluginDirectory, relative);
  const stats = await fs.promises.lstat(target).catch(() => undefined);
  if (!stats?.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${field}: файл не найден или является символической ссылкой: ${relative}`);
  }
};

const assertDirectory = async (pluginDirectory, relative, field) => {
  const target = path.join(pluginDirectory, relative);
  const stats = await fs.promises.lstat(target).catch(() => undefined);
  if (!stats?.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`${field}: каталог не найден или является символической ссылкой: ${relative}`);
  }
};

export const discoverPluginIds = async () => {
  const entries = await fs.promises.readdir(pluginsRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort();
};

export const readManifest = async pluginId => {
  if (!ID_PATTERN.test(pluginId)) throw new Error(`Недопустимый идентификатор: ${pluginId}`);
  const pluginDirectory = path.join(pluginsRoot, pluginId);
  const manifestPath = path.join(pluginDirectory, 'manifest.json');
  const raw = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${pluginId}: manifest.json должен содержать объект`);
  }

  const id = requiredString(raw.id, 'id');
  if (id !== pluginId) throw new Error(`${pluginId}: id манифеста должен совпадать с каталогом`);
  if (!ID_PATTERN.test(id)) throw new Error(`${pluginId}: недопустимый id`);
  const version = requiredString(raw.version, 'version');
  if (!semver.valid(version)) throw new Error(`${pluginId}: version должна быть SemVer-версией`);
  const gmibApi = requiredString(raw.gmibApi, 'gmibApi');
  if (!semver.validRange(gmibApi) || !semver.satisfies('1.0.0', gmibApi)) {
    throw new Error(`${pluginId}: gmibApi должен включать Plugin API 1.0.0`);
  }
  requiredString(raw.name, 'name');
  if (raw.description !== undefined) requiredString(raw.description, 'description');

  const permissions = raw.permissions ?? [];
  if (!Array.isArray(permissions) || permissions.some(item => !allowedPermissions.has(item))) {
    throw new Error(`${pluginId}: permissions содержит неизвестное разрешение`);
  }
  if (new Set(permissions).size !== permissions.length) {
    throw new Error(`${pluginId}: permissions содержит повторения`);
  }

  const publicRoot =
    raw.public === undefined ? undefined : normalizeRelativePath(raw.public, 'public');
  if (publicRoot) await assertDirectory(pluginDirectory, publicRoot, 'public');
  if (raw.main !== undefined) {
    const main = normalizeRelativePath(raw.main, 'main');
    await assertFile(pluginDirectory, main, 'main');
  }

  const pages = raw.pages ?? [];
  if (!Array.isArray(pages)) throw new Error(`${pluginId}: pages должно быть массивом`);
  if ((pages.length > 0 || raw.control !== undefined) && !publicRoot) {
    throw new Error(`${pluginId}: для pages/control требуется public`);
  }
  if (pages.length > 0 && !permissions.includes('output.pages')) {
    throw new Error(`${pluginId}: для pages требуется output.pages`);
  }
  const pageIds = new Set();
  for (const [index, page] of pages.entries()) {
    if (!page || typeof page !== 'object' || Array.isArray(page)) {
      throw new Error(`${pluginId}: pages[${index}] должен быть объектом`);
    }
    const pageId = requiredString(page.id, `pages[${index}].id`);
    if (!ID_PATTERN.test(pageId) || pageIds.has(pageId)) {
      throw new Error(`${pluginId}: недопустимый или повторяющийся pages[${index}].id`);
    }
    pageIds.add(pageId);
    requiredString(page.title, `pages[${index}].title`);
    const pagePath = normalizeRelativePath(page.path, `pages[${index}].path`);
    await assertFile(pluginDirectory, path.posix.join(publicRoot, pagePath), `pages[${index}].path`);
  }
  if (raw.control !== undefined) {
    if (!raw.control || typeof raw.control !== 'object' || Array.isArray(raw.control)) {
      throw new Error(`${pluginId}: control должен быть объектом`);
    }
    if (raw.control.title !== undefined) requiredString(raw.control.title, 'control.title');
    const controlPath = normalizeRelativePath(raw.control.path, 'control.path');
    await assertFile(pluginDirectory, path.posix.join(publicRoot, controlPath), 'control.path');
  }

  return raw;
};

const collectFiles = async (root, relative = '') => {
  const current = path.join(root, relative);
  const entries = await fs.promises.readdir(current, { withFileTypes: true });
  const result = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Символические ссылки запрещены: ${child}`);
    if (entry.isDirectory()) result.push(...(await collectFiles(root, child)));
    else if (entry.isFile()) result.push(child);
  }
  return result;
};

const isExcluded = relative =>
  relative.split('/').some(part => part === 'node_modules' || part === '.DS_Store') ||
  relative.endsWith('.map') ||
  /(?:^|\/)\.env(?:\.|$)/.test(relative);

export const buildPlugin = async pluginId => {
  const manifest = await readManifest(pluginId);
  const pluginDirectory = path.join(pluginsRoot, pluginId);
  const roots = new Set(['manifest.json']);
  if (manifest.main) roots.add(manifest.main.split('/')[0]);
  if (manifest.public) roots.add(manifest.public.split('/')[0]);

  const relativeFiles = [];
  for (const root of [...roots].sort()) {
    const stats = await fs.promises.lstat(path.join(pluginDirectory, root));
    if (stats.isDirectory()) relativeFiles.push(...(await collectFiles(pluginDirectory, root)));
    else relativeFiles.push(root);
  }
  const files = [...new Set(relativeFiles)].filter(relative => !isExcluded(relative)).sort();
  await fs.promises.mkdir(outputRoot, { recursive: true });
  const archivePath = path.join(outputRoot, `${pluginId}.gmib-plugin`);
  const entries = {};
  for (const relative of files) {
    entries[relative] = await fs.promises.readFile(path.join(pluginDirectory, relative));
  }
  const archive = zipSync(entries, {
    attrs: 0o644 << 16,
    level: 9,
    mtime: fixedArchiveTime,
    os: 3,
  });
  await fs.promises.writeFile(archivePath, archive);
  return {
    archivePath,
    manifest,
    sha256: createHash('sha256').update(archive).digest('hex'),
    size: archive.byteLength,
  };
};
