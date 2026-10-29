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
  const visuals = { cloudCover, windAngle };
  if (typeof module === "object" && module.exports) module.exports = visuals;
  else root.InformerWeather = visuals;
})(typeof globalThis === "object" ? globalThis : this);
