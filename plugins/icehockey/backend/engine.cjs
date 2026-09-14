"use strict";
const { randomUUID } = require("node:crypto");
const {
  createTimeoutClock,
  materializeSecondaryClock,
  normalizeTimeoutState,
  timeoutAvailable,
} = require("./sports-timeouts.cjs");
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
    timeoutsUsed: 0,
    members: [],
  },
  away: {
    name: text(input.away, 100, "гости"),
    shortName: "",
    color: "#40d9ac",
    score: 0,
    timeoutsUsed: 0,
    members: [],
  },
  clock: {
    remainingMs: duration(input.durationMs ?? 1200000),
    running: false,
    anchorMs: now,
    mode: "game",
  },
  secondaryClock: null,
  timeoutLimit: integer(
    input.timeoutLimit ?? 1,
    0,
    9,
    "лимит тайм-аутов",
  ),
  gameRemainingMs: null,
  penalties: [],
  view: "scoreboard",
  savedAt: null,
  recovery: null,
});
/** Materialization uses elapsed monotonic time, never the number of interval callbacks. */
const materialize = (previous, now) => {
  const state = structuredClone(previous);
  normalizeTimeoutState(state, 1);
  // Older development builds stored the display phase separately. The current
  // primary value is the only source of truth for display synchronization.
  delete state.clock.displayDelayMs;
  // Early development builds replaced the primary clock with a timeout.
  // Restore those saved matches to a paused game clock once.
  if (state.clock.mode === "timeout") {
    state.clock = {
      remainingMs: state.gameRemainingMs ?? state.clock.remainingMs,
      running: false,
      anchorMs: now,
      mode: "game",
    };
    state.gameRemainingMs = null;
  }
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
  state.secondaryClock = materializeSecondaryClock(state.secondaryClock, now);
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
      if (state.secondaryClock) fail("Сначала остановите тайм-аут");
      if (state.clock.remainingMs <= 0) fail("Сначала установите время");
      state.clock.running = true;
      state.status = "live";
      state.recovery = null;
      break;
    case "pause":
      state.clock.running = false;
      break;
    case "time":
      if (state.secondaryClock) fail("Сначала остановите тайм-аут");
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
      if (
        state.clock.running ||
        state.clock.mode !== "game" ||
        state.secondaryClock
      )
        fail("Остановите игровые часы");
      state.period = integer(b.period, 1, 99, "период");
      state.clock.remainingMs = duration(
        b.durationMs ?? state.periodDurationMs,
      );
      break;
    case "interval":
      if (state.clock.mode !== "game")
        fail("Сначала завершите текущий перерыв");
      if (b.mode !== "rest") fail("Некорректный перерыв");
      if (state.secondaryClock) fail("Сначала остановите тайм-аут");
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
    case "timeout.start": {
      const teamSide = side(b.side);
      if (state.clock.mode !== "game")
        fail("Тайм-аут доступен только во время игры");
      if (!timeoutAvailable(state, teamSide)) {
        if (state.secondaryClock) fail("Тайм-аут уже идёт");
        fail("Команда использовала все тайм-ауты");
      }
      state.clock.running = false;
      state.secondaryClock = createTimeoutClock({
        durationMs: duration(b.durationMs ?? 30000),
        side: teamSide,
        now,
      });
      state[teamSide].timeoutsUsed += 1;
      state.status = "live";
      break;
    }
    case "timeout.stop":
      if (!state.secondaryClock) fail("Тайм-аут не запущен");
      state.secondaryClock = null;
      break;
    case "timeouts": {
      if (state.secondaryClock) fail("Сначала остановите тайм-аут");
      const team = state[side(b.side)];
      team.timeoutsUsed = integer(
        b.value,
        0,
        state.timeoutLimit,
        "использованные тайм-ауты",
      );
      break;
    }
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
      state.secondaryClock = null;
      state.status = "finished";
      break;
    case "reopen":
      state.status = "live";
      state.clock.running = false;
      state.secondaryClock = null;
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
