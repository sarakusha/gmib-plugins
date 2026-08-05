'use strict';

const defaults = Object.freeze({
  spaces: 32,
  parkingSize: 154,
  counterSize: 180,
  textShadow: 45,
  compactDigits: false,
  captionVisible: false,
  captionSize: 24,
  bottomMode: 'ornament',
  switchInterval: 8,
  backgroundOpacity: 0,
});

const numberInRange = (value, fallback, min, max) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, Math.round(number))) : fallback;
};

const normalizeState = value => {
  const state = value && typeof value === 'object' ? value : {};
  const bottomMode = ['ornament', 'logo', 'alternate'].includes(state.bottomMode)
    ? state.bottomMode
    : defaults.bottomMode;
  return {
    spaces: numberInRange(state.spaces, defaults.spaces, 0, 9999),
    parkingSize: numberInRange(state.parkingSize, defaults.parkingSize, 64, 240),
    counterSize: numberInRange(state.counterSize, defaults.counterSize, 72, 240),
    textShadow: numberInRange(state.textShadow, defaults.textShadow, 0, 100),
    compactDigits:
      typeof state.compactDigits === 'boolean' ? state.compactDigits : defaults.compactDigits,
    captionVisible:
      typeof state.captionVisible === 'boolean'
        ? state.captionVisible
        : defaults.captionVisible,
    captionSize: numberInRange(state.captionSize, defaults.captionSize, 12, 48),
    bottomMode,
    switchInterval: numberInRange(state.switchInterval, defaults.switchInterval, 2, 120),
    backgroundOpacity: numberInRange(
      state.backgroundOpacity,
      state.testBackground === true ? 100 : defaults.backgroundOpacity,
      0,
      100,
    ),
  };
};

exports.activate = async ({ events, http, storage }) => {
  const stored = normalizeState(await storage.get('state', defaults));
  await storage.set('state', stored);

  const publish = async state => {
    await storage.set('state', state);
    events.publish('changed', state);
    return state;
  };

  http.get('/state', async () => normalizeState(await storage.get('state', defaults)));
  http.put('/state', async request => publish(normalizeState(request.body)));

  http.post('/increment', async request => {
    const step = numberInRange(request.body?.step, 1, 1, 999);
    const state = normalizeState(await storage.get('state', defaults));
    return publish({ ...state, spaces: Math.min(9999, state.spaces + step) });
  });

  http.post('/decrement', async request => {
    const step = numberInRange(request.body?.step, 1, 1, 999);
    const state = normalizeState(await storage.get('state', defaults));
    return publish({ ...state, spaces: Math.max(0, state.spaces - step) });
  });
};
