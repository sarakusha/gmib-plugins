"use strict";
const { randomUUID } = require("node:crypto");
const fail = (message) => {
  const e = new Error(message);
  e.status = 422;
  throw e;
};
const integer = (value, min, max, label) => {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    fail(`Проверьте поле «${label}»`);
  return value;
};
const text = (value, max, label) => {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    fail(`Проверьте поле «${label}»`);
  return value.trim();
};
const side = (value) => {
  if (value !== "home" && value !== "away") fail("Неизвестная команда");
  return value;
};
const duration = (value) => integer(value, 1, 3600000, "длительность");
const createMatch = (input, now) => ({
  id: randomUUID(),
  revision: 0,
  status: "ready",
  period: 1,
  periodDurationMs: duration(input.durationMs ?? 1200000),
  home: {
    name: text(input.home, 100, "хозяева"),
    shortName: "",
    color: "#40d9ac",
    score: 0,
    members: [],
  },
  away: {
    name: text(input.away, 100, "гости"),
    shortName: "",
    color: "#40d9ac",
    score: 0,
    members: [],
  },
  clock: {
    remainingMs: duration(input.durationMs ?? 1200000),
    running: false,
    anchorMs: now,
    mode: "game",
  },
  gameRemainingMs: null,
  penalties: [],
  view: "scoreboard",
  savedAt: null,
  recovery: null,
});
/** Materialization uses elapsed monotonic time, never the number of interval callbacks. */
const materialize = (previous, now) => {
  const state = structuredClone(previous);
  const elapsed = state.clock.running
    ? Math.min(state.clock.remainingMs, Math.max(0, now - state.clock.anchorMs))
    : 0;
  state.clock.remainingMs = Math.max(0, state.clock.remainingMs - elapsed);
  state.clock.anchorMs = now;
  if (state.clock.mode === "game") {
    state.penalties = state.penalties
      .map((penalty) => ({
        ...penalty,
        remainingMs: Math.max(
          0,
          penalty.remainingMs - (penalty.queued ? 0 : elapsed),
        ),
      }))
      .filter((penalty) => penalty.remainingMs > 0);
  }
  if (state.clock.remainingMs === 0) state.clock.running = false;
  return state;
};
const applyCommand = (previous, command, now) => {
  if (!command || typeof command !== "object") fail("Некорректная команда");
  const state = materialize(previous, now);
  const b = command;
  if (state.status === "finished" && !["view", "reopen"].includes(b.type))
    fail("Матч завершён");
  switch (b.type) {
    case "start":
      if (state.clock.remainingMs <= 0) fail("Сначала установите время");
      state.clock.running = true;
      state.status = "live";
      state.recovery = null;
      break;
    case "pause":
      state.clock.running = false;
      break;
    case "time":
      if (state.clock.running) fail("Остановите часы перед коррекцией");
      state.clock.remainingMs = integer(b.valueMs, 0, 3600000, "время");
      break;
    case "score": {
      const team = state[side(b.side)];
      team.score = integer(
        b.value !== undefined
          ? b.value
          : team.score + integer(b.delta, -1, 1, "изменение счёта"),
        0,
        999,
        "счёт",
      );
      break;
    }
    case "period":
      if (state.clock.running || state.clock.mode !== "game")
        fail("Остановите игровые часы");
      state.period = integer(b.period, 1, 99, "период");
      state.clock.remainingMs = duration(
        b.durationMs ?? state.periodDurationMs,
      );
      break;
    case "interval":
      if (state.clock.mode !== "game")
        fail("Сначала завершите текущий перерыв");
      if (!["rest", "timeout"].includes(b.mode)) fail("Некорректный перерыв");
      state.gameRemainingMs = state.clock.remainingMs;
      state.clock = {
        remainingMs: duration(b.durationMs),
        mode: b.mode,
        running: false,
        anchorMs: now,
      };
      break;
    case "return":
      if (state.clock.mode === "game") fail("Перерыв не включён");
      state.clock = {
        remainingMs: state.gameRemainingMs,
        mode: "game",
        running: false,
        anchorMs: now,
      };
      state.gameRemainingMs = null;
      break;
    case "penalty":
      if (state.penalties.length >= 30) fail("Слишком много штрафов");
      state.penalties.push({
        id: randomUUID(),
        side: side(b.side),
        number: text(b.number, 5, "номер игрока"),
        remainingMs: duration(b.durationMs),
        queued: Boolean(b.queued),
      });
      break;
    case "penalty.edit": {
      const penalty = state.penalties.find((item) => item.id === b.id);
      if (!penalty) fail("Штраф уже завершён или удалён");
      if (b.remainingMs !== undefined)
        penalty.remainingMs = duration(b.remainingMs);
      if (b.queued !== undefined) penalty.queued = Boolean(b.queued);
      break;
    }
    case "penalty.remove":
      state.penalties = state.penalties.filter((item) => item.id !== b.id);
      break;
    case "view":
      if (!["scoreboard", "rosters"].includes(b.view))
        fail("Неизвестный вид экрана");
      state.view = b.view;
      break;
    case "finish":
      state.clock.running = false;
      state.status = "finished";
      break;
    case "reopen":
      state.status = "live";
      state.clock.running = false;
      break;
    default:
      fail("Неизвестная команда");
  }
  state.revision += 1;
  return state;
};
module.exports = {
  createMatch,
  materialize,
  applyCommand,
  fail,
  integer,
  text,
};
