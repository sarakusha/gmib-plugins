// Penalty seconds stay in phase with the primary game clock. The correction is
// intentionally disabled during the final second so tenths use real time.
export function penaltyTime(valueMs, displayDelayMs = 0) {
  const remaining = Math.max(0, valueMs);
  if (remaining <= 0) return "";
  if (remaining < 1000) {
    const deciseconds = Math.ceil(remaining / 100);
    return `${Math.floor(deciseconds / 10)}.${deciseconds % 10}`;
  }
  const correction =
    ((remaining + Math.max(0, displayDelayMs)) % 1000 + 1000) % 1000;
  const total = Math.ceil((remaining - correction) / 1000);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}
