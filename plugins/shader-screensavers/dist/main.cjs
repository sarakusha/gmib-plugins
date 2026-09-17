'use strict';

const openapi = require('../public/openapi.json');

const defaults = Object.freeze({
  scene: 'truchet',
  speed: 45,
  scale: 50,
  brightness: 85,
  patternOpacity: 100,
  backgroundOpacity: 100,
  colorA: '#7cffcb',
  colorB: '#6a5cff',
  background: '#05070d',
  animate: true,
});

const scenes = new Set(['truchet', 'aurora', 'plasma', 'topography']);
const hexColor = /^#[0-9a-fA-F]{6}$/;
const settingKeys = [
  'scene',
  'speed',
  'scale',
  'brightness',
  'patternOpacity',
  'backgroundOpacity',
  'colorA',
  'colorB',
  'background',
  'animate',
];

const numberInRange = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

const color = (value, fallback) =>
  typeof value === 'string' && hexColor.test(value) ? value.toLowerCase() : fallback;

const normalizeState = value => {
  const state = value && typeof value === 'object' ? value : {};
  return {
    scene: scenes.has(state.scene) ? state.scene : defaults.scene,
    speed: numberInRange(state.speed, defaults.speed, 0, 100),
    scale: numberInRange(state.scale, defaults.scale, 0, 100),
    brightness: numberInRange(state.brightness, defaults.brightness, 5, 100),
    patternOpacity: numberInRange(
      state.patternOpacity,
      defaults.patternOpacity,
      0,
      100,
    ),
    backgroundOpacity: numberInRange(
      state.backgroundOpacity,
      defaults.backgroundOpacity,
      0,
      100,
    ),
    colorA: color(state.colorA, defaults.colorA),
    colorB: color(state.colorB, defaults.colorB),
    background: color(state.background, defaults.background),
    animate: typeof state.animate === 'boolean' ? state.animate : defaults.animate,
  };
};

const settingsFromState = state => ({
  scene: state.scene,
  speed: state.speed,
  scale: state.scale,
  brightness: state.brightness,
  patternOpacity: state.patternOpacity,
  backgroundOpacity: state.backgroundOpacity,
  colorA: state.colorA,
  colorB: state.colorB,
  background: state.background,
  animate: state.animate,
});

const sameSettings = (left, right) =>
  settingKeys.every(key => Object.is(left[key], right[key]));

const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);

const invalidSetting = (field, error) => ({ ok: false, field, error });

const parseInteger = (value, field, min, max) => {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    return invalidSetting(field, `${field} must be an integer between ${min} and ${max}`);
  return value;
};

const parseColor = (value, field) => {
  if (typeof value !== 'string' || !hexColor.test(value))
    return invalidSetting(field, `${field} must be a #RRGGBB color`);
  return value.toLowerCase();
};

const parseSettingsPatch = body => {
  if (!isRecord(body)) return invalidSetting('settings', 'body must be a JSON object');
  const patch = {};
  for (const [field, value] of Object.entries(body)) {
    if (!settingKeys.includes(field)) return invalidSetting(field, `${field} is not supported`);
    if (field === 'scene') {
      if (typeof value !== 'string' || !scenes.has(value))
        return invalidSetting(field, `${field} is not a supported scene`);
      patch[field] = value;
    } else if (field === 'speed' || field === 'scale') {
      const parsed = parseInteger(value, field, 0, 100);
      if (typeof parsed === 'object') return parsed;
      patch[field] = parsed;
    } else if (field === 'brightness') {
      const parsed = parseInteger(value, field, 5, 100);
      if (typeof parsed === 'object') return parsed;
      patch[field] = parsed;
    } else if (field === 'patternOpacity' || field === 'backgroundOpacity') {
      const parsed = parseInteger(value, field, 0, 100);
      if (typeof parsed === 'object') return parsed;
      patch[field] = parsed;
    } else if (field === 'colorA' || field === 'colorB' || field === 'background') {
      const parsed = parseColor(value, field);
      if (typeof parsed === 'object') return parsed;
      patch[field] = parsed;
    } else if (field === 'animate') {
      if (typeof value !== 'boolean') return invalidSetting(field, `${field} must be boolean`);
      patch[field] = value;
    }
  }
  return { ok: true, patch };
};

exports.activate = async ({ events, http, storage }) => {
  const stored = normalizeState(await storage.get('state', defaults));
  await storage.set('state', stored);

  http.get('/state', async () => normalizeState(await storage.get('state', defaults)));
  http.put('/state', async request => {
    const state = normalizeState(request.body);
    await storage.set('state', state);
    events.publish('changed', state);
    return state;
  });

  http.get(
    '/settings',
    async () => settingsFromState(normalizeState(await storage.get('state', defaults))),
    { access: 'authenticated' },
  );
  http.patch(
    '/settings',
    async request => {
      const parsed = parseSettingsPatch(request.body);
      if (!parsed.ok)
        return http.response(400, {
          error: parsed.error,
          field: parsed.field,
        });
      let changed = false;
      const stored = await storage.update('state', currentValue => {
        const current = normalizeState(currentValue ?? defaults);
        const next = normalizeState({ ...current, ...parsed.patch });
        changed = !sameSettings(current, next);
        return next;
      });
      const state = normalizeState(stored);
      if (changed) events.publish('changed', state);
      return { changed, settings: settingsFromState(state) };
    },
    { access: 'authenticated' },
  );
  http.get('/openapi.json', async () => openapi, { access: 'authenticated' });
};
