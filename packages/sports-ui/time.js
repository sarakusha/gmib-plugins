const SECOND_MS = 1000;

const modulo = (value, divisor) => ((value % divisor) + divisor) % divisor;

// Hidden fractions are rounded towards the direction in which the timer is
// moving: a countdown uses ceil, while a count-up timer uses floor.
export function wholeSeconds(valueMs, isCountdown = true) {
  const seconds = Math.max(0, valueMs) / SECOND_MS;
  return (isCountdown ? Math.ceil : Math.floor)(seconds);
}

// Matchpad aligns auxiliary countdowns with the visible second boundary of the
// primary timer. For a countdown the value falls towards the next boundary;
// for a count-up timer it rises towards it.
export function primaryDisplayPhase(valueMs, isCountdown = true) {
  const remainder = modulo(Math.max(0, valueMs), SECOND_MS);
  return isCountdown ? modulo(-remainder, SECOND_MS) : remainder;
}

// Penalty seconds stay in phase with the primary game clock. The correction is
// intentionally disabled during the final second so tenths use real time.
export function penaltyTime(
  valueMs,
  primaryValueMs,
  primaryIsCountdown = true,
) {
  const remaining = Math.max(0, valueMs);
  if (remaining <= 0) return "";
  if (remaining < 1000) {
    const deciseconds = Math.ceil(remaining / 100);
    return `${Math.floor(deciseconds / 10)}.${deciseconds % 10}`;
  }
  const phase = primaryDisplayPhase(primaryValueMs, primaryIsCountdown);
  const correction = modulo(remaining + phase, SECOND_MS);
  const total = wholeSeconds(remaining - correction, true);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
