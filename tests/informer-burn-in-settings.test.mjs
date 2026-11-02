import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  defaults,
  validateSettings,
} = require("../plugins/informer/dist/model.cjs");
const { activate } = require("../plugins/informer/dist/main.cjs");
const fields = [
  "burnInProtection",
  "burnInDistance",
  "burnInSpeed",
];

test("legacy settings migrate protection without resetting appearance", () => {
  const legacy = structuredClone(defaults);
  for (const field of fields) delete legacy.appearance[field];
  legacy.appearance.sourceSize = 31;
  legacy.clock.timeZone = "UTC";
  const migrated = validateSettings(legacy);
  assert.equal(migrated.appearance.sourceSize, 31);
  assert.equal(migrated.clock.timeZone, "UTC");
  for (const field of fields)
    assert.equal(migrated.appearance[field], defaults.appearance[field]);
});

test("protection validates independent discrete levels and explicit booleans", () => {
  for (const field of ["burnInDistance", "burnInSpeed"]) {
    for (const value of [0, 6, 1.5, "2", null, NaN, Infinity]) {
      const settings = structuredClone(defaults);
      settings.appearance[field] = value;
      assert.throws(() => validateSettings(settings), /защиты от выгорания/);
    }
    for (const value of [1, 2, 5]) {
      const settings = structuredClone(defaults);
      settings.appearance[field] = value;
      assert.equal(validateSettings(settings).appearance[field], value);
    }
  }
  for (const field of ["burnInProtection"]) {
    const settings = structuredClone(defaults);
    settings.appearance[field] = "false";
    assert.throws(() => validateSettings(settings), /защиты от выгорания/);
    settings.appearance[field] = false;
    assert.equal(validateSettings(settings).appearance[field], false);
  }
});

test("protection settings survive API save and backend restart", async () => {
  let saved;
  const boot = async () => {
    const routes = new Map();
    await activate({
      storage: {
        get: async () => saved,
        set: async (_, value) => {
          saved = structuredClone(value);
        },
      },
      http: {
        ...Object.fromEntries(
          ["get", "post", "put", "delete"].map((method) => [
            method,
            (path, fn) => routes.set(`${method} ${path}`, fn),
          ]),
        ),
        response: (status, body) => ({ status, body }),
      },
      events: { publish() {} },
      logger: { warn() {} },
    });
    return (method, path, body) => routes.get(`${method} ${path}`)({ body });
  };
  const call = await boot();
  const settings = structuredClone(defaults);
  Object.assign(settings.appearance, {
    burnInProtection: false,
    burnInDistance: 5,
    burnInSpeed: 1,
    burnInDemo: true,
  });
  const result = await call("put", "/settings", settings);
  assert.ok(result.settings);
  assert.equal(Object.hasOwn(result.settings.appearance, "burnInDemo"), false);
  assert.equal(Object.hasOwn(saved.settings.appearance, "burnInDemo"), false);
  const restarted = await boot();
  const state = await restarted("get", "/state");
  for (const field of fields)
    assert.equal(state.settings.appearance[field], settings.appearance[field]);
});
