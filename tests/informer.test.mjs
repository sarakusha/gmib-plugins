import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const main = require("../plugins/informer/dist/main.cjs");
const model = require("../plugins/informer/dist/model.cjs");
const KEY = "informer.v1";
const validKey = "0123456789abcdef0123456789abcdef";

function host(initial, runtime) {
  const data = new Map(initial ? [[KEY, structuredClone(initial)]] : []);
  const routes = new Map();
  const events = [];
  let dispose = () => {};
  let nextSave = null;
  const context = {
    lifecycle: {
      onDispose: (callback) => {
        dispose = callback;
      },
    },
    storage: {
      get: async (key) => data.get(key),
      set: async (key, value) => {
        const wait = nextSave;
        nextSave = null;
        if (wait) await wait;
        data.set(key, structuredClone(value));
      },
    },
    http: {
      get: (path, handler) => routes.set(`GET ${path}`, handler),
      post: (path, handler) => routes.set(`POST ${path}`, handler),
      put: (path, handler) => routes.set(`PUT ${path}`, handler),
      delete: (path, handler) => routes.set(`DELETE ${path}`, handler),
      response: (status, body) => ({ status, body }),
    },
    events: { publish: (event, value) => events.push({ event, value }) },
    output: {
      listScreens: async () => [],
      getStatus: async () => ({ active: false }),
    },
    logger: { warn() {}, info() {}, error() {}, debug() {} },
  };
  return {
    data,
    events,
    routes,
    dispose: () => dispose(),
    deferNextSave: (wait) => {
      nextSave = wait;
    },
    activate: () => main.activate(context, runtime),
    call: (method, path, body) =>
      routes.get(`${method} ${path}`)({ method, path, body, query: {} }),
  };
}

function fakeWeather() {
  return {
    info: { lat: 0, lon: 0, arbitrary: "ignored" },
    fact: {
      temp: 0,
      feels_like: 0,
      condition: "clear",
      wind_speed: 0,
      wind_dir: "c",
      pressure_mm: 0,
      humidity: 0,
      obs_time: 0,
      daytime: "n",
      secret: "ignored",
    },
    forecast: {
      date: "2026-10-29",
      sunrise: "07:05",
      sunset: "17:20",
      parts: [
        {
          part_name: "day",
          temp_min: 0,
          temp_max: 0,
          condition: "clear",
          prec_prob: 0,
          undocumented: "ignored",
        },
        {
          part_name: "night",
          temp_min: -1,
          temp_max: 1,
          condition: "cloudy",
          prec_prob: 25,
        },
        { part_name: "day", temp_min: 4, temp_max: 3 },
      ],
    },
    arbitrary: "ignored",
  };
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("activation, GET, settings, and restart do not fetch weather", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  assert.equal((await h.call("GET", "/state")).cache.mode, "frozen");
  const settings = structuredClone(model.defaults);
  assert.equal(
    (await h.call("PUT", "/settings", settings)).settings.clock.timeZone,
    "Europe/Moscow",
  );
  const restarted = host(h.data.get(KEY), c.runtime);
  await restarted.activate();
  await restarted.call("GET", "/state");
  await c.advance();
  assert.equal(c.requests.length, 0);
});

test("settings reject invalid Intl values, timezone, and colors", () => {
  for (const mutate of [
    (s) => {
      s.clock.locale = "not a locale!";
    },
    (s) => {
      s.clock.timeZone = "Mars/Olympus";
    },
    (s) => {
      s.date.options.timeZone = "UTC";
    },
    (s) => {
      s.date.options.day = "absurd";
    },
    (s) => {
      s.styles.clock.color = "red";
    },
  ]) {
    const settings = structuredClone(model.defaults);
    mutate(settings);
    assert.throws(() => model.validateSettings(settings));
  }
  const h = host();
  return h.activate().then(async () => {
    const settings = structuredClone(model.defaults);
    settings.clock.timeZone = "Invalid/Zone";
    assert.equal((await h.call("PUT", "/settings", settings)).status, 422);
  });
});

test("backdrop migration preserves saved settings and accepts full dimming", () => {
  const saved = structuredClone(model.defaults);
  delete saved.appearance.backdrop;
  delete saved.appearance.showSource;
  saved.clock.timeZone = "UTC";
  saved.appearance.dim = 0.65;
  const restored = model.validateSettings(saved);
  assert.equal(restored.appearance.backdrop, "gradient");
  assert.equal(restored.appearance.showSource, false);
  restored.appearance.showSource = true;
  assert.equal(model.validateSettings(restored).appearance.showSource, true);
  assert.equal(restored.appearance.dim, 0.65);
  assert.equal(restored.clock.timeZone, "UTC");
  restored.appearance.backdrop = "photo";
  restored.appearance.dim = 1;
  assert.equal(model.validateSettings(restored).appearance.dim, 1);
  restored.appearance.backdrop = "invalid";
  assert.throws(() => model.validateSettings(restored));
});

test("logo size migrates old settings and persists custom size after restart", async () => {
  const legacy = structuredClone(model.defaults);
  delete legacy.appearance.sourceSize;
  legacy.appearance.dim = 0.4;
  const migrated = model.validateSettings(legacy);
  assert.equal(migrated.appearance.sourceSize, 16);
  assert.equal(migrated.appearance.dim, 0.4);
  for (const invalid of [null, "24", 0, 7, 161, NaN]) {
    assert.throws(() =>
      model.validateSettings({
        ...migrated,
        appearance: { ...migrated.appearance, sourceSize: invalid },
      }),
    );
  }
  const h = host({ version: 1, settings: legacy });
  await h.activate();
  migrated.appearance.sourceSize = 32;
  const saved = await h.call("PUT", "/settings", migrated);
  assert.equal(saved.settings.appearance.sourceSize, 32);
  const restarted = host(h.data.get(KEY));
  await restarted.activate();
  assert.equal(
    (await restarted.call("GET", "/state")).settings.appearance.sourceSize,
    32,
  );
});

test("value animation defaults and legacy settings migrate; invalid values are rejected", async () => {
  const legacy = structuredClone(model.defaults);
  delete legacy.appearance.valueAnimation;
  legacy.clock.timeZone = "UTC";
  const migrated = model.validateSettings(legacy);
  assert.equal(migrated.appearance.valueAnimation, "none");
  assert.equal(migrated.clock.timeZone, "UTC");
  assert.equal(legacy.appearance.valueAnimation, undefined);

  for (const invalid of ["", "fade", null, 1]) {
    const settings = structuredClone(model.defaults);
    settings.appearance.valueAnimation = invalid;
    assert.throws(() => model.validateSettings(settings));
  }

  const h = host({ version: 1, settings: legacy });
  await h.activate();
  assert.deepEqual((await h.call("GET", "/state")).settings, migrated);
  const settings = structuredClone(migrated);
  settings.appearance.valueAnimation = "flip";
  assert.deepEqual(
    (await h.call("PUT", "/settings", settings)).settings,
    settings,
  );
  assert.equal(
    (await h.call("GET", "/state")).settings.appearance.valueAnimation,
    "flip",
  );
  const restarted = host(h.data.get(KEY));
  await restarted.activate();
  assert.equal(
    (await restarted.call("GET", "/state")).settings.appearance.valueAnimation,
    "flip",
  );
  for (const invalid of ["", "fade", null]) {
    const rejected = structuredClone(model.defaults);
    rejected.appearance.valueAnimation = invalid;
    assert.equal(
      (await restarted.call("PUT", "/settings", rejected)).status,
      422,
    );
  }
});

test("legacy weather styles migrate without changing unrelated preferences or the input", async () => {
  const legacy = structuredClone(model.defaults);
  delete legacy.styles.forecast;
  delete legacy.styles.metrics;
  legacy.styles.weather = { font: "serif", size: 31, color: "#aBc123" };
  legacy.clock.timeZone = "UTC";
  legacy.layout.leftWidth = 450;
  legacy.slides.forecast = false;
  const before = structuredClone(legacy);
  const migrated = model.validateSettings(legacy);
  assert.deepEqual(migrated.styles.forecast, legacy.styles.weather);
  assert.deepEqual(migrated.styles.metrics, {
    font: "serif",
    size: 24,
    color: "#aBc123",
  });
  const expected = structuredClone(legacy);
  expected.styles.forecast = migrated.styles.forecast;
  expected.styles.metrics = migrated.styles.metrics;
  assert.deepEqual(migrated, expected);
  assert.deepEqual(legacy, before);
  for (const [size, metricsSize] of [
    [8, 8],
    [160, 124],
  ]) {
    legacy.styles.weather.size = size;
    assert.equal(
      model.validateSettings(legacy).styles.metrics.size,
      metricsSize,
    );
  }
  const h = host({ version: 1, settings: before });
  await h.activate();
  assert.deepEqual((await h.call("GET", "/state")).settings, migrated);
  await h.call("PUT", "/settings", migrated);
  const restarted = host(h.data.get(KEY));
  await restarted.activate();
  assert.deepEqual((await restarted.call("GET", "/state")).settings, migrated);
});

test("independent weather, forecast, and metric styles survive saving, reading, and restart", async () => {
  const h = host();
  await h.activate();
  const settings = structuredClone(model.defaults);
  settings.styles.weather = { font: "serif", size: 23, color: "#112233" };
  settings.styles.forecast = { font: "mono", size: 37, color: "#abcdef" };
  settings.styles.metrics = { font: "sans", size: 12, color: "#FEDCBA" };
  assert.deepEqual(
    (await h.call("PUT", "/settings", settings)).settings,
    settings,
  );
  assert.deepEqual((await h.call("GET", "/state")).settings, settings);
  const restarted = host(h.data.get(KEY));
  await restarted.activate();
  assert.deepEqual((await restarted.call("GET", "/state")).settings, settings);
});

test("explicit invalid new styles and missing required weather styles are rejected", async () => {
  const h = host();
  await h.activate();
  for (const field of ["forecast", "metrics"]) {
    for (const invalid of [
      undefined,
      null,
      {},
      { font: "other", size: 18, color: "#ffffff" },
      { font: "sans", size: 7, color: "#ffffff" },
      { font: "sans", size: 161, color: "#ffffff" },
      { font: "sans", size: NaN, color: "#ffffff" },
      { font: "sans", size: 18, color: "white" },
    ]) {
      const settings = structuredClone(model.defaults);
      settings.styles[field] = invalid;
      assert.throws(() => model.validateSettings(settings), new RegExp(field));
      assert.equal((await h.call("PUT", "/settings", settings)).status, 422);
    }
    const settings = structuredClone(model.defaults);
    delete settings.styles[field];
    const other = field === "forecast" ? "metrics" : "forecast";
    settings.styles[other] = { font: "mono", size: 60, color: "#123456" };
    assert.deepEqual(
      model.validateSettings(settings).styles[other],
      settings.styles[other],
    );
  }
  const settings = structuredClone(model.defaults);
  delete settings.styles.weather;
  delete settings.styles.forecast;
  delete settings.styles.metrics;
  assert.throws(() => model.validateSettings(settings), /weather/);
  assert.deepEqual((await h.call("GET", "/state")).settings, model.defaults);
});

test("sky backdrop survives saving, state refresh, and backend restart", async () => {
  const h = host();
  await h.activate();
  const settings = structuredClone(model.defaults);
  settings.appearance.backdrop = "photo";
  settings.appearance.dim = 0.45;
  settings.appearance.showSource = true;
  settings.date.options.era = "short"; // migrate legacy field without losing the chosen backdrop
  const saved = await h.call("PUT", "/settings", settings);
  assert.equal(saved.settings.appearance.backdrop, "photo");
  assert.equal(saved.settings.appearance.dim, 0.45);
  assert.equal(saved.settings.date.options.era, undefined);
  assert.equal(settings.date.options.era, "short"); // validation must not mutate the caller
  assert.equal(
    (await h.call("GET", "/state")).settings.appearance.backdrop,
    "photo",
  );
  const restarted = host(h.data.get(KEY));
  await restarted.activate();
  const state = await restarted.call("GET", "/state");
  assert.equal(state.settings.appearance.backdrop, "photo");
  assert.equal(state.settings.appearance.showSource, true);
});

test("weather normalization preserves valid zeroes and filters optional or malformed fields", () => {
  const result = model.normalizeWeather(fakeWeather(), 1234);
  assert.equal(result.temp, 0);
  assert.equal(result.feelsLike, 0);
  assert.equal(result.windSpeed, 0);
  assert.equal(result.humidity, 0);
  assert.equal(result.location.lat, 0);
  assert.equal(result.location.lon, 0);
  assert.equal(result.pressureMm, null); // zero is outside the documented pressure range
  assert.equal(result.observedAt, 0);
  assert.equal(result.fetchedAt, 1234);
  assert.deepEqual(
    result.forecast.map(
      ({ part, tempMin, tempMax, precipitationProbability }) => [
        part,
        tempMin,
        tempMax,
        precipitationProbability,
      ],
    ),
    [
      ["day", 0, 0, 0],
      ["night", -1, 1, 25],
    ],
  );
  assert.equal(result.sunrise, "07:05");
  assert.equal(result.sunset, "17:20");
  assert.deepEqual(
    model.normalizeWeather({ fact: { temp: 0, condition: "clear" } }).forecast,
    [],
  );
  assert.throws(() =>
    model.normalizeWeather({ fact: { temp: "0", condition: "clear" } }),
  );
  assert.equal(
    model.normalizeWeather({
      fact: { temp: 0, condition: "clear", humidity: 101 },
    }).humidity,
    null,
  );
  for (const date of ["2026-02-30", "2026-99-99", "not-a-date"]) {
    const raw = fakeWeather();
    raw.forecast.date = date;
    assert.deepEqual(model.normalizeWeather(raw).forecast, []);
  }
});

test("plural forecasts accept named part objects and preserve valid forecast fields", () => {
  const result = model.normalizeWeather({
    fact: { temp: 2, condition: "cloudy" },
    forecasts: [
      {
        date: "2026-10-29",
        sunrise: "07:05",
        parts: {
          day: { temp_min: 1, temp_max: 3, condition: "cloudy", prec_prob: 0 },
          night: {
            temp_min: -2,
            temp_max: 0,
            condition: "clear",
            prec_prob: 10,
          },
          unknown: { temp_min: 1, temp_max: 3 },
        },
      },
      {
        date: "2026-10-30",
        parts: {
          evening: {
            temp_min: 4,
            temp_max: 5,
            condition: "clear",
            prec_prob: 100,
          },
        },
      },
    ],
  });
  assert.deepEqual(
    result.forecast.map(
      ({ date, part, tempMin, tempMax, precipitationProbability }) => [
        date,
        part,
        tempMin,
        tempMax,
        precipitationProbability,
      ],
    ),
    [
      ["2026-10-29", "day", 1, 3, 0],
      ["2026-10-29", "night", -2, 0, 10],
      ["2026-10-30", "evening", 4, 5, 100],
    ],
  );
});

test(
  "GET output returns status in the response body without using it as transport status",
  { concurrency: false },
  async () => {
    const h = host();
    await h.activate();
    const result = await h.call("GET", "/output");
    assert.equal(result.status, 200);
    assert.deepEqual(result.body.status, { active: false });
    assert.deepEqual(result.body.screens, []);
  },
);

function clock(
  start = Date.parse("2026-10-30T09:00:00Z"),
  fetch = async () => jsonResponse(fakeWeather()),
) {
  let now = start;
  let id = 0;
  const timers = new Map();
  const requests = [];
  const runtime = {
    now: () => now,
    setTimeout: (callback, delay) => {
      const key = ++id;
      timers.set(key, { at: now + delay, callback });
      return key;
    },
    clearTimeout: (key) => timers.delete(key),
    fetch: async (...args) => {
      requests.push(args);
      return fetch(...args);
    },
  };
  return {
    runtime,
    requests,
    now: () => now,
    async advance(to = now) {
      now = to;
      for (let turn = 0; turn < 100; turn++) {
        const due = [...timers]
          .filter(([, timer]) => timer.at <= now)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        await due[1].callback();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
  };
}

async function source(h, values = {}) {
  const settings = structuredClone((await h.call("GET", "/state")).settings);
  return h.call("PUT", "/settings", {
    ...settings,
    weatherSource: {
      lat: 55.75,
      lon: 37.62,
      dailyLimit: 50,
      useLastResponse: false,
      apiKey: validKey,
      ...values,
    },
  });
}

test("weather source defaults are frozen; source settings persist privately and validate atomically", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  const initial = await h.call("GET", "/state");
  assert.equal(initial.source.dailyLimit, 0);
  assert.equal(initial.source.useLastResponse, true);
  assert.equal(initial.source.hasApiKey, false);
  await c.advance();
  assert.equal(c.requests.length, 0);
  const saved = await source(h, { useLastResponse: true });
  assert.equal(saved.source.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes(validKey), false);
  assert.equal(h.data.get(KEY).source.keys[0].apiKey, validKey);
  const bad = {
    ...structuredClone(saved.settings),
    weatherSource: { ...saved.source, lat: 91 },
  };
  bad.clock.timeZone = "UTC";
  assert.equal((await h.call("PUT", "/settings", bad)).status, 422);
  assert.deepEqual((await h.call("GET", "/state")).settings, saved.settings);
  await source(h, { useLastResponse: true, apiKey: "" });
  assert.equal(h.data.get(KEY).source.keys[0].apiKey, validKey);
  assert.equal(JSON.stringify(h.events).includes(validKey), false);
});

test("live scheduling reserves attempts and spaces remaining requests through Moscow midnight", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h);
  await c.advance();
  assert.equal(c.requests.length, 1);
  const [url, options] = c.requests[0];
  assert.equal(
    new URL(url).origin + new URL(url).pathname,
    "https://api.weather.yandex.ru/v2/informers",
  );
  assert.equal(new URL(url).searchParams.get("lat"), "55.75");
  assert.equal(options.headers["X-Yandex-Weather-Key"], validKey);
  assert.equal(String(url).includes(validKey), false);
  const state = await h.call("GET", "/state");
  const reset = Date.parse("2026-10-30T21:00:00Z");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.remaining, 49);
  assert.equal(state.cache.totalRequests, 1);
  assert.equal(state.cache.resetAt, reset);
  assert.equal(state.cache.nextRequestAt, c.now() + (reset - c.now()) / 50);
  await c.advance(state.cache.nextRequestAt - 1);
  assert.equal(c.requests.length, 1);
  await c.advance(state.cache.nextRequestAt);
  assert.equal(c.requests.length, 2);
  const persisted = h.data.get(KEY);
  assert.equal(persisted.usage.used, 2);
  assert.equal(persisted.usage.total, 2);
  assert.equal(persisted.testResponse.fact.temp, 0);
  assert.equal(
    JSON.stringify(persisted.testResponse).includes("ignored"),
    false,
  );
  assert.equal(
    JSON.stringify(await h.call("GET", "/state")).includes("ignored"),
    false,
  );
});

test("freeze, source edits and restart preserve pacing and counters", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h);
  await c.advance();
  const first = await h.call("GET", "/state");
  await source(h, { useLastResponse: true });
  await source(h, {
    lat: 1,
    lon: 2,
    apiKey: "another-valid-key-1234",
    dailyLimit: 25,
  });
  await c.advance();
  assert.equal(c.requests.length, 1);
  const restartedClock = clock(c.now());
  const restarted = host(h.data.get(KEY), restartedClock.runtime);
  await restarted.activate();
  await restartedClock.advance();
  assert.equal(restartedClock.requests.length, 0);
  const state = await restarted.call("GET", "/state");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.totalRequests, 1);
  assert.ok(state.cache.nextRequestAt >= first.cache.nextRequestAt);
  await restartedClock.advance(state.cache.nextRequestAt);
  assert.equal(restartedClock.requests.length, 1);
});

test("daily budget resets at Moscow midnight while lifetime count survives", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h, { dailyLimit: 1 });
  await c.advance();
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.remaining, 0);
  assert.equal(state.cache.nextRequestAt, state.cache.resetAt);
  await c.advance(state.cache.resetAt - 1);
  assert.equal(c.requests.length, 1);
  await c.advance(state.cache.resetAt);
  assert.equal(c.requests.length, 2);
  const next = await h.call("GET", "/state");
  assert.equal(next.cache.usedToday, 1);
  assert.equal(next.cache.totalRequests, 2);
});

for (const status of [403, 404, 429, 500]) {
  test(`HTTP ${status} counts an attempted request and preserves weather`, async () => {
    const c = clock(undefined, async () => jsonResponse({}, status));
    const h = host(undefined, c.runtime);
    await h.activate();
    const before = (await h.call("GET", "/state")).weather;
    await source(h);
    await c.advance();
    const state = await h.call("GET", "/state");
    assert.deepEqual(state.weather, before);
    assert.equal(
      state.cache.usedToday,
      status === 403 || status === 404 ? 0 : 1,
    );
    assert.equal(state.cache.requestsToday, 1);
    assert.equal(state.cache.totalRequests, 1);
    assert.match(state.cache.message, new RegExp(String(status)));
    if (status === 403 || status === 404 || status === 429) {
      assert.equal(state.cache.nextRequestAt, state.cache.resetAt);
      const restartedClock = clock(c.now());
      const restarted = host(h.data.get(KEY), restartedClock.runtime);
      await restarted.activate();
      await source(restarted, {
        dailyLimit: 100,
        apiKey: validKey,
      });
      await restartedClock.advance(state.cache.resetAt - 1);
      assert.equal(restartedClock.requests.length, 0);
    }
  });
}

test("invalid provider data retains weather and counts attempt without leaking raw response", async () => {
  const c = clock(undefined, async () =>
    jsonResponse({ fact: { temp: "invalid" }, secret: validKey }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  const before = (await h.call("GET", "/state")).weather;
  await source(h);
  await c.advance();
  const state = await h.call("GET", "/state");
  assert.deepEqual(state.weather, before);
  assert.equal(state.cache.usedToday, 1);
  assert.equal(JSON.stringify(state).includes(validKey), false);
});

test("reservation storage failure prevents dispatch and does not consume quota", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h);
  const realSet = h.data.set.bind(h.data);
  h.data.set = () => {
    throw new Error("disk full");
  };
  await c.advance();
  assert.equal(c.requests.length, 0);
  h.data.set = realSet;
  assert.equal((await h.call("GET", "/state")).cache.usedToday, 0);
});

test("concurrent settings updates and pending network dispatch share one reserved attempt", async () => {
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const c = clock(undefined, () => pending);
  const h = host(undefined, c.runtime);
  await h.activate();
  await Promise.all([source(h), source(h)]);
  const dispatched = c.advance();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.requests.length, 1);
  assert.equal(h.data.get(KEY).usage.used, 1);
  assert.equal(h.data.get(KEY).usage.total, 1);
  release(jsonResponse(fakeWeather()));
  await dispatched;
  await c.advance();
  assert.equal(c.requests.length, 1);
});

test("network errors and oversized provider responses retain weather and durable quota", async () => {
  for (const fetch of [
    async () => {
      throw Error("secret transport detail");
    },
    async () => new Response("x".repeat(1024 * 1024 + 1)),
  ]) {
    const c = clock(undefined, fetch);
    const h = host(undefined, c.runtime);
    await h.activate();
    const before = (await h.call("GET", "/state")).weather;
    await source(h);
    await c.advance();
    const state = await h.call("GET", "/state");
    assert.deepEqual(state.weather, before);
    assert.equal(state.cache.usedToday, 1);
    assert.equal(state.cache.totalRequests, 1);
    assert.equal(
      JSON.stringify(state).includes("secret transport detail"),
      false,
    );
  }
});

test("minimum request interval is one minute near the Moscow day boundary", async () => {
  const c = clock(Date.parse("2026-10-30T20:58:00Z"));
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h, { dailyLimit: 10000 });
  await c.advance();
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.nextRequestAt, c.now() + 60000);
  await c.advance(state.cache.nextRequestAt - 1);
  assert.equal(c.requests.length, 1);
});

test("frozen weather resets daily counters and publishes state at Moscow midnight", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h);
  await c.advance();
  await source(h, { useLastResponse: true });
  const before = await h.call("GET", "/state");
  const eventCount = h.events.length;
  await c.advance(before.cache.resetAt);
  assert.equal(c.requests.length, 1);
  assert.equal(h.data.get(KEY).usage.used, 0);
  assert.equal(h.data.get(KEY).usage.total, 1);
  assert.equal(h.data.get(KEY).usage.day, "2026-10-31");
  assert.equal(h.events.length, eventCount + 1);
  assert.equal(h.events.at(-1).value.cache.usedToday, 0);
  assert.equal(h.events.at(-1).value.cache.remaining, 50);
});

test("startup at 09:00 Moscow after an offline night resets quota and resumes immediately", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h, { dailyLimit: 1 });
  await c.advance();
  h.dispose();
  const nextClock = clock(Date.parse("2026-10-31T06:00:00Z"));
  const restarted = host(h.data.get(KEY), nextClock.runtime);
  await restarted.activate();
  const before = await restarted.call("GET", "/state");
  assert.equal(before.cache.usedToday, 0);
  assert.equal(before.cache.totalRequests, 1);
  assert.equal(before.cache.nextRequestAt, nextClock.now());
  await nextClock.advance();
  const after = await restarted.call("GET", "/state");
  assert.equal(nextClock.requests.length, 1);
  assert.equal(after.cache.usedToday, 1);
  assert.equal(after.cache.totalRequests, 2);
});

test("disposal cancels live and frozen timers and prevents future requests and events", async () => {
  for (const live of [false, true]) {
    const c = clock();
    const h = host(undefined, c.runtime);
    await h.activate();
    if (live) await source(h);
    const eventCount = h.events.length;
    h.dispose();
    await c.advance(Date.parse("2026-11-02T06:00:00Z"));
    assert.equal(c.requests.length, 0);
    assert.equal(h.events.length, eventCount);
  }
});

test("disposal during a pending attempt reservation prevents dispatch after storage completes", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h);
  let release;
  h.deferNextSave(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = c.advance();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.requests.length, 0);
  h.dispose();
  release();
  await pending;
  assert.equal(h.data.get(KEY).usage.used, 1);
  assert.equal(c.requests.length, 0);
  await c.advance(Date.parse("2026-11-02T06:00:00Z"));
  assert.equal(c.requests.length, 0);
});

test("disposal during a frozen midnight reset prevents follow-up timers after storage completes", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h);
  await c.advance();
  await source(h, { useLastResponse: true });
  const reset = (await h.call("GET", "/state")).cache.resetAt;
  let release;
  h.deferNextSave(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = c.advance(reset);
  await new Promise((resolve) => setImmediate(resolve));
  h.dispose();
  release();
  await pending;
  assert.equal(h.data.get(KEY).usage.used, 0);
  const events = h.events.length;
  await c.advance(reset + 86400000);
  assert.equal(h.events.length, events);
  assert.equal(c.requests.length, 1);
});

test("raising an exhausted daily limit recomputes pacing without an immediate request", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await source(h, { dailyLimit: 1 });
  await c.advance();
  const exhausted = await h.call("GET", "/state");
  assert.equal(exhausted.cache.nextRequestAt, exhausted.cache.resetAt);
  const raised = await source(h, { dailyLimit: 50 });
  assert.equal(raised.cache.usedToday, 1);
  assert.equal(raised.cache.totalRequests, 1);
  assert.ok(raised.cache.nextRequestAt >= c.now() + 60000);
  assert.ok(raised.cache.nextRequestAt < raised.cache.resetAt);
  await c.advance(raised.cache.nextRequestAt - 1);
  assert.equal(c.requests.length, 1);
  await c.advance(raised.cache.nextRequestAt);
  assert.equal(c.requests.length, 2);
});

const secondKey = "second-fictional-weather-key";
const poolKey = (id, apiKey, type = "auto", dailyLimit = 10) => ({
  id,
  name: `Key ${id}`,
  apiKey,
  type,
  dailyLimit,
});
async function pool(h, keys, extra = {}) {
  const { settings } = await h.call("GET", "/state");
  return h.call("PUT", "/settings", {
    ...structuredClone(settings),
    weatherSource: {
      lat: 55.75,
      lon: 37.62,
      useLastResponse: false,
      keys,
      ...extra,
    },
  });
}

test("pool validates duplicate ids and secrets atomically and retains blank secrets by id", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  const keys = [
    poolKey("a", validKey, "home", 3),
    poolKey("b", secondKey, "site", 7),
  ];
  const saved = await pool(h, keys, { useLastResponse: true });
  assert.equal(saved.source.dailyLimit, 10);
  assert.equal(saved.cache.remaining, 10);
  assert.deepEqual(
    saved.source.keys.map((k) => [k.id, k.type, k.hasApiKey]),
    [
      ["a", "home", true],
      ["b", "site", true],
    ],
  );
  for (const invalid of [
    [keys[0], { ...keys[1], id: "a" }],
    [keys[0], { ...keys[1], apiKey: validKey }],
    Array.from({ length: 11 }, (_, i) =>
      poolKey(`k${i}`, `fictional-weather-key-${i}`),
    ),
    [{ ...keys[0], type: "invalid" }],
  ]) {
    assert.equal((await pool(h, invalid)).status, 422);
    assert.deepEqual((await h.call("GET", "/state")).source, saved.source);
  }
  await pool(
    h,
    [
      { ...keys[1], apiKey: "" },
      { ...keys[0], apiKey: "" },
    ],
    { useLastResponse: true },
  );
  assert.deepEqual(
    h.data.get(KEY).source.keys.map((k) => k.apiKey),
    [secondKey, validKey],
  );
  const exposed = JSON.stringify([
    await h.call("GET", "/state"),
    h.events,
    await h.call("GET", "/themes"),
  ]);
  for (const secret of [validKey, secondKey])
    assert.equal(exposed.includes(secret), false);
  const ledger = Object.keys(h.data.get(KEY).usage.keys || {});
  for (const fingerprint of ledger)
    assert.equal(exposed.includes(fingerprint), false);
  await c.advance();
  assert.equal(c.requests.length, 0);
});

test("manual pool key types use their own endpoint and exhausted keys leave other budgets available", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [
    poolKey("a", validKey, "home", 1),
    poolKey("b", secondKey, "site", 1),
  ]);
  await c.advance();
  assert.equal(new URL(c.requests[0][0]).pathname, "/v2/forecast");
  let state = await h.call("GET", "/state");
  assert.equal(state.cache.remaining, 1);
  assert.equal(state.source.keys.find((k) => k.id === "a").remaining, 0);
  assert.ok(state.cache.nextRequestAt >= c.now() + 60000);
  await c.advance(state.cache.nextRequestAt);
  assert.equal(c.requests.length, 2);
  assert.equal(new URL(c.requests[1][0]).pathname, "/v2/informers");
  assert.equal(c.requests[1][1].headers["X-Yandex-Weather-Key"], secondKey);
  state = await h.call("GET", "/state");
  assert.equal(state.cache.usedToday, 2);
  assert.equal(state.cache.totalRequests, 2);
  assert.equal(state.cache.remaining, 0);
});

for (const status of [401, 403, 404, 429]) {
  test(`HTTP ${status} blocks only its pool key and schedules the other key`, async () => {
    const c = clock(undefined, async (_url, options) =>
      options.headers["X-Yandex-Weather-Key"] === validKey
        ? jsonResponse({}, status)
        : jsonResponse(fakeWeather()),
    );
    const h = host(undefined, c.runtime);
    await h.activate();
    await pool(h, [
      poolKey("a", validKey, "home", 5),
      poolKey("b", secondKey, "site", 5),
    ]);
    await c.advance();
    let state = await h.call("GET", "/state");
    assert.equal(c.requests.length, 1);
    assert.equal(
      state.source.keys.find((k) => k.id === "a").blockedUntil,
      state.cache.resetAt,
    );
    assert.equal(state.source.keys.find((k) => k.id === "b").blockedUntil, 0);
    assert.equal(state.cache.remaining, 5);
    assert.equal(
      state.source.keys.find((k) => k.id === "a").remaining,
      status === 403 || status === 404 ? 5 : 4,
    );
    assert.equal(state.cache.requestsToday, 1);
    assert.ok(state.cache.nextRequestAt < state.cache.resetAt);
    await c.advance(state.cache.nextRequestAt);
    assert.equal(c.requests.length, 2);
    assert.equal(c.requests[1][1].headers["X-Yandex-Weather-Key"], secondKey);
    state = await h.call("GET", "/state");
    assert.equal(state.cache.totalRequests, 2);
    assert.equal(state.cache.remaining, 4);
  });
}

test("auto detection reserves both probes, caches the working type, and survives restart", async () => {
  const response = async (url) =>
    new URL(url).pathname === "/v2/forecast"
      ? jsonResponse({}, 403)
      : jsonResponse(fakeWeather());
  const c = clock(undefined, response);
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [poolKey("a", validKey, "auto", 5)]);
  await c.advance();
  assert.deepEqual(
    c.requests.map(([url]) => new URL(url).pathname),
    ["/v2/forecast", "/v2/informers"],
  );
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.requestsToday, 2);
  assert.equal(state.cache.remaining, 4);
  assert.equal(state.source.keys[0].detectedType, "site");
  assert.equal(state.source.keys[0].totalRequests, 2);
  const publicData = JSON.stringify([
    state,
    h.events,
    await h.call("GET", "/themes"),
  ]);
  assert.equal(publicData.includes(validKey), false);
  const ledger = Object.keys(h.data.get(KEY).usage.keys);
  assert.equal(ledger.length, 1);
  for (const fingerprint of ledger)
    assert.equal(publicData.includes(fingerprint), false);
  h.dispose();
  const next = clock(c.now(), response);
  const restarted = host(h.data.get(KEY), next.runtime);
  await restarted.activate();
  await next.advance(
    (await restarted.call("GET", "/state")).cache.nextRequestAt,
  );
  assert.equal(next.requests.length, 1);
  assert.equal(new URL(next.requests[0][0]).pathname, "/v2/informers");
  assert.equal((await restarted.call("GET", "/state")).cache.totalRequests, 3);
});

test("an auto probe cannot exceed its own budget or fall back for unrelated HTTP failures", async () => {
  for (const [status, limit] of [
    [401, 5],
    [429, 5],
    [500, 5],
  ]) {
    const c = clock(undefined, async () => jsonResponse({}, status));
    const h = host(undefined, c.runtime);
    await h.activate();
    await pool(h, [poolKey("a", validKey, "auto", limit)]);
    await c.advance();
    assert.equal(c.requests.length, 1, `status ${status}, budget ${limit}`);
    assert.equal((await h.call("GET", "/state")).cache.usedToday, 1);
    h.dispose();
  }
});

test("removing, readding, renaming and reordering keys cannot reset durable quota", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [
    poolKey("a", validKey, "home", 4),
    poolKey("b", secondKey, "site", 4),
  ]);
  await c.advance();
  await pool(h, [poolKey("b", secondKey, "site", 4)], {
    useLastResponse: true,
  });
  let state = await h.call("GET", "/state");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.totalRequests, 1);
  await pool(
    h,
    [
      poolKey("b", secondKey, "site", 4),
      poolKey("renamed", validKey, "home", 4),
    ],
    { useLastResponse: true },
  );
  state = await h.call("GET", "/state");
  assert.equal(state.source.keys.find((k) => k.id === "renamed").usedToday, 1);
  assert.equal(state.cache.remaining, 7);
  h.dispose();
  const restarted = host(h.data.get(KEY), clock(c.now()).runtime);
  await restarted.activate();
  state = await restarted.call("GET", "/state");
  assert.equal(state.cache.totalRequests, 1);
  assert.equal(state.source.keys.find((k) => k.id === "renamed").usedToday, 1);
  assert.equal(
    state.source.keys.find((k) => k.id === "renamed").totalRequests,
    1,
  );
});

test("auto HTTP 404 detects site while successful forecast detection is not repeated", async () => {
  for (const [firstStatus, expectedType, paths] of [
    [404, "site", ["/v2/forecast", "/v2/informers"]],
    [200, "home", ["/v2/forecast"]],
  ]) {
    const c = clock(undefined, async (url) =>
      new URL(url).pathname === "/v2/forecast" && firstStatus !== 200
        ? jsonResponse({}, firstStatus)
        : jsonResponse(fakeWeather()),
    );
    const h = host(undefined, c.runtime);
    await h.activate();
    await pool(h, [poolKey("a", validKey, "auto", 10)]);
    await c.advance();
    assert.deepEqual(
      c.requests.map(([url]) => new URL(url).pathname),
      paths,
    );
    let state = await h.call("GET", "/state");
    assert.equal(state.source.keys[0].detectedType, expectedType);
    await c.advance(state.cache.nextRequestAt);
    assert.equal(c.requests.length, paths.length + 1);
    assert.equal(new URL(c.requests.at(-1)[0]).pathname, paths.at(-1));
    state = await pool(h, [poolKey("a", "", "home", 10)]);
    await c.advance(state.cache.nextRequestAt);
    assert.equal(new URL(c.requests.at(-1)[0]).pathname, "/v2/forecast");
    h.dispose();
  }
});

test("legacy single-key configuration migrates without losing previously used quota", async () => {
  const c = clock();
  const h = host(
    {
      version: 1,
      settings: structuredClone(model.defaults),
      source: {
        lat: 55.75,
        lon: 37.62,
        apiKey: validKey,
        dailyLimit: 50,
        useLastResponse: true,
      },
      usage: {
        day: "2026-10-30",
        used: 7,
        total: 19,
        nextRequestAt: c.now() + 60000,
        blockedUntil: 0,
      },
    },
    c.runtime,
  );
  await h.activate();
  const state = await h.call("GET", "/state");
  assert.equal(state.source.keys.length, 1);
  assert.equal(state.source.keys[0].type, "site");
  assert.equal(state.source.keys[0].usedToday, 7);
  assert.equal(state.source.keys[0].totalRequests, 19);
  assert.equal(state.cache.usedToday, 7);
  assert.equal(state.cache.totalRequests, 19);
  assert.equal(state.cache.remaining, 43);
  await c.advance();
  assert.equal(c.requests.length, 0);
});

test("pool pacing uses aggregate budget and selects the largest remaining fraction", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [
    poolKey("b", secondKey, "site", 4),
    poolKey("a", validKey, "home", 2),
  ]);
  await c.advance();
  let state = await h.call("GET", "/state");
  assert.equal(c.requests[0][1].headers["X-Yandex-Weather-Key"], validKey);
  assert.equal(state.source.dailyLimit, 6);
  assert.equal(state.cache.remaining, 5);
  assert.equal(
    state.cache.nextRequestAt,
    c.now() + (state.cache.resetAt - c.now()) / 6,
  );
  for (let i = 0; i < 2; i++) {
    await c.advance(state.cache.nextRequestAt);
    assert.equal(
      c.requests.at(-1)[1].headers["X-Yandex-Weather-Key"],
      secondKey,
    );
    state = await h.call("GET", "/state");
  }
  assert.equal(state.cache.usedToday, 3);
  assert.equal(state.cache.remaining, 3);
  assert.equal(state.source.keys.find((k) => k.id === "a").usedToday, 1);
  assert.equal(state.source.keys.find((k) => k.id === "b").usedToday, 2);
});

test("auto key limit hints pick the initial endpoint without confirming a malformed response", async () => {
  for (const [limit, endpoint, type] of [
    [50, "/v2/informers", "site"],
    [30, "/v2/forecast", "home"],
  ]) {
    const c = clock();
    const h = host(undefined, c.runtime);
    await h.activate();
    await pool(h, [poolKey("a", validKey, "auto", limit)]);
    await c.advance();
    assert.equal(c.requests.length, 1);
    assert.equal(new URL(c.requests[0][0]).pathname, endpoint);
    assert.equal(
      (await h.call("GET", "/state")).source.keys[0].detectedType,
      type,
    );
    h.dispose();
  }
  const c = clock(undefined, async () =>
    jsonResponse({ fact: { temp: "invalid" } }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [poolKey("a", validKey, "auto", 50)]);
  await c.advance();
  assert.equal(c.requests.length, 1);
  assert.equal(
    (await h.call("GET", "/state")).source.keys[0].detectedType,
    null,
  );
});

test("an incorrect site limit hint probes home and caches the confirmed home endpoint", async () => {
  const c = clock(undefined, async (url) =>
    new URL(url).pathname === "/v2/informers"
      ? jsonResponse({}, 403)
      : jsonResponse(fakeWeather()),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [poolKey("a", validKey, "auto", 50)]);
  await c.advance();
  assert.deepEqual(
    c.requests.map(([url]) => new URL(url).pathname),
    ["/v2/informers", "/v2/forecast"],
  );
  let state = await h.call("GET", "/state");
  assert.equal(state.source.keys[0].detectedType, "home");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.requestsToday, 2);
  assert.equal(state.cache.remaining, 49);
  await c.advance(state.cache.nextRequestAt);
  assert.equal(c.requests.length, 3);
  assert.equal(new URL(c.requests.at(-1)[0]).pathname, "/v2/forecast");
});

test("new Moscow day resets all key quotas including removed keys while lifetime counters survive restart", async () => {
  const c = clock();
  const h = host(undefined, c.runtime);
  await h.activate();
  const keys = [
    poolKey("a", validKey, "home", 1),
    poolKey("b", secondKey, "site", 1),
  ];
  await pool(h, keys);
  await c.advance();
  await c.advance((await h.call("GET", "/state")).cache.nextRequestAt);
  await pool(h, [keys[1]], { useLastResponse: true });
  h.dispose();
  const next = clock(Date.parse("2026-10-31T06:00:00Z"));
  const restarted = host(h.data.get(KEY), next.runtime);
  await restarted.activate();
  const state = await pool(restarted, keys, { useLastResponse: true });
  assert.equal(state.cache.usedToday, 0);
  assert.equal(state.cache.totalRequests, 2);
  assert.equal(state.cache.remaining, 2);
  for (const key of state.source.keys) {
    assert.equal(key.usedToday, 0);
    assert.equal(key.totalRequests, 1);
    assert.equal(key.blockedUntil, 0);
  }
  await next.advance();
  assert.equal(next.requests.length, 0);
});

test("ten keys are accepted and eleven are rejected", async () => {
  const h = host();
  await h.activate();
  const keys = Array.from({ length: 10 }, (_, i) =>
    poolKey(`k${i}`, `fictional-weather-key-${i}`),
  );
  assert.equal(
    (await pool(h, keys, { useLastResponse: true })).source.keys.length,
    10,
  );
  assert.equal(
    (await pool(h, [...keys, poolKey("extra", "fictional-extra-key")])).status,
    422,
  );
});

for (const status of [403, 404]) {
  test(`auto HTTP ${status} refunds each probe without spinning or losing lifetime attempts`, async () => {
    const c = clock(undefined, async () => jsonResponse({}, status));
    const h = host(undefined, c.runtime);
    await h.activate();
    await pool(h, [poolKey("a", validKey, "auto", 1)]);
    await c.advance();
    const state = await h.call("GET", "/state");
    assert.equal(c.requests.length, 2);
    assert.equal(state.cache.usedToday, 0);
    assert.equal(state.cache.requestsToday, 2);
    assert.equal(state.cache.totalRequests, 2);
    assert.equal(state.cache.remaining, 0);
    assert.equal(state.source.keys[0].remaining, 1);
    assert.equal(state.source.keys[0].usedToday, 0);
    assert.equal(state.source.keys[0].requestsToday, 2);
    assert.equal(state.cache.nextRequestAt, state.cache.resetAt);
    await c.advance(state.cache.resetAt - 1);
    assert.equal(c.requests.length, 2);
    h.dispose();
    const restarted = host(h.data.get(KEY), clock(c.now()).runtime);
    await restarted.activate();
    const saved = await restarted.call("GET", "/state");
    assert.equal(saved.cache.usedToday, 0);
    assert.equal(saved.cache.totalRequests, 2);
    assert.equal(saved.source.keys[0].remaining, 1);
  });
}

test("refund persistence failure prevents the alternate probe and conservatively retains the reserved quota", async () => {
  let release;
  const c = clock(
    undefined,
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [poolKey("a", validKey, "auto", 5)]);
  const pending = c.advance();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(c.requests.length, 1);
  const realSet = h.data.set.bind(h.data);
  h.data.set = () => {
    throw Error("disk full during refund");
  };
  release(jsonResponse({}, 403));
  await pending;
  h.data.set = realSet;
  assert.equal(c.requests.length, 1);
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.usedToday, 1);
  assert.equal(state.cache.totalRequests, 1);
  assert.equal(h.data.get(KEY).usage.used, 1);
});

test("an old-day rejected response cannot decrement new-day counters", async () => {
  let release;
  const c = clock(
    Date.parse("2026-10-30T20:59:30Z"),
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  await pool(h, [poolKey("a", validKey, "home", 5)]);
  const pending = c.advance();
  await new Promise((resolve) => setImmediate(resolve));
  const reset = (await h.call("GET", "/state")).cache.resetAt;
  await c.advance(reset + 1);
  release(jsonResponse({}, 403));
  await pending;
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.usedToday, 0);
  assert.equal(state.source.keys[0].usedToday, 0);
  assert.equal(state.cache.totalRequests, 1);
  assert.equal(h.data.get(KEY).usage.day, "2026-10-31");
});

const pageSource = (values = {}) => ({
  enabled: true,
  url: "https://yandex.ru/pogoda/ru/moscow",
  intervalMinutes: 15,
  ...values,
});
const pageHtml = () =>
  `<html><script>self.__next_f.push([1,${JSON.stringify(
    `1:${JSON.stringify([
      "$",
      "component",
      null,
      {
        goalPrefix: "main_feedback",
        fact: {
          temperatureInCelsius: 8,
          feelsLikeInCelsius: 5,
          condition: "PARTLY_CLOUDY",
          windSpeedInMetersPerSecond: 2,
          windDirection: "SOUTH",
          pressure: 765,
          humidity: 82,
          daytime: "DAY",
          icon: "skc_d",
        },
      },
    ])}\n`,
  )}]);</script></html>`;
const pageResponse = () =>
  new Response(pageHtml(), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
async function configurePage(h, values = {}) {
  return source(h, {
    keys: [],
    apiKey: undefined,
    page: pageSource(),
    ...values,
  });
}

test("page source defaults are disabled and legacy settings retain page configuration", async () => {
  const h = host();
  await h.activate();
  assert.deepEqual((await h.call("GET", "/state")).source.page, {
    enabled: false,
    url: "",
    intervalMinutes: 15,
  });
  const configured = await configurePage(h, { useLastResponse: true });
  assert.deepEqual(configured.source.page, pageSource());
  const legacy = await source(h, { useLastResponse: true });
  assert.deepEqual(legacy.source.page, pageSource());
});

test("page source validates URL and interval atomically and strips query and fragment", async () => {
  const h = host();
  await h.activate();
  const before = await h.call("GET", "/state");
  for (const url of [
    "http://yandex.ru/pogoda/moscow",
    "https://example.org/pogoda/moscow",
    "https://yandex.ru.evil.example/pogoda/moscow",
    "https://yandex.ru/news",
    "https://user:secret@yandex.ru/pogoda/moscow",
    "https://yandex.ru:8443/pogoda/moscow",
    "https://weather.yandex.ru/pogoda/moscow",
    "https://yandex.ru/pogoda/",
  ]) {
    assert.equal(
      (await configurePage(h, { page: pageSource({ url }) })).status,
      422,
      url,
    );
    assert.deepEqual((await h.call("GET", "/state")).source, before.source);
  }
  for (const intervalMinutes of [0, 1, 4, 1441, 5.5, "15", null]) {
    assert.equal(
      (await configurePage(h, { page: pageSource({ intervalMinutes }) }))
        .status,
      422,
    );
  }
  const accepted = await configurePage(h, {
    useLastResponse: true,
    page: pageSource({
      url: "https://www.yandex.ru/pogoda/moscow?lat=1&lon=2&secret=unused#today",
    }),
  });
  assert.equal(accepted.source.page.url, "https://www.yandex.ru/pogoda/moscow");
  assert.equal(
    (await configurePage(h, { page: pageSource({ enabled: false }) })).status,
    422,
  );
});

test("page-only live source uses configured coordinates without spending API quota", async () => {
  const c = clock(undefined, async () => pageResponse());
  const h = host(undefined, c.runtime);
  await h.activate();
  const configured = await configurePage(h);
  assert.notEqual(configured.status, 422);
  const apiUsage = structuredClone(h.data.get(KEY).usage);
  await c.advance();
  assert.equal(c.requests.length, 1);
  const url = new URL(c.requests[0][0]);
  assert.equal(url.origin, "https://yandex.ru");
  assert.equal(url.searchParams.get("lat"), "55.75");
  assert.equal(url.searchParams.get("lon"), "37.62");
  assert.deepEqual([...url.searchParams.keys()].sort(), ["lat", "lon"]);
  assert.equal(c.requests[0][1].redirect, "error");
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.page.requestsToday, 1);
  assert.equal(state.cache.page.totalRequests, 1);
  assert.equal(state.cache.page.nextRequestAt, c.now() + 15 * 60000);
  assert.equal(state.cache.nextUpdateAt, state.cache.page.nextRequestAt);
  assert.deepEqual(h.data.get(KEY).usage, apiUsage);
  assert.equal(state.weather.temp, 8);
  await h.dispose();
});

test("failed page attempts retain weather, pace retries, and persist across restart", async () => {
  const c = clock(
    undefined,
    async () => new Response("unavailable", { status: 500 }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  const before = (await h.call("GET", "/state")).weather;
  await configurePage(h);
  await c.advance();
  const state = await h.call("GET", "/state");
  assert.deepEqual(state.weather, before);
  assert.equal(state.cache.page.totalRequests, 1);
  assert.ok(state.cache.page.nextRequestAt >= c.now() + 30 * 60000);
  const saved = structuredClone(h.data.get(KEY));
  assert.equal(saved.pageCache.total, 1);
  await h.dispose();
  const nextClock = clock(c.now(), async () => pageResponse());
  const restarted = host(saved, nextClock.runtime);
  await restarted.activate();
  await nextClock.advance(state.cache.page.nextRequestAt - 1);
  assert.equal(nextClock.requests.length, 0);
  await nextClock.advance(state.cache.page.nextRequestAt);
  assert.equal(nextClock.requests.length, 1);
  await restarted.dispose();
});

test("page freeze and interval edits preserve cadence without a catch-up burst", async () => {
  const c = clock(undefined, async () => pageResponse());
  const h = host(undefined, c.runtime);
  await h.activate();
  await configurePage(h);
  await c.advance();
  const firstAt = c.now();
  await configurePage(h, { useLastResponse: true });
  await c.advance(firstAt + 20 * 60000);
  assert.equal(c.requests.length, 1);
  await configurePage(h, { page: pageSource({ intervalMinutes: 60 }) });
  await c.advance();
  assert.equal(c.requests.length, 1);
  assert.equal(
    (await h.call("GET", "/state")).cache.page.nextRequestAt,
    firstAt + 60 * 60000,
  );
  await c.advance(firstAt + 10 * 86400000);
  assert.equal(c.requests.length, 2);
  await c.advance();
  assert.equal(c.requests.length, 2);
  await h.dispose();
});

for (const apiFails of [false, true]) {
  test(`mixed sources prioritize API and ${apiFails ? "fall back immediately after error" : "defer page after success"}`, async () => {
    const c = clock(undefined, async (url) =>
      new URL(url).hostname === "api.weather.yandex.ru"
        ? jsonResponse(apiFails ? {} : fakeWeather(), apiFails ? 500 : 200)
        : pageResponse(),
    );
    const h = host(undefined, c.runtime);
    await h.activate();
    await pool(h, [poolKey("mixed", validKey)], { page: pageSource() });
    await c.advance();
    assert.equal(new URL(c.requests[0][0]).hostname, "api.weather.yandex.ru");
    const state = await h.call("GET", "/state");
    assert.equal(state.source.keys[0].requestsToday, 1);
    assert.equal(state.source.keys[0].totalRequests, 1);
    if (apiFails) {
      assert.equal(c.requests.length, 2);
      assert.equal(state.cache.page.totalRequests, 1);
      assert.equal(state.weather.provider, "yandex-page");
    } else {
      assert.equal(c.requests.length, 1);
      assert.equal(state.cache.page.totalRequests, 0);
      assert.ok(state.cache.page.nextRequestAt >= c.now() + 15 * 60000);
    }
    await h.dispose();
  });
}

test("page attempt counters reset on Moscow midnight while lifetime totals survive", async () => {
  const c = clock(Date.parse("2026-10-30T20:55:00Z"), async () =>
    pageResponse(),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  await configurePage(h, { page: pageSource({ intervalMinutes: 5 }) });
  await c.advance();
  assert.equal((await h.call("GET", "/state")).cache.page.requestsToday, 1);
  await c.advance(Date.parse("2026-10-30T21:00:00Z"));
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.page.requestsToday, 1);
  assert.equal(state.cache.page.totalRequests, 2);
  await h.dispose();
});

for (const [label, response] of [
  ["HTTP 403", () => new Response("Forbidden", { status: 403 })],
  [
    "captcha challenge",
    () =>
      new Response(
        "<html><title>Are you a robot?</title><form action='/checkcaptcha'>captcha</form></html>",
        { headers: { "content-type": "text/html" } },
      ),
  ],
]) {
  test(`page ${label} suspends automatic requests until explicit resume`, async () => {
    const c = clock(undefined, async () => response());
    const h = host(undefined, c.runtime);
    await h.activate();
    await configurePage(h);
    await c.advance();
    const state = await h.call("GET", "/state");
    assert.equal(state.cache.page.suspended, true);
    assert.equal(state.cache.page.nextRequestAt, null);
    await c.advance(c.now() + 2 * 60000);
    assert.equal(c.requests.length, 1);
    const resumed = await h.call("POST", "/weather/page/resume");
    assert.equal(resumed.cache.page.suspended, false);
    assert.equal(
      resumed.cache.page.nextRequestAt,
      state.cache.page.lastAttemptAt + 15 * 60000,
    );
    await c.advance();
    assert.equal(c.requests.length, 1);
    await c.advance(resumed.cache.page.nextRequestAt);
    assert.equal(c.requests.length, 2);
    await h.dispose();
  });
}

test("page 429 honors Retry-After and retains weather without spending API quota", async () => {
  const c = clock(
    undefined,
    async () =>
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "7200" },
      }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  const before = (await h.call("GET", "/state")).weather;
  await configurePage(h);
  await c.advance();
  const state = await h.call("GET", "/state");
  assert.equal(state.cache.page.suspended, false);
  assert.ok(state.cache.page.nextRequestAt >= c.now() + 7200 * 1000);
  assert.deepEqual(state.weather, before);
  assert.equal(state.cache.totalRequests, 0);
  await c.advance(state.cache.page.nextRequestAt - 1);
  assert.equal(c.requests.length, 1);
  await h.dispose();
});

test("page validators support 304 and are dropped after coordinates change", async () => {
  const c = clock(undefined, async (_url, options) => {
    const headers = new Headers(options.headers);
    return headers.has("if-none-match")
      ? new Response(null, { status: 304 })
      : new Response(pageHtml(), {
          headers: {
            "content-type": "text/html",
            etag: '"weather-v1"',
            "last-modified": "Fri, 30 Oct 2026 08:00:00 GMT",
          },
        });
  });
  const h = host(undefined, c.runtime);
  await h.activate();
  await configurePage(h);
  await c.advance();
  const first = await h.call("GET", "/state");
  await c.advance(first.cache.page.nextRequestAt);
  assert.equal(c.requests.length, 2);
  const headers = new Headers(c.requests[1][1].headers);
  assert.equal(headers.get("if-none-match"), '"weather-v1"');
  assert.equal(
    headers.get("if-modified-since"),
    "Fri, 30 Oct 2026 08:00:00 GMT",
  );
  const second = await h.call("GET", "/state");
  assert.equal(second.weather.temp, first.weather.temp);
  assert.equal(second.cache.page.totalRequests, 2);
  await configurePage(h, { lat: 56 });
  const changed = await h.call("GET", "/state");
  await c.advance(changed.cache.page.nextRequestAt);
  const changedHeaders = new Headers(c.requests.at(-1)[1].headers);
  assert.equal(changedHeaders.has("if-none-match"), false);
  assert.equal(changedHeaders.has("if-modified-since"), false);
  await h.dispose();
});

test("unexpected page format retains cached weather and limits probes to once per day across restart and interval edits", async () => {
  const c = clock(
    undefined,
    async () =>
      new Response("<html><body>Weather layout changed</body></html>", {
        headers: { "content-type": "text/html" },
      }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  const before = (await h.call("GET", "/state")).weather;
  await configurePage(h);
  await c.advance();
  const first = await h.call("GET", "/state");
  const firstAttempt = c.now();
  const stored = h.data.get(KEY).pageCache;
  assert.equal(stored.formatChanged, true);
  assert.ok(stored.retryAt >= firstAttempt + 86400000);
  assert.ok(first.cache.page.nextRequestAt >= firstAttempt + 86400000);
  assert.deepEqual(first.weather, before);
  await configurePage(h, { page: pageSource({ intervalMinutes: 5 }) });
  const changed = await h.call("GET", "/state");
  assert.ok(changed.cache.page.nextRequestAt >= firstAttempt + 86400000);
  const saved = structuredClone(h.data.get(KEY));
  await h.dispose();
  const nextClock = clock(firstAttempt, async () => pageResponse());
  const restarted = host(saved, nextClock.runtime);
  await restarted.activate();
  await nextClock.advance(firstAttempt + 86400000 - 1);
  assert.equal(nextClock.requests.length, 0);
  const state = await restarted.call("GET", "/state");
  await nextClock.advance(state.cache.page.nextRequestAt);
  assert.equal(nextClock.requests.length, 1);
  assert.equal((await restarted.call("GET", "/state")).weather.temp, 8);
  assert.equal(restarted.data.get(KEY).pageCache.formatChanged, false);
  await restarted.dispose();
});

const actionId = "a".repeat(42);
const actionAsset =
  "https://weather.yastatic.net/s3/weather-frontend/front2/_next/static/chunks/6998-test.js";
const lightResponse = () =>
  new Response(
    `0:${JSON.stringify({
      data: {
        weather: {
          now: {
            temperatureInCelsius: 12,
            condition: "CLEAR",
            daytime: "DAY",
          },
        },
      },
    })}\n`,
    { headers: { "content-type": "text/x-component" } },
  );
function lightClock(failure) {
  return clock(undefined, async (url, options) => {
    if (String(url) === actionAsset)
      return new Response(
        `createServerReference('${actionId}',null,null,'getMapsUserLocationDataAction');`,
      );
    if (options.method === "POST") return failure ? failure() : lightResponse();
    return new Response(`${pageHtml()}<script src="${actionAsset}"></script>`, {
      headers: { "content-type": "text/html" },
    });
  });
}
test("light page updates discover action once, retain optional weather and refresh full HTML daily", async () => {
  const c = lightClock();
  const h = host(undefined, c.runtime);
  await h.activate();
  await configurePage(h);
  const usage = structuredClone(h.data.get(KEY).usage);
  await c.advance();
  assert.equal(c.requests.length, 2);
  assert.equal(String(c.requests[1][0]), actionAsset);
  const first = await h.call("GET", "/state");
  assert.equal(first.cache.page.totalRequests, 1);
  await c.advance(first.cache.page.nextRequestAt);
  assert.equal(c.requests.length, 3);
  const [url, options] = c.requests[2];
  assert.equal(new URL(url).pathname, "/pogoda/ru/moscow");
  assert.equal(options.method, "POST");
  assert.equal(new Headers(options.headers).get("next-action"), actionId);
  assert.equal(new Headers(options.headers).get("accept"), "text/x-component");
  const [body] = JSON.parse(options.body);
  assert.equal(body.lat, 55.75);
  assert.equal(body.lon, 37.62);
  const light = await h.call("GET", "/state");
  assert.equal(light.weather.temp, 12);
  assert.equal(light.weather.humidity, first.weather.humidity);
  assert.deepEqual(light.weather.forecast, first.weather.forecast);
  assert.equal(light.cache.page.totalRequests, 2);
  assert.deepEqual(h.data.get(KEY).usage, usage);
  await c.advance(first.cache.page.lastAttemptAt + 86400000);
  assert.notEqual(c.requests.at(-1)[1].method, "POST");
  assert.equal((await h.call("GET", "/state")).weather.temp, 8);
  await h.dispose();
});
for (const [label, failure] of [
  ["expired action", () => new Response("Not Found", { status: 404 })],
  [
    "unexpected action response",
    () =>
      new Response("0:{}\n", {
        headers: { "content-type": "text/x-component" },
      }),
  ],
]) {
  test(`${label} pauses light requests for a day without immediate HTML fallback`, async () => {
    const c = lightClock(failure);
    const h = host(undefined, c.runtime);
    await h.activate();
    await configurePage(h);
    await c.advance();
    const first = await h.call("GET", "/state");
    await c.advance(first.cache.page.nextRequestAt);
    assert.equal(c.requests.length, 3);
    const failed = await h.call("GET", "/state");
    assert.deepEqual(failed.weather, first.weather);
    assert.equal(h.data.get(KEY).pageCache.formatChanged, true);
    assert.ok(failed.cache.page.nextRequestAt >= c.now() + 86400000);
    await c.advance(c.now() + 3600000);
    assert.equal(c.requests.length, 3);
    await h.dispose();
  });
}

for (const [label, body] of [
  [
    "out-of-range temperature",
    () =>
      pageHtml().replace(
        'temperatureInCelsius\\\":8',
        'temperatureInCelsius\\\":999',
      ),
  ],
  [
    "missing condition",
    () =>
      pageHtml().replace(
        'condition\\\":\\\"PARTLY_CLOUDY\\\"',
        'unusedCondition\\\":\\\"PARTLY_CLOUDY\\\"',
      ),
  ],
  ["oversized response", () => "x".repeat(4 * 1024 * 1024 + 1)],
]) {
  test(`page ${label} preserves weather and waits a day for a format probe`, async () => {
    const responseBody = body();
    if (label === "out-of-range temperature")
      assert.ok(responseBody.includes("999"));
    if (label === "missing condition")
      assert.ok(responseBody.includes("unusedCondition"));
    const c = clock(
      undefined,
      async () =>
        new Response(responseBody, {
          headers: { "content-type": "text/html" },
        }),
    );
    const h = host(undefined, c.runtime);
    await h.activate();
    const before = (await h.call("GET", "/state")).weather;
    await configurePage(h);
    await c.advance();
    const state = await h.call("GET", "/state");
    assert.deepEqual(state.weather, before);
    assert.equal(h.data.get(KEY).pageCache.formatChanged, true);
    assert.ok(state.cache.page.nextRequestAt >= c.now() + 86400000);
    await c.advance(c.now() + 3600000);
    assert.equal(c.requests.length, 1);
    await h.dispose();
  });
}

test("page resume is harmless without a configured live page source", async () => {
  const c = clock(undefined, async () => pageResponse());
  const h = host(undefined, c.runtime);
  await h.activate();
  await h.call("POST", "/weather/page/resume");
  await c.advance();
  assert.equal(c.requests.length, 0);
  await configurePage(h, { useLastResponse: true });
  await h.call("POST", "/weather/page/resume");
  await c.advance();
  assert.equal(c.requests.length, 0);
  await h.dispose();
});

test("missing action discovery is cached for a day while valid HTML weather continues updating", async () => {
  const c = clock(undefined, async (url) =>
    String(url) === actionAsset
      ? new Response("/* No weather action in this build. */")
      : new Response(`${pageHtml()}<script src="${actionAsset}"></script>`, {
          headers: { "content-type": "text/html" },
        }),
  );
  const h = host(undefined, c.runtime);
  await h.activate();
  await configurePage(h);
  const usage = structuredClone(h.data.get(KEY).usage);
  await c.advance();
  assert.equal(c.requests.length, 2);
  const first = await h.call("GET", "/state");
  assert.equal(first.weather.temp, 8);
  assert.equal(h.data.get(KEY).pageCache.formatChanged, false);
  assert.equal(first.cache.page.totalRequests, 1);
  await c.advance(first.cache.page.nextRequestAt);
  assert.equal(c.requests.length, 3);
  assert.notEqual(c.requests[2][1].method, "POST");
  assert.notEqual(String(c.requests[2][0]), actionAsset);
  const next = await h.call("GET", "/state");
  assert.equal(next.weather.temp, 8);
  assert.equal(next.cache.page.totalRequests, 2);
  assert.equal(h.data.get(KEY).pageCache.formatChanged, false);
  assert.deepEqual(h.data.get(KEY).usage, usage);
  await h.dispose();
});

test("explicit resume after expired action reboots from full HTML instead of repeating stale POST", async () => {
  const c = lightClock(() => new Response("Not Found", { status: 404 }));
  const h = host(undefined, c.runtime);
  await h.activate();
  await configurePage(h);
  await c.advance();
  const first = await h.call("GET", "/state");
  await c.advance(first.cache.page.nextRequestAt);
  assert.equal(c.requests.at(-1)[1].method, "POST");
  assert.equal(h.data.get(KEY).pageCache.formatChanged, true);
  const resumed = await h.call("POST", "/weather/page/resume");
  assert.equal(h.data.get(KEY).pageCache.actionId, "");
  const previousLength = c.requests.length;
  await c.advance(resumed.cache.page.nextRequestAt);
  const [url, options] = c.requests[previousLength];
  assert.equal(new URL(url).hostname, "yandex.ru");
  assert.notEqual(options.method, "POST");
  const state = await h.call("GET", "/state");
  assert.equal(state.weather.temp, 8);
  assert.equal(h.data.get(KEY).pageCache.formatChanged, false);
  await h.dispose();
});
