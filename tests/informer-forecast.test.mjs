import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
const sandbox = { module: { exports: {} } };
vm.runInNewContext(
  fs.readFileSync(
    new URL("../plugins/informer/public/weather-visuals.js", import.meta.url),
    "utf8",
  ),
  sandbox,
);
const { nextForecast } = sandbox.module.exports;
const forecast = ["2026-10-30", "2026-10-31"].flatMap((date) =>
  ["morning", "day", "evening", "night"].map((part) => ({
    date,
    part,
    tempMin: 3,
    tempMax: 7,
  })),
);
const select = (time, input = forecast, zone = "Europe/Moscow") =>
  Array.from(
    nextForecast(input, new Date(time), zone),
    (p) => `${p.date}/${p.part}`,
  );
for (const [time, expected] of [
  ["2026-10-30T02:59:59Z", ["2026-10-30/morning", "2026-10-30/day"]],
  ["2026-10-30T03:00:00Z", ["2026-10-30/day", "2026-10-30/evening"]],
  ["2026-10-30T08:35:00Z", ["2026-10-30/day", "2026-10-30/evening"]],
  ["2026-10-30T09:00:00Z", ["2026-10-30/evening", "2026-10-31/night"]],
  ["2026-10-30T15:00:00Z", ["2026-10-31/night", "2026-10-31/morning"]],
  ["2026-10-30T21:00:00Z", ["2026-10-31/morning", "2026-10-31/day"]],
])
  test(`next forecast excludes current period at ${time}`, () =>
    assert.deepEqual(select(time), expected));
test("forecast selection uses the configured timezone and sorts without mutating provider data", () => {
  const input = structuredClone(forecast).reverse();
  const before = structuredClone(input);
  assert.deepEqual(select("2026-10-30T09:00:00Z", input, "UTC"), [
    "2026-10-30/day",
    "2026-10-30/evening",
  ]);
  assert.deepEqual(input, before);
});
test("stale forecasts are not repeated and duplicate periods do not fill both slots", () => {
  assert.deepEqual(select("2026-11-01T09:00:00Z"), []);
  const day = forecast.find((p) => p.part === "day");
  assert.deepEqual(select("2026-10-30T03:00:00Z", [day, day]), [
    "2026-10-30/day",
  ]);
});
test("next night and morning cross year boundary", () => {
  const input = ["night", "morning"].map((part) => ({
    date: "2027-01-01",
    part,
  }));
  assert.deepEqual(select("2026-12-31T18:00:00Z", input), [
    "2027-01-01/night",
    "2027-01-01/morning",
  ]);
});
