(function (root) {
  "use strict";
  function cloudCover(condition) {
    if (condition === "clear") return "clear";
    if (
      condition === "cloudy" ||
      condition === "overcast" ||
      /rain|snow|thunder|drizzle|showers|hail/.test(condition || "")
    )
      return "cloudy";
    return "partly";
  }
  // Same north-pointing arrow and meteorological wind directions as yandex-weather.
  const windAngles = {
    s: 0,
    sw: 45,
    w: 90,
    nw: 135,
    n: 180,
    ne: -135,
    e: -90,
    se: -45,
  };
  function windAngle(direction) {
    return windAngles[String(direction || "").toLowerCase()] ?? null;
  }
  // Day parts use the configured display timezone, independent of sunrise/sunset.
  function nextForecast(
    forecast,
    now = new Date(),
    timeZone = "Europe/Moscow",
  ) {
    if (!Array.isArray(forecast)) return [];
    const fields = Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        hourCycle: "h23",
      })
        .formatToParts(now)
        .map((part) => [part.type, part.value]),
    );
    const date = `${fields.year}-${fields.month}-${fields.day}`;
    const order = ["night", "morning", "day", "evening"];
    const current = `${date}/${Math.floor(Number(fields.hour) / 6)}`;
    const periods = new Map();
    for (const part of forecast) {
      const index = order.indexOf(part?.part);
      if (index < 0 || !/^\d{4}-\d{2}-\d{2}$/.test(part.date)) continue;
      const key = `${part.date}/${index}`;
      if (key > current && !periods.has(key)) periods.set(key, part);
    }
    return [...periods]
      .sort(([a], [b]) => a.localeCompare(b))
      .slice(0, 2)
      .map(([, part]) => part);
  }
  const visuals = { cloudCover, windAngle, nextForecast };
  if (typeof module === "object" && module.exports) module.exports = visuals;
  else root.InformerWeather = visuals;
})(typeof globalThis === "object" ? globalThis : this);
