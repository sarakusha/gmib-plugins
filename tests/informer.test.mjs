import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const main = require('../plugins/informer/dist/main.cjs');
const model = require('../plugins/informer/dist/model.cjs');
const informerSample = require('../plugins/informer/dist/sample.json');
const KEY = 'informer.v1';
const validKey = '0123456789abcdef0123456789abcdef';

function host(initial) {
  const data = new Map(initial ? [[KEY, structuredClone(initial)]] : []);
  const routes = new Map();
  const events = [];
  const context = {
    storage: {
      get: async (key) => data.get(key),
      set: async (key, value) => { data.set(key, structuredClone(value)); },
    },
    http: {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
      delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
      response: (status, body) => ({ status, body }),
    },
    events: { publish: (event, value) => events.push({ event, value }) },
    output: { listScreens: async () => [], getStatus: async () => ({ active: false }) },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  };
  return {
    data, events, routes,
    activate: () => main.activate(context),
    call: (method, path, body) => routes.get(`${method} ${path}`)({ method, path, body, query: {} }),
  };
}

function fakeWeather() {
  return { info: { lat: 0, lon: 0, arbitrary: 'ignored' }, fact: {
    temp: 0, feels_like: 0, condition: 'clear', wind_speed: 0, wind_dir: 'c',
    pressure_mm: 0, humidity: 0, obs_time: 0, daytime: 'n', secret: 'ignored',
  }, forecast: { date: '2026-10-29', sunrise: '07:05', sunset: '17:20',
    parts: [{ part_name: 'day', temp_min: 0, temp_max: 0, condition: 'clear', prec_prob: 0,
      undocumented: 'ignored' }, { part_name: 'night', temp_min: -1, temp_max: 1,
      condition: 'cloudy', prec_prob: 25 }, { part_name: 'day', temp_min: 4, temp_max: 3 }] },
    arbitrary: 'ignored' };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

test('activation, GET, settings, and restart do not fetch weather', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error('unexpected fetch'); };
  try {
    const h = host(); await h.activate();
    assert.equal((await h.call('GET', '/state')).cache.mode, 'frozen');
    const settings = structuredClone(model.defaults);
    assert.equal((await h.call('PUT', '/settings', settings)).settings.clock.timeZone, 'Europe/Moscow');
    const restarted = host(h.data.get(KEY)); await restarted.activate();
    await restarted.call('GET', '/state');
    assert.equal(calls, 0);
  } finally { globalThis.fetch = originalFetch; }
});

test('settings reject invalid Intl values, timezone, and colors', () => {
  for (const mutate of [
    (s) => { s.clock.locale = 'not a locale!'; },
    (s) => { s.clock.timeZone = 'Mars/Olympus'; },
    (s) => { s.date.options.timeZone = 'UTC'; },
    (s) => { s.date.options.day = 'absurd'; },
    (s) => { s.styles.clock.color = 'red'; },
  ]) {
    const settings = structuredClone(model.defaults); mutate(settings);
    assert.throws(() => model.validateSettings(settings));
  }
  const h = host();
  return h.activate().then(async () => {
    const settings = structuredClone(model.defaults); settings.clock.timeZone = 'Invalid/Zone';
    assert.equal((await h.call('PUT', '/settings', settings)).status, 422);
  });
});

test('backdrop migration preserves saved settings and accepts full dimming', () => {
  const saved = structuredClone(model.defaults);
  delete saved.appearance.backdrop;
  delete saved.appearance.showSource;
  saved.clock.timeZone = 'UTC';
  saved.appearance.dim = 0.65;
  const restored = model.validateSettings(saved);
  assert.equal(restored.appearance.backdrop, 'gradient');
  assert.equal(restored.appearance.showSource, false);
  restored.appearance.showSource = true;
  assert.equal(model.validateSettings(restored).appearance.showSource, true);
  assert.equal(restored.appearance.dim, 0.65);
  assert.equal(restored.clock.timeZone, 'UTC');
  restored.appearance.backdrop = 'photo';
  restored.appearance.dim = 1;
  assert.equal(model.validateSettings(restored).appearance.dim, 1);
  restored.appearance.backdrop = 'invalid';
  assert.throws(() => model.validateSettings(restored));
});

test('weather normalization preserves valid zeroes and filters optional or malformed fields', () => {
  const result = model.normalizeWeather(fakeWeather(), 1234);
  assert.equal(result.temp, 0); assert.equal(result.feelsLike, 0);
  assert.equal(result.windSpeed, 0); assert.equal(result.humidity, 0);
  assert.equal(result.location.lat, 0); assert.equal(result.location.lon, 0);
  assert.equal(result.pressureMm, null); // zero is outside the documented pressure range
  assert.equal(result.observedAt, 0); assert.equal(result.fetchedAt, 1234);
  assert.deepEqual(result.forecast.map(({ part, tempMin, tempMax, precipitationProbability }) =>
    [part, tempMin, tempMax, precipitationProbability]), [['day', 0, 0, 0], ['night', -1, 1, 25]]);
  assert.equal(result.sunrise, '07:05'); assert.equal(result.sunset, '17:20');
  assert.deepEqual(model.normalizeWeather({ fact: { temp: 0, condition: 'clear' } }).forecast, []);
  assert.throws(() => model.normalizeWeather({ fact: { temp: '0', condition: 'clear' } }));
  assert.equal(model.normalizeWeather({ fact: { temp: 0, condition: 'clear', humidity: 101 } }).humidity, null);
  for (const date of ['2026-02-30', '2026-99-99', 'not-a-date']) {
    const raw = fakeWeather(); raw.forecast.date = date;
    assert.deepEqual(model.normalizeWeather(raw).forecast, []);
  }
});

test('plural forecasts accept named part objects and preserve valid forecast fields', () => {
  const result = model.normalizeWeather({ fact: { temp: 2, condition: 'cloudy' }, forecasts: [
    { date: '2026-10-29', sunrise: '07:05', parts: {
      day: { temp_min: 1, temp_max: 3, condition: 'cloudy', prec_prob: 0 },
      night: { temp_min: -2, temp_max: 0, condition: 'clear', prec_prob: 10 },
      unknown: { temp_min: 1, temp_max: 3 },
    } },
    { date: '2026-10-30', parts: { evening: { temp_min: 4, temp_max: 5, condition: 'clear', prec_prob: 100 } } },
  ] });
  assert.deepEqual(result.forecast.map(({ date, part, tempMin, tempMax, precipitationProbability }) =>
    [date, part, tempMin, tempMax, precipitationProbability]), [
    ['2026-10-29', 'day', 1, 3, 0], ['2026-10-29', 'night', -2, 0, 10],
    ['2026-10-30', 'evening', 4, 5, 100],
  ]);
});

test('Informers imports allowlisted weather only and never persist or publish API keys', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('capture must not run in this test'); };
  try {
    const h = host(); await h.activate();
    const imported = await h.call('POST', '/weather/import', { data: fakeWeather(), apiKey: validKey, extra: 'secret' });
    assert.equal(imported.cache.origin, 'import');
    assert.equal(imported.weather.temp, 0);
    assert.equal('arbitrary' in imported.weather, false);
    assert.equal('secret' in imported.weather, false);
    assert.equal(JSON.stringify(h.data.get(KEY)).includes(validKey), false);
    assert.equal(JSON.stringify(h.events).includes(validKey), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('successful one-time Informers capture sends the key only in its header and restores frozen forecast', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => { requests.push({ url: new URL(url), options }); return jsonResponse(informerSample); };
  try {
    const h = host(); await h.activate();
    const request = { apiKey: validKey, lat: 55.75, lon: 37.62 };
    const captured = await h.call('POST', '/weather/capture', request);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url.origin + requests[0].url.pathname, 'https://api.weather.yandex.ru/v2/informers');
    assert.equal(requests[0].url.searchParams.get('lat'), '55.75');
    assert.equal(requests[0].url.searchParams.get('lon'), '37.62');
    assert.equal(requests[0].url.searchParams.get('lang'), 'ru_RU');
    assert.equal(requests[0].url.search, '?lat=55.75&lon=37.62&lang=ru_RU');
    assert.equal(requests[0].options.headers['X-Yandex-Weather-Key'], validKey);
    assert.equal(requests[0].url.href.includes(validKey), false);
    assert.equal(captured.cache.origin, 'capture');
    assert.equal(captured.weather.temp, informerSample.fact.temp);
    const expectedPart = informerSample.forecast.parts[0];
    assert.equal(captured.weather.forecast[0].part, expectedPart.part_name);
    assert.equal(captured.weather.forecast[0].tempMin, expectedPart.temp_min);
    assert.equal(captured.weather.forecast[0].precipitationProbability, expectedPart.prec_prob);
    assert.equal(JSON.stringify(captured).includes(validKey), false);
    assert.equal(JSON.stringify(h.events).includes(validKey), false);
    assert.equal(JSON.stringify(h.data.get(KEY)).includes(validKey), false);

    const restarted = host(h.data.get(KEY)); await restarted.activate();
    const restored = await restarted.call('GET', '/state');
    assert.deepEqual(restored.weather, captured.weather);
    assert.deepEqual(restored.cache, captured.cache);
    await restarted.call('GET', '/state');
    await restarted.call('PUT', '/settings', structuredClone(model.defaults));
    assert.equal(requests.length, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('GET output returns status in the response body without using it as transport status', { concurrency: false }, async () => {
  const h = host(); await h.activate();
  const result = await h.call('GET', '/output');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.status, { active: false });
  assert.deepEqual(result.body.screens, []);
});

test('concurrent capture requests share one frozen attempt; 429 preserves weather and lock across restart', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; await new Promise((resolve) => setTimeout(resolve, 10)); return jsonResponse({}, 429); };
  try {
    const h = host(); await h.activate();
    const before = (await h.call('GET', '/state')).weather;
    const request = { apiKey: validKey, lat: 0, lon: 0 };
    const results = await Promise.all([h.call('POST', '/weather/capture', request), h.call('POST', '/weather/capture', request)]);
    assert.equal(calls, 1);
    assert.deepEqual(results.map((x) => x.status).sort(), [409, 502]);
    const state = await h.call('GET', '/state');
    assert.deepEqual(state.weather, before);
    assert.equal(typeof state.cache.attemptedAt, 'number');
    assert.match(state.cache.message, /HTTP 429/);
    const restarted = host(h.data.get(KEY)); await restarted.activate();
    assert.equal((await restarted.call('POST', '/weather/capture', request)).status, 409);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = originalFetch; }
});

test('storage failure before dispatch prevents fetch and leaves the attempt unreserved', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; return jsonResponse(fakeWeather()); };
  try {
    const broken = host();
    // The host exposes persisted state; make storage failure deterministic by replacing Map.set.
    const realSet = broken.data.set.bind(broken.data);
    broken.data.set = () => { throw new Error('disk full'); };
    await broken.activate();
    assert.equal((await broken.call('POST', '/weather/capture', { apiKey: validKey, lat: 1, lon: 2 })).status, 500);
    assert.equal(calls, 0);
    broken.data.set = realSet;
    assert.equal((await broken.call('GET', '/state')).cache.attemptedAt, null);
  } finally { globalThis.fetch = originalFetch; }
});

test('invalid provider response preserves the previous weather and keeps the attempt lock', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({ fact: { temp: 'untrusted', condition: 'clear' } });
  try {
    const h = host(); await h.activate();
    const before = (await h.call('GET', '/state')).weather;
    const result = await h.call('POST', '/weather/capture', { apiKey: validKey, lat: 0, lon: 0 });
    assert.equal(result.status, 502);
    const saved = await h.call('GET', '/state');
    assert.deepEqual(saved.weather, before);
    assert.equal(typeof saved.cache.attemptedAt, 'number');
    assert.equal((await h.call('POST', '/weather/capture', { apiKey: validKey, lat: 0, lon: 0 })).status, 409);
  } finally { globalThis.fetch = originalFetch; }
});

test('raw imported metadata is ignored and import cannot reset a used attempt lock', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonResponse({}, 429);
  try {
    const h = host(); await h.activate();
    await h.call('POST', '/weather/capture', { apiKey: validKey, lat: 0, lon: 0 });
    const lock = h.data.get(KEY).cache.attemptedAt;
    const result = await h.call('POST', '/weather/import', { data: fakeWeather(), attemptedAt: null,
      cache: { attemptedAt: null }, apiKey: validKey });
    assert.equal(result.cache.attemptedAt, lock);
    assert.equal(JSON.stringify(h.data.get(KEY)).includes(validKey), false);
    assert.equal('attemptedAt' in result.weather, false);
  } finally { globalThis.fetch = originalFetch; }
});
