import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  normalizeWeather,
  restoreWeather,
} = require("../plugins/informer/dist/model.cjs");
const sample = JSON.parse(
  fs.readFileSync(
    new URL("../plugins/informer/dist/sample.json", import.meta.url),
    "utf8",
  ),
);
const part = (part_name) => ({
  part_name,
  temp_min: 1,
  temp_max: 3,
  condition: "clear",
});
const dates = (weather) => weather.forecast.map(({ date }) => date);

for (const [date, next] of [
  ["2026-10-29", "2026-10-30"],
  ["2026-10-31", "2026-11-01"],
  ["2026-12-31", "2027-01-01"],
  ["2028-02-29", "2028-03-01"],
]) {
  test(`informers evening/night crosses calendar boundary from ${date}`, () => {
    const raw = structuredClone(sample);
    raw.forecast.date = date;
    assert.deepEqual(
      raw.forecast.parts.map(({ part_name }) => part_name),
      ["evening", "night"],
    );
    assert.deepEqual(dates(normalizeWeather(raw)), [date, next]);
  });
}

test("informers retains the supplied date when night is the first period", () => {
  const raw = structuredClone(sample);
  raw.forecast.parts = [part("night"), part("morning")];
  assert.deepEqual(dates(normalizeWeather(raw)), [
    raw.forecast.date,
    raw.forecast.date,
  ]);
});

for (const shape of ["array", "object"]) {
  test(`home/page calendar forecasts retain dates for ${shape} parts`, () => {
    const raw = structuredClone(sample);
    raw.forecasts = ["2026-12-31", "2027-01-01"].map((date) => ({
      date,
      parts:
        shape === "array"
          ? [part("evening"), part("night")]
          : { evening: part("evening"), night: part("night") },
    }));
    const weather = normalizeWeather(raw);
    assert.deepEqual(dates(weather), [
      "2026-12-31",
      "2026-12-31",
      "2027-01-01",
      "2027-01-01",
    ]);
    for (const provider of ["yandex-forecast", "yandex-page"]) {
      weather.provider = provider;
      assert.deepEqual(restoreWeather(weather), weather);
    }
  });
}

test("restoring informers cache preserves its already normalized dates", () => {
  const weather = normalizeWeather(sample);
  assert.deepEqual(restoreWeather(weather), weather);
});
