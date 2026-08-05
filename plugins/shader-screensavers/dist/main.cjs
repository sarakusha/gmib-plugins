'use strict';

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
};
