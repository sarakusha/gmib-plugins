export const timeoutCount = (state, side) =>
  `${state[side].timeoutsUsed ?? 0}/${state.timeoutLimit ?? 0}`;

export const timeoutCanStart = (state, side) =>
  !state.secondaryClock &&
  state.clock.mode === "game" &&
  (state[side].timeoutsUsed ?? 0) < (state.timeoutLimit ?? 0);

export const timeoutLabel = (state, uppercase = false) => {
  const clock = state.secondaryClock;
  if (!clock) return "";
  const name = state[clock.side].shortName || state[clock.side].name;
  const label = `Тайм-аут · ${name}`;
  return uppercase ? label.toUpperCase() : label;
};

export const projectedClockMs = (clock, age, limit = 2000) =>
  Math.max(
    0,
    clock.remainingMs -
      (clock.running ? Math.min(age, limit, clock.remainingMs) : 0),
  );
