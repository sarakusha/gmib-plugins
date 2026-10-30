'use strict';

const { validateSettings } = require('./model.cjs');
const LIMIT = 50;

function normalizeName(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value)) throw new Error('Некорректное название темы');
  const name = value.normalize('NFC').trim();
  if (!name || Array.from(name).length > 80) throw new Error('Название темы должно содержать 1–80 символов');
  return name;
}

function readTheme(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Нужен объект темы');
  return { name: normalizeName(value.name), settings: validateSettings(value.settings) };
}

function importTheme(value) {
  if (!value || value.format !== 'gmib-informer-theme' || value.version !== 1) throw new Error('Неизвестный формат или версия темы');
  return readTheme(value);
}

function restoreThemes(value) {
  const themes = new Map();
  if (Array.isArray(value)) for (const entry of value) {
    try {
      const theme = readTheme(entry);
      if (themes.has(theme.name) || themes.size < LIMIT) themes.set(theme.name, theme);
    } catch { /* A damaged entry must not hide the remaining saved themes. */ }
  }
  return [...themes.values()];
}

module.exports = { LIMIT, normalizeName, importTheme, restoreThemes };
