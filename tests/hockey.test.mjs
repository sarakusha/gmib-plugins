import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHost, commandBody } from "./harness.mjs";
const require = createRequire(import.meta.url);
const {
  createMatch,
  materialize,
  applyCommand,
} = require("../plugins/icehockey/backend/engine.cjs");
const { activate } = require("../plugins/icehockey/backend/main.cjs");
test("monotonic timer and penalties survive delayed ticks, pauses, rest and period changes", () => {
  let state = createMatch(
    { home: "Дом", away: "Гости", durationMs: 200000 },
    0,
  );
  state = applyCommand(
    state,
    { type: "penalty", side: "home", number: "7", durationMs: 120000 },
    0,
  );
  state = applyCommand(state, { type: "start" }, 0);
  state = materialize(state, 60000);
  assert.equal(state.clock.remainingMs, 140000);
  assert.equal(state.penalties[0].remainingMs, 60000);
  state = applyCommand(
    state,
    { type: "interval", mode: "rest", durationMs: 150000 },
    60000,
  );
  state = applyCommand(state, { type: "start" }, 60000);
  state = materialize(state, 160000);
  assert.equal(state.penalties[0].remainingMs, 60000);
  state = applyCommand(state, { type: "return" }, 160000);
  assert.equal(state.clock.remainingMs, 140000);
  state = applyCommand(
    state,
    { type: "period", period: 2, durationMs: 1200000 },
    160000,
  );
  assert.equal(state.penalties[0].remainingMs, 60000);
  state = applyCommand(state, { type: "start" }, 160000);
  assert.equal(materialize(state, 219999).penalties.length, 1);
  assert.equal(materialize(state, 220000).penalties.length, 0);
  assert.equal(materialize(state, 99999999).clock.running, false);
});
test("standalone match enforces control, revisions, idempotency and restores paused", async () => {
  const dir = await mkdtemp(join(tmpdir(), "hockey-test-"));
  let host = createHost({ directory: dir });
  try {
    await activate(host.context);
    assert.equal(
      (await host.request("GET", "/state")).body.rosterAvailable,
      false,
    );
    const token = (await host.request("POST", "/control", {})).body
      .controlToken;
    assert.equal((await host.request("POST", "/control", {})).status, 423);
    let snap = (
      await host.request("POST", "/matches", {
        home: "Дом",
        away: "Гости",
        controlToken: token,
        commandId: "new",
      })
    ).body;
    const body = commandBody(snap, token, {
      type: "score",
      side: "home",
      delta: 1,
    });
    snap = (await host.request("POST", "/commands", body)).body;
    assert.equal(snap.state.home.score, 1);
    assert.equal(
      (await host.request("POST", "/commands", body)).body.state.home.score,
      1,
    );
    assert.equal(
      (
        await host.request("POST", "/commands", {
          ...body,
          commandId: "conflict",
        })
      ).status,
      409,
    );
    snap = (
      await host.request(
        "POST",
        "/commands",
        commandBody(snap, token, { type: "start" }),
      )
    ).body;
    host.advance(5000);
    assert.equal(
      (await host.request("GET", "/state")).body.state.clock.remainingMs,
      1195000,
    );
    await host.close();
    host = createHost({ directory: dir });
    await activate(host.context);
    snap = (await host.request("GET", "/state")).body;
    assert.equal(snap.state.clock.running, false);
    assert.equal(snap.state.clock.remainingMs, 1195000);
    assert.equal(snap.state.home.score, 1);
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("optional roster supplies a frozen match lineup and manual mode remains available", async () => {
  const service = {
    createRosterSnapshot: async () => ({
      id: "team",
      sportId: "icehockey",
      name: "Из справочника",
      shortName: "СПР",
      members: [{ participantId: "p", lastName: "Игрок", number: "07" }],
    }),
  };
  const host = createHost({ services: new Map([["sports.rosters", service]]) });
  await activate(host.context);
  try {
    const token = (await host.request("POST", "/control", {})).body
      .controlToken;
    const snapshot = (
      await host.request("POST", "/matches", {
        home: "Дом",
        away: "Гости",
        homeTeamId: "team",
        controlToken: token,
        commandId: "with-roster",
      })
    ).body;
    assert.equal(snapshot.rosterAvailable, true);
    assert.equal(snapshot.state.home.name, "Из справочника");
    assert.equal(snapshot.state.home.members[0].number, "07");
    assert.deepEqual(snapshot.state.away.members, []);
  } finally {
    await host.close();
  }
});

test("suspend captures the event time before queued database work runs", async () => {
  const host = createHost();
  await activate(host.context);
  try {
    const token = (await host.request("POST", "/control", {})).body
      .controlToken;
    let snapshot = (
      await host.request("POST", "/matches", {
        home: "Дом",
        away: "Гости",
        controlToken: token,
        commandId: "sleep-game",
      })
    ).body;
    snapshot = (
      await host.request(
        "POST",
        "/commands",
        commandBody(snapshot, token, { type: "start" }),
      )
    ).body;
    host.advance(5000);
    host.power.suspend();
    host.advance(300000);
    await new Promise(setImmediate);
    snapshot = (await host.request("GET", "/state")).body;
    assert.equal(snapshot.state.clock.running, false);
    assert.equal(snapshot.state.clock.remainingMs, 1195000);
    host.power.resume();
    await new Promise(setImmediate);
    assert.equal(
      (await host.request("GET", "/state")).body.state.clock.remainingMs,
      1195000,
    );
  } finally {
    await host.close();
  }
});
