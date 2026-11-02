(() => {
  "use strict";
  const distances = [1, 2, 3, 4, 6];
  const periods = [24, 16, 10, 6, 3];
  const level = (value) =>
    Number.isInteger(value) && value >= 1 && value <= 5 ? value - 1 : 1;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  // Include the original position even if oversized user content already overflows.
  function limits(rect, area, distance, horizontalOnly = false) {
    return {
      left: Math.max(-distance, Math.min(0, area.left - rect.left)),
      right: Math.min(distance, Math.max(0, area.right - rect.right)),
      top: horizontalOnly
        ? 0
        : Math.max(-distance, Math.min(0, area.top - rect.top)),
      bottom: horizontalOnly
        ? 0
        : Math.min(distance, Math.max(0, area.bottom - rect.bottom)),
    };
  }
  function position(phase, index, bounds) {
    const x = Math.sin(phase * (1 + index * 0.071) + index * 1.7);
    const y = Math.sin(phase * (0.73 + index * 0.053) + index * 2.3);
    return {
      x: bounds.left + ((x + 1) / 2) * (bounds.right - bounds.left),
      y: bounds.top + ((y + 1) / 2) * (bounds.bottom - bounds.top),
    };
  }
  function create(doc) {
    const entries = [
      ".datetime",
      "#clock-metrics",
      "#weather-slide",
      ".source",
    ].map((selector) => ({
      el: doc.querySelector(selector),
      x: 0,
      y: 0,
      bounds: null,
    }));
    let last = null,
      phase = 0,
      measuredAt = -Infinity,
      signature = "",
      stopped = false;
    const baseRect = (entry) => {
      const rect = entry.el.getBoundingClientRect();
      return {
        left: rect.left - entry.x,
        right: rect.right - entry.x,
        top: rect.top - entry.y,
        bottom: rect.bottom - entry.y,
      };
    };
    function measure(distance) {
      const time = doc.querySelector(".time-pane").getBoundingClientRect();
      const weather = doc
        .querySelector(".weather-pane")
        .getBoundingClientRect();
      const datetime = baseRect(entries[0]);
      const metrics = baseRect(entries[1]);
      const compact = doc.body.classList.contains("compact");
      entries.forEach((entry, index) => {
        const rect = baseRect(entry);
        const area = { ...(index < 2 ? time.toJSON() : weather.toJSON()) };
        // Keep the two clock rows disjoint; weather can use its bottom padding.
        if (index === 0)
          area.bottom = compact
            ? time.bottom
            : Math.min(time.bottom, metrics.top);
        if (index === 1) area.top = Math.max(datetime.bottom, rect.top);
        if (index === 2) {
          area.top = rect.top;
          if (
            compact &&
            doc.body.classList.contains("weather-details") &&
            !doc.body.classList.contains("no-source")
          )
            area.bottom =
              doc.querySelector(".weather-footer").getBoundingClientRect().top -
              1;
        }
        if (index === 3) {
          area.left = Math.max(0, weather.left + 1);
          area.right = Math.min(
            doc.documentElement.clientWidth,
            weather.right - 1,
          );
        }
        entry.bounds = limits(
          rect,
          area,
          distance * (index === 3 ? 8 : 1),
          index === 3,
        );
      });
    }
    function tick(now, appearance = {}) {
      if (stopped) return;
      const elapsed =
        last === null ? 0 : Math.max(0, Math.min(1, (now - last) / 1000));
      last = now;
      const enabled = appearance.burnInProtection !== false;
      const key = `${enabled}/${level(appearance.burnInDistance)}/${doc.body.className}`;
      if (key !== signature || now - measuredAt >= 1000) {
        const scale =
          Number.parseFloat(
            getComputedStyle(doc.documentElement).getPropertyValue("--scale"),
          ) || 1;
        measure(distances[level(appearance.burnInDistance)] * scale);
        measuredAt = now;
        signature = key;
      }
      const rate =
        ((Math.PI * 2) / (periods[level(appearance.burnInSpeed)] * 60)) *
        (appearance.burnInDemo === true ? 60 : 1);
      if (enabled) phase += elapsed * rate;
      entries.forEach((entry, index) => {
        const target = enabled
          ? position(phase, index, entry.bounds)
          : { x: 0, y: 0 };
        // Ease changes of amplitude/toggle without resetting phase on state refresh.
        const blend = 1 - Math.exp(-elapsed / 1.5);
        // Limit startup and setting changes to the trajectory's peak speed too.
        const move = (current, target, min, max, frequency) => {
          const change = (target - current) * blend;
          const limit = enabled
            ? ((max - min) / 2) * rate * frequency * elapsed
            : Infinity;
          return clamp(current + clamp(change, -limit, limit), min, max);
        };
        entry.x = move(
          entry.x,
          target.x,
          entry.bounds.left,
          entry.bounds.right,
          1 + index * 0.071,
        );
        entry.y = move(
          entry.y,
          target.y,
          entry.bounds.top,
          entry.bounds.bottom,
          0.73 + index * 0.053,
        );
        if (!enabled && Math.abs(entry.x) + Math.abs(entry.y) < 0.001)
          entry.x = entry.y = 0;
        entry.el.style.translate = `${entry.x.toFixed(4)}px ${entry.y.toFixed(4)}px`;
      });
    }
    return {
      tick,
      invalidate() {
        measuredAt = -Infinity;
      },
      dispose() {
        stopped = true;
        for (const entry of entries) entry.el.style.removeProperty("translate");
      },
    };
  }
  globalThis.InformerBurnIn = { create, limits, position, distances, periods };
})();
