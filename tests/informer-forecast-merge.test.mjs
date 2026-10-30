import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import fs from "node:fs";
import vm from "node:vm";
const require = createRequire(import.meta.url);
const {
  mergeForecast,
  restoreForecastCache,
} = require("../plugins/informer/dist/weather-forecast.cjs");
const {
  normalizeWeather,
  defaults,
  restoreWeather,
} = require("../plugins/informer/dist/model.cjs");
const visuals = { module: { exports: {} } };
vm.runInNewContext(
  fs.readFileSync(
    new URL("../plugins/informer/public/weather-visuals.js", import.meta.url),
    "utf8",
  ),
  visuals,
);
const at = Date.parse("2026-10-30T09:00:00Z");
const part = (date, name, min, max) => ({
  date,
  part: name,
  tempMin: min,
  tempMax: max,
  condition: "clear",
  daytime: "d",
  precipitationProbability: null,
});
const base = normalizeWeather(
  { info: { lat: 56, lon: 47 }, fact: { temp: 9, condition: "clear" } },
  at,
);
const api = {
  ...base,
  forecast: [
    part("2026-10-30", "day", 7, 12),
    part("2026-10-30", "evening", 4, 6),
  ],
  forecastSource: "api",
};
const page = {
  ...base,
  forecast: [
    part("2026-10-30", "day", 6, 13),
    part("2026-10-30", "evening", 3, 7),
    part("2026-10-31", "night", 1, 3),
    part("2026-10-31", "morning", 0, 8),
  ],
  forecastSource: "page",
};
const record = () => ({
  settings: structuredClone(defaults),
  source: { keys: [{ apiKey: "key" }], page: { enabled: true } },
  weather: structuredClone(base),
  forecastCache: { api: null, page: null },
});
const apply = (r, w, source, full = false) => ({
  ...r,
  ...mergeForecast(r, w, source, full, at),
});
for (const first of ["api", "page"])
  test(`missing API night is filled from page with ${first} first`, () => {
    let r = record();
    r =
      first === "api"
        ? apply(apply(r, api, "api"), page, "page", true)
        : apply(apply(r, page, "page", true), api, "api");
    const next = Array.from(
      visuals.module.exports.nextForecast(
        r.weather.forecast,
        new Date(at),
        "Europe/Moscow",
      ),
    );
    assert.deepEqual(next, [api.forecast[1], page.forecast[2]]);
    assert.equal(r.weather.forecastSource, "api");
    assert.deepEqual(r.forecastCache.api, api);
    assert.deepEqual(r.forecastCache.page, page);
  });
test("restart and light updates retain independent forecast caches and API fields", () => {
  let r = apply(apply(record(), api, "api"), page, "page", true);
  r = {
    ...r,
    weather: restoreWeather(r.weather),
    forecastCache: restoreForecastCache(r.forecastCache, r.weather),
  };
  const before = structuredClone(r.forecastCache);
  r = apply(r, { ...r.weather, temp: 10 }, "page");
  assert.equal(r.weather.temp, 10);
  assert.deepEqual(r.forecastCache, before);
  assert.deepEqual(r.weather.forecast[1], api.forecast[1]);
  r.source.keys = [];
  r = apply(r, { ...r.weather, temp: 11 }, null);
  assert.deepEqual(r.weather.forecast, page.forecast);
  assert.equal(r.weather.forecastSource, "page");
});
test("wrong location and expired API cannot override page forecast", () => {
  for (const broken of [
    { ...api, location: { lat: 1, lon: 2 } },
    {
      ...api,
      forecast: api.forecast.map((p) => ({ ...p, date: "2026-10-29" })),
    },
  ]) {
    const r = apply(apply(record(), broken, "api"), page, "page", true);
    assert.deepEqual(r.weather.forecast, page.forecast);
    assert.equal(r.weather.forecastSource, "page");
  }
});
test("new API response replaces omitted periods so original page value returns", () => {
  let r = apply(apply(record(), page, "page", true), api, "api");
  r = apply(r, { ...api, forecast: [api.forecast[0]] }, "api");
  assert.deepEqual(r.weather.forecast[1], page.forecast[1]);
  assert.equal(
    new Set(r.weather.forecast.map((p) => `${p.date}/${p.part}`)).size,
    r.weather.forecast.length,
  );
});
test("cache restore handles independent corruption and legacy API provenance", () => {
  assert.deepEqual(restoreForecastCache({ api: {}, page }, base), {
    api: null,
    page,
  });
  assert.deepEqual(
    restoreForecastCache(undefined, { ...api, provider: "yandex-page" }).api,
    { ...api, provider: "yandex-page" },
  );
});

test("legacy unmarked page and API snapshots restore by provider without promoting the bundled sample", () => {
  for (const [provider, source] of [
    ["yandex-page", "page"],
    ["yandex-informers", "api"],
    ["yandex-forecast", "api"],
  ]) {
    const weather = { ...base, provider, forecast: page.forecast };
    assert.deepEqual(restoreForecastCache(undefined, weather)[source], weather);
  }
  assert.deepEqual(
    restoreForecastCache(undefined, {
      ...base,
      provider: "yandex-informers",
      fetchedAt: 0,
    }),
    { api: null, page: null },
  );
});
