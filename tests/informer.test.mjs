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
  assert.equal(initial.source.dailyLimit, 50);
  assert.equal(initial.source.useLastResponse, true);
  assert.equal(initial.source.hasApiKey, false);
  await c.advance();
  assert.equal(c.requests.length, 0);
  const saved = await source(h, { useLastResponse: true });
  assert.equal(saved.source.hasApiKey, true);
  assert.equal(JSON.stringify(saved).includes(validKey), false);
  assert.equal(h.data.get(KEY).source.apiKey, validKey);
  const bad = {
    ...structuredClone(saved.settings),
    weatherSource: { ...saved.source, lat: 91 },
  };
  bad.clock.timeZone = "UTC";
  assert.equal((await h.call("PUT", "/settings", bad)).status, 422);
  assert.deepEqual((await h.call("GET", "/state")).settings, saved.settings);
  await source(h, { useLastResponse: true, apiKey: "" });
  assert.equal(h.data.get(KEY).source.apiKey, validKey);
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

for (const status of [403, 429, 500]) {
  test(`HTTP ${status} counts an attempted request and preserves weather`, async () => {
    const c = clock(undefined, async () => jsonResponse({}, status));
    const h = host(undefined, c.runtime);
    await h.activate();
    const before = (await h.call("GET", "/state")).weather;
    await source(h);
    await c.advance();
    const state = await h.call("GET", "/state");
    assert.deepEqual(state.weather, before);
    assert.equal(state.cache.usedToday, 1);
    assert.equal(state.cache.totalRequests, 1);
    assert.match(state.cache.message, new RegExp(String(status)));
    if (status === 403 || status === 429) {
      assert.equal(state.cache.nextRequestAt, state.cache.resetAt);
      const restartedClock = clock(c.now());
      const restarted = host(h.data.get(KEY), restartedClock.runtime);
      await restarted.activate();
      await source(restarted, {
        dailyLimit: 100,
        apiKey: "another-valid-key-1234",
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
