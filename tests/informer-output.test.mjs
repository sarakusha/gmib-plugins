import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { activate } = require("../plugins/informer/dist/main.cjs");
const config = {
  wideScreenId: 1,
  compactScreenId: 2,
  mode: "wide",
  autoStart: false,
  playerEnabled: true,
  playerId: 7,
};
async function host({
  supported = true,
  saved = config,
  failPlay = false,
  failStop = false,
  atomic = false,
  failApply = false,
  failPersist = false,
  active = true,
  playing = false,
} = {}) {
  let record = { version: 1, outputConfig: saved },
    status = {
      active,
      ...(active
        ? {
            profile: {
              screenId: saved?.mode === "compact" ? 2 : 1,
              pageId: "screen",
              autoStart: false,
            },
          }
        : {}),
      message: "Вывод включён",
    };
  const playerStates = new Map([
    [7, playing],
    [8, false],
  ]);
  const calls = [],
    routes = new Map(),
    disposers = [];
  const output = {
    listScreens: async () => [
      { id: 1, name: "Wide", width: 704, height: 192 },
      { id: 2, name: "Compact", width: 320, height: 192 },
    ],
    getStatus: async () => structuredClone(status),
    stop: async () => {
      calls.push("hide");
      status.active = false;
    },
    start: async (profile) => {
      assert.equal(
        status.active,
        false,
        "previous output must be hidden first",
      );
      calls.push(`show:${profile.screenId}`);
      status = { active: true, profile, message: "Вывод включён" };
    },
    ...(supported
      ? {
          listPlayers: async () =>
            [...playerStates].map(([id, playing]) => ({
              id,
              name: `Ads ${id}`,
              playing,
            })),
          setPlayerState: async ({ playerId, playing }) => {
            calls.push(`player:${playerId}:${playing}`);
            if (!playing && failStop) throw Error("stop failed");
            if (playing && failPlay) {
              failPlay = false;
              throw Error("launch failed");
            }
            playerStates.set(playerId, playing);
          },
        }
      : {}),
  };
  if (atomic)
    output.applyLayout = async (layout) => {
      calls.push({ applyLayout: structuredClone(layout) });
      if (failApply)
        throw Error("atomic launch failed; host restored previous layout");
      status = {
        active: true,
        profile: structuredClone(layout.profile),
        message: "Вывод включён",
      };
      for (const player of layout.players ?? [])
        playerStates.set(player.playerId, player.playing);
    };
  await activate({
    storage: {
      get: async () => record,
      set: async (_, r) => {
        if (failPersist && r.outputConfig?.mode !== saved?.mode)
          throw Error("persist failed");
        record = structuredClone(r);
      },
    },
    output,
    http: {
      ...Object.fromEntries(
        ["get", "put", "post", "delete"].map((m) => [
          m,
          (p, f) => routes.set(`${m} ${p}`, f),
        ]),
      ),
      response: (status, body) => ({ status, body }),
    },
    events: { publish() {} },
    logger: { warn() {} },
    lifecycle: { onDispose: (fn) => disposers.push(fn) },
  });
  return {
    calls,
    record: () => record,
    status: () => structuredClone(status),
    playerState: (id) => playerStates.get(id),
    call: (method, body) => routes.get(`${method} /output`)({ body }),
    dispose: async () => {
      for (const d of disposers) await d();
    },
  };
}
test("Informer toggles one screen at a time and starts/stops the selected player in order", async () => {
  const h = await host();
  let r = await h.call("put", { command: "toggle", config });
  assert.equal(r.status, 200);
  assert.equal(r.body.config.mode, "compact");
  assert.deepEqual(h.calls, ["hide", "show:2", "player:7:true"]);
  r = await h.call("put", {
    command: "toggle",
    config: { ...config, mode: "compact" },
  });
  assert.equal(r.body.config.mode, "wide");
  assert.deepEqual(h.calls.slice(3), ["player:7:false", "hide", "show:1"]);
  await h.dispose();
});
test("concurrent Informer output commands are serialized through the plugin queue", async () => {
  const h = await host();
  await Promise.all([
    h.call("put", { command: "toggle", config }),
    h.call("put", { command: "toggle", config }),
  ]);
  assert.deepEqual(h.calls, [
    "hide",
    "show:2",
    "player:7:true",
    "player:7:false",
    "hide",
    "show:1",
  ]);
  assert.equal(h.record().outputConfig.mode, "wide");
  await h.dispose();
});
test("invalid configuration is rejected before output changes and old hosts reject only player control", async () => {
  const h = await host({
    supported: false,
    saved: { ...config, playerEnabled: false },
  });
  const invalid = await h.call("put", {
    command: "toggle",
    config: { ...config, compactScreenId: 1 },
  });
  assert.equal(invalid.status, 422);
  assert.deepEqual(h.calls, []);
  const unsupported = await h.call("put", { command: "show", config });
  assert.equal(unsupported.status, 409);
  assert.deepEqual(h.calls, []);
  const r = await h.call("put", {
    command: "toggle",
    config: { ...config, playerEnabled: false },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(h.calls, ["hide", "show:2"]);
  await h.dispose();
});
test("failed player launch restores previous screen and does not save half-applied config", async () => {
  const h = await host({ failPlay: true });
  const r = await h.call("put", { command: "toggle", config });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /launch failed/);
  assert.equal(h.record().outputConfig.mode, "wide");
  assert.deepEqual(h.calls, [
    "hide",
    "show:2",
    "player:7:true",
    "player:7:false",
    "hide",
    "show:1",
  ]);
  await h.dispose();
});
test("hide works despite an invalid draft and stops managed playback", async () => {
  const h = await host();
  const r = await h.call("put", { command: "hide", config: { invalid: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.status.active, false);
  assert.deepEqual(h.calls, ["player:7:false", "hide"]);
  await h.dispose();
});

test("player stop failure does not prevent hiding the clock", async () => {
  const h = await host({ failStop: true });
  const r = await h.call("put", { command: "hide" });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /stop failed/);
  const state = await h.call("get");
  assert.equal(state.body.status.active, false);
  assert.equal(h.record().outputConfig.autoStart, false);
  assert.deepEqual(h.calls, ["player:7:false", "hide"]);
  await h.dispose();
});

test("atomic switching uses one layout request without preliminary stop/play/start", async () => {
  const h = await host({ atomic: true });
  const compact = await h.call("put", { command: "toggle", config });
  assert.equal(compact.status, 200);
  assert.equal(compact.body.config.mode, "compact");
  assert.deepEqual(h.calls, [
    {
      applyLayout: {
        profile: { screenId: 2, pageId: "screen", autoStart: false },
        players: [{ playerId: 7, playing: true }],
      },
    },
  ]);
  const wide = await h.call("put", { command: "toggle", config });
  assert.equal(wide.status, 200);
  assert.equal(wide.body.config.mode, "wide");
  assert.deepEqual(h.calls[1], {
    applyLayout: {
      profile: { screenId: 1, pageId: "screen", autoStart: false },
      players: [{ playerId: 7, playing: false }],
    },
  });
  await h.dispose();
});

test("atomic changing players stops the former player and starts the new compact player together", async () => {
  const h = await host({
    atomic: true,
    saved: { ...config, mode: "compact" },
    playing: true,
  });
  const r = await h.call("put", {
    command: "show",
    config: { ...config, mode: "compact", playerId: 8 },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(h.calls, [
    {
      applyLayout: {
        profile: { screenId: 2, pageId: "screen", autoStart: false },
        players: [
          { playerId: 7, playing: false },
          { playerId: 8, playing: true },
        ],
      },
    },
  ]);
  assert.equal(h.playerState(7), false);
  assert.equal(h.playerState(8), true);
  await h.dispose();
});

test("an atomic rejection trusts host rollback without calling legacy stop or rollback", async () => {
  const h = await host({ atomic: true, failApply: true });
  const r = await h.call("put", { command: "toggle", config });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /atomic launch failed/);
  assert.equal(h.calls.length, 1);
  assert.ok(h.calls[0].applyLayout);
  assert.equal(h.status().profile.screenId, 1);
  assert.equal(h.record().outputConfig.mode, "wide");
  await h.dispose();
});

test("persistence failure after atomic switching restores the previous layout and actual player states", async () => {
  const h = await host({ atomic: true, failPersist: true, playing: true });
  const r = await h.call("put", { command: "toggle", config });
  assert.equal(r.status, 500);
  assert.match(r.body.error, /persist failed/);
  assert.deepEqual(h.calls, [
    {
      applyLayout: {
        profile: { screenId: 2, pageId: "screen", autoStart: false },
        players: [{ playerId: 7, playing: true }],
      },
    },
    {
      applyLayout: {
        profile: { screenId: 1, pageId: "screen", autoStart: false },
        players: [{ playerId: 7, playing: true }],
      },
    },
  ]);
  assert.equal(h.record().outputConfig.mode, "wide");
  assert.equal(h.status().profile.screenId, 1);
  assert.equal(h.playerState(7), true);
  await h.dispose();
});

test("persistence failure after showing from hidden returns to hidden and restores player states", async () => {
  const h = await host({ atomic: true, failPersist: true, active: false });
  const r = await h.call("put", {
    command: "show",
    config: { ...config, mode: "compact" },
  });
  assert.equal(r.status, 500);
  assert.equal(h.calls.length, 3);
  assert.ok(h.calls[0].applyLayout);
  assert.deepEqual(h.calls.slice(1), ["hide", "player:7:false"]);
  assert.equal(h.status().active, false);
  assert.equal(h.playerState(7), false);
  await h.dispose();
});

test("atomic screen-only mode omits player commands on hosts without player methods", async () => {
  const h = await host({
    atomic: true,
    supported: false,
    saved: { ...config, playerEnabled: false },
  });
  const r = await h.call("put", {
    command: "toggle",
    config: { ...config, playerEnabled: false },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(h.calls, [
    {
      applyLayout: {
        profile: { screenId: 2, pageId: "screen", autoStart: false },
      },
    },
  ]);
  await h.dispose();
});

test("hide retains explicit player stop and output stop when atomic layout is available", async () => {
  const h = await host({ atomic: true });
  const r = await h.call("put", { command: "hide" });
  assert.equal(r.status, 200);
  assert.deepEqual(h.calls, ["player:7:false", "hide"]);
  await h.dispose();
});
