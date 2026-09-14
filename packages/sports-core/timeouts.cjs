"use strict";

const teamSides = ["home", "away"];

const normalizeTimeoutState = (state, defaultLimit = 1) => {
  state.timeoutLimit =
    Number.isSafeInteger(state.timeoutLimit) && state.timeoutLimit >= 0
      ? state.timeoutLimit
      : defaultLimit;
  for (const side of teamSides)
    if (!Number.isSafeInteger(state[side].timeoutsUsed))
      state[side].timeoutsUsed = 0;
  if (state.secondaryClock === undefined) state.secondaryClock = null;
  return state;
};

const createTimeoutClock = ({ side, durationMs, now }) => ({
  remainingMs: durationMs,
  running: true,
  anchorMs: now,
  mode: "timeout",
  side,
});

const materializeSecondaryClock = (clock, now) => {
  if (!clock) return null;
  const elapsed = clock.running
    ? Math.min(clock.remainingMs, Math.max(0, now - clock.anchorMs))
    : 0;
  clock.remainingMs = Math.max(0, clock.remainingMs - elapsed);
  clock.anchorMs = now;
  return clock.remainingMs > 0 ? clock : null;
};

const timeoutAvailable = (state, side) =>
  !state.secondaryClock &&
  state.clock.mode === "game" &&
  state[side].timeoutsUsed < state.timeoutLimit;

module.exports = {
  createTimeoutClock,
  materializeSecondaryClock,
  normalizeTimeoutState,
  timeoutAvailable,
};
