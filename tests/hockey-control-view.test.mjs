import { test } from "node:test";
import assert from "node:assert/strict";
import {
  controlViewKey,
  setText,
  setFlag,
} from "../plugins/icehockey/public/control-view.js";
import {
  clockLayout,
  clockParts,
} from "../plugins/icehockey/public/clock-view.js";

test("compact clock groups and explicit per-digit fallback are stable", () => {
  assert.deepEqual(clockParts("19:08.3"), {
    minutes: "19",
    seconds: "08",
    fractions: "3",
    whole: "19:08",
  });
  assert.equal(clockLayout(""), "groups");
  assert.equal(clockLayout("?clockLayout=groups"), "groups");
  assert.equal(clockLayout("?clockLayout=digits"), "digits");
  assert.equal(clockLayout("?clockLayout=unknown"), "groups");
});

test("clock ticks preserve controls; new match/revision and integration changes render", () => {
  const snapshot = {
    sessionId: "s",
    state: {
      id: "m",
      revision: 1,
      clock: { running: true, remainingMs: 20000 },
      penalties: [{ remainingMs: 10000 }],
    },
    rosterAvailable: false,
    nibusEnabled: false,
  };
  const tick = structuredClone(snapshot);
  tick.state.clock.remainingMs -= 100;
  tick.state.penalties[0].remainingMs -= 100;
  tick.serverTime = 100;
  tick.state.savedAt = "later";
  assert.equal(controlViewKey(tick), controlViewKey(snapshot));
  for (const next of [
    { ...tick, sessionId: "restart" },
    { ...tick, state: { ...tick.state, id: "other" } },
    { ...tick, state: { ...tick.state, revision: 2 } },
    { ...tick, persistenceError: "Disk failure" },
    { ...tick, nibusEnabled: true },
    { ...tick, rosterAvailable: true },
  ])
    assert.notEqual(controlViewKey(next), controlViewKey(snapshot));
});

test("unchanged button label/access cause no DOM writes across repeated ticks", () => {
  let text = "Старт",
    disabled = false,
    writes = 0;
  const button = {
    get textContent() {
      return text;
    },
    set textContent(value) {
      text = value;
      writes++;
    },
    get disabled() {
      return disabled;
    },
    set disabled(value) {
      disabled = value;
      writes++;
    },
  };
  for (let i = 0; i < 100; i++) {
    setText(button, "Старт");
    setFlag(button, "disabled", false);
  }
  assert.equal(writes, 0);
  setText(button, "Пауза");
  setFlag(button, "disabled", true);
  assert.equal(writes, 2);
  assert.equal(text, "Пауза");
  assert.equal(disabled, true);
});
