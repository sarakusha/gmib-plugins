import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { activate } = require("../plugins/informer/dist/main.cjs");
const { defaults } = require("../plugins/informer/dist/model.cjs");
const KEY = "informer.v1";
const file = (name = "Тема", settings = structuredClone(defaults)) => ({
  format: "gmib-informer-theme",
  version: 1,
  name,
  settings,
});
async function host(saved) {
  const routes = new Map(),
    events = [];
  let record = structuredClone(saved),
    fail = false;
  await activate({
    storage: {
      get: async () => record,
      set: async (_, next) => {
        await new Promise((resolve) => setImmediate(resolve));
        if (fail) throw new Error("disk full");
        record = structuredClone(next);
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
    events: { publish: (event, value) => events.push({ event, value }) },
    logger: { warn() {} },
  });
  return {
    call: (method, path, body) => routes.get(`${method} ${path}`)({ body }),
    saved: () => record,
    events,
    fail: (value) => {
      fail = value;
    },
  };
}

test("themes persist independently through settings/weather writes and restart without fetching", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("unexpected fetch");
  };
  try {
    const h = await host();
    const input = file("  Cafe\u0301  ");
    input.settings.clock.timeZone = "UTC";
    input.settings.apiKey = "secret";
    input.settings.output = { screenId: 44 };
    const saved = await h.call("post", "/themes", input);
    assert.equal(saved.theme.name, "Café");
    assert.equal(saved.theme.settings.clock.timeZone, "UTC");
    assert.equal(saved.theme.settings.apiKey, undefined);
    assert.equal(saved.theme.settings.output, undefined);
    saved.themes[0].name = "mutated";
    await h.call("put", "/settings", structuredClone(defaults));
    await h.call("put", "/settings", {
      ...structuredClone(defaults),
      weatherSource: { lat: 1, lon: 2, dailyLimit: 25, useLastResponse: true },
    });
    const restarted = await host(h.saved());
    assert.deepEqual((await restarted.call("get", "/themes")).themes, [
      { name: "Café", settings: saved.theme.settings },
    ]);
    assert.equal(
      (await restarted.call("get", "/state")).settings.clock.timeZone,
      defaults.clock.timeZone,
    );
    assert.equal((await restarted.call("get", "/state")).source.lat, 1);
    assert.equal(saved.theme.settings.weatherSource, undefined);
    assert.equal(JSON.stringify(h.saved()).includes("secret"), false);
    assert.equal(h.events.length, 3);
    assert.equal(
      (await restarted.call("delete", "/themes", { name: " Cafe\u0301 " }))
        .themes.length,
      0,
    );
    assert.equal(
      (await (await host(restarted.saved())).call("get", "/themes")).themes
        .length,
      0,
    );
  } finally {
    globalThis.fetch = original;
  }
});

test("theme imports require exact format/version, valid settings and bounded names", async () => {
  const h = await host();
  for (const value of [
    null,
    [],
    {},
    { ...file(), format: "other" },
    { ...file(), version: "1" },
    { ...file(), version: 2 },
    { ...file(), settings: {} },
    ...[
      "",
      "  ",
      "a".repeat(81),
      "a\nb",
      "\u0000",
      "\u007f",
      "\u0085",
      "\u200b",
    ].map((name) => file(name)),
  ]) {
    assert.equal((await h.call("post", "/themes", value)).status, 422);
  }
  for (const name of [null, "", "\n"])
    assert.equal((await h.call("delete", "/themes", { name })).status, 422);
  assert.deepEqual(await h.call("get", "/themes"), { themes: [] });
  assert.equal(
    (await h.call("post", "/themes", file("a".repeat(80)))).theme.name.length,
    80,
  );
});

test("50-theme limit permits normalized replacement and deletion frees a slot", async () => {
  const h = await host();
  await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      h.call("post", "/themes", file(`theme${i}`)),
    ),
  );
  assert.equal((await h.call("post", "/themes", file("extra"))).status, 409);
  const replacement = file(" theme0 ");
  replacement.settings.appearance.dim = 1;
  const result = await h.call("post", "/themes", replacement);
  assert.equal(result.themes.length, 50);
  assert.equal(result.themes[0].settings.appearance.dim, 1);
  await h.call("delete", "/themes", { name: "theme0" });
  assert.equal(
    (await h.call("post", "/themes", file("extra"))).themes.length,
    50,
  );
});

test("restore filters invalid entries individually, normalizes duplicates, and caps catalog", async () => {
  const duplicate = file(" Cafe\u0301 ");
  duplicate.settings.appearance.dim = 1;
  const h = await host({
    version: 1,
    themes: [
      file("Café"),
      null,
      file("bad", {}),
      duplicate,
      ...Array.from({ length: 55 }, (_, i) => file(`theme${i}`)),
    ],
  });
  const { themes } = await h.call("get", "/themes");
  assert.equal(themes.length, 50);
  assert.equal(themes[0].name, "Café");
  assert.equal(themes[0].settings.appearance.dim, 1);
});

test("failed persistence preserves catalog and events; queued writes keep latest settings and themes", async () => {
  const h = await host();
  await h.call("post", "/themes", file());
  const before = structuredClone(h.saved());
  const count = h.events.length;
  h.fail(true);
  assert.equal((await h.call("post", "/themes", file("new"))).status, 500);
  assert.equal(
    (await h.call("delete", "/themes", { name: "Тема" })).status,
    500,
  );
  assert.deepEqual(h.saved(), before);
  assert.equal(h.events.length, count);
  assert.equal((await h.call("get", "/themes")).themes.length, 1);
  h.fail(false);
  const settings = structuredClone(defaults);
  settings.appearance.dim = 0.7;
  await Promise.all([
    h.call("post", "/themes", file("new")),
    h.call("put", "/settings", settings),
    h.call("put", "/settings", {
      ...settings,
      weatherSource: {
        lat: 3,
        lon: 4,
        dailyLimit: 12,
        useLastResponse: true,
        apiKey: "fictional-theme-test-key",
      },
    }),
  ]);
  assert.equal(h.saved().themes.length, 2);
  assert.equal(h.saved().settings.appearance.dim, 0.7);
  assert.equal(h.saved().source.lat, 3);
  assert.equal(h.saved().source.keys[0].dailyLimit, 12);
});
