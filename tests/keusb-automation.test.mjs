import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  validateJob,
  validateRule,
  validateOutputs,
  due,
  luxMatch,
} = require("../plugins/keusb-24r/dist/lib/automation.cjs");
const input = {
  id: "test",
  name: "Свет",
  enabled: true,
  target: "all",
  outputs: { 1: true, 2: false },
  kind: "daily",
  event: "time",
  time: "18:30",
};
const environment = {
  timeZone: "Europe/Moscow",
  solar: { sunset: "2026-11-02T14:30:00Z" },
};
test("validates and sanitizes jobs and output selections", () => {
  assert.deepEqual(validateOutputs({ 1: true }), { 1: true });
  assert.equal(validateJob({ ...input, secret: "drop" }).secret, undefined);
  for (const outputs of [{}, { 0: true }, { 5: true }, { 1: 1 }, []])
    assert.throws(() => validateOutputs(outputs));
  for (const override of [
    { enabled: 1 },
    { time: "24:00" },
    { event: "other" },
    { kind: "once", date: "2026-02-30" },
    { event: "sunset", offsetMinutes: 1.5 },
  ])
    assert.throws(() => validateJob({ ...input, ...override }));
});
test("daily runs in host timezone once per calendar date, without replay", () => {
  const job = validateJob(input);
  const now = Date.parse("2026-11-02T15:30:10Z");
  assert.equal(due(job, now, environment), "test:2026-11-02");
  assert.equal(due(job, now, environment, "test:2026-11-02"), null);
  assert.equal(due(job, now + 60000, environment), null);
  assert.equal(due(job, now, { timeZone: "invalid" }), null);
  assert.equal(due({ ...job, enabled: false }, now, environment), null);
});
test("once job requires correct local date", () => {
  const job = validateJob({ ...input, kind: "once", date: "2026-11-02" });
  assert.ok(due(job, Date.parse("2026-11-02T15:30:00Z"), environment));
  assert.equal(due(job, Date.parse("2026-11-03T15:30:00Z"), environment), null);
});
test("DST repeated wall clock does not run twice", () => {
  const job = validateJob({ ...input, time: "01:30" });
  const env = { timeZone: "America/New_York" };
  const key = due(job, Date.parse("2026-11-01T05:30:00Z"), env);
  assert.ok(key);
  assert.equal(due(job, Date.parse("2026-11-01T06:30:00Z"), env, key), null);
});
test("solar offsets, missing/polar events and midnight crossing", () => {
  const job = validateJob({ ...input, event: "sunset", offsetMinutes: 60 });
  assert.ok(due(job, Date.parse("2026-11-02T15:30:00Z"), environment));
  assert.equal(due(job, Date.parse("2026-11-02T15:29:59Z"), environment), null);
  assert.equal(due(job, Date.parse("2026-11-02T15:31:00Z"), environment), null);
  assert.equal(due(job, Date.now(), { timeZone: "UTC", solar: {} }), null);
  const midnight = {
    timeZone: "UTC",
    solar: { sunset: "2026-11-02T23:30:00Z" },
  };
  assert.equal(
    due(job, Date.parse("2026-11-03T00:30:00Z"), midnight),
    "test:2026-11-02",
  );
});
test("lux thresholds, hysteresis, stale and invalid readings", () => {
  const rule = validateRule({
    ...input,
    sensorId: "lux",
    operator: "lt",
    max: 100,
    hysteresis: 10,
  });
  const now = Date.parse("2026-11-02T12:00:00Z");
  const sensor = { id: "lux", lux: 105, updatedAt: now };
  assert.equal(luxMatch(rule, sensor, false, now), false);
  assert.equal(luxMatch(rule, sensor, true, now), true);
  assert.equal(luxMatch(rule, { ...sensor, lux: 110 }, true, now), false);
  assert.equal(
    luxMatch(rule, { ...sensor, updatedAt: now - 120001 }, true, now),
    null,
  );
  assert.equal(
    luxMatch(rule, { ...sensor, updatedAt: now + 6000 }, true, now),
    null,
  );
  assert.equal(luxMatch(rule, { ...sensor, lux: NaN }, false, now), null);
  assert.equal(luxMatch(rule, { ...sensor, id: "wrong" }, false, now), null);
  const between = validateRule({
    ...rule,
    operator: "between",
    min: 100,
    max: 200,
  });
  assert.equal(luxMatch(between, { ...sensor, lux: 95 }, true, now), true);
  assert.equal(luxMatch(between, { ...sensor, lux: 95 }, false, now), false);
  assert.throws(() => validateRule({ ...between, min: 201 }));
});

test("solarDays supports previous-day offset with current day unavailable", () => {
  const job = validateJob({
    ...input,
    kind: "once",
    date: "2026-11-02",
    event: "sunset",
    offsetMinutes: 120,
  });
  const env = {
    timeZone: "UTC",
    solar: {},
    solarDays: [
      { sunset: "2026-11-02T23:00:00Z" },
      {},
      { sunset: "2026-11-04T23:00:00Z" },
    ],
  };
  const now = Date.parse("2026-11-03T01:00:10Z");
  assert.equal(due(job, now, env), "test:2026-11-02");
  assert.equal(due(job, now, env, "test:2026-11-02"), null);
  const negative = validateJob({
    ...input,
    event: "sunrise",
    offsetMinutes: -120,
  });
  assert.equal(
    due(negative, Date.parse("2026-11-02T23:00:00Z"), {
      timeZone: "UTC",
      solarDays: [{ sunrise: "2026-11-03T01:00:00Z" }],
    }),
    "test:2026-11-03",
  );
});
