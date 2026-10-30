"use strict";
const { restoreWeather } = require("./model.cjs");
const order = ["night", "morning", "day", "evening"];
function restoreForecastCache(saved, weather) {
  const cache = { api: null, page: null };
  for (const source of ["api", "page"]) {
    try {
      if (saved?.[source]) cache[source] = restoreWeather(saved[source]);
    } catch {
      // One damaged source must not discard the other source's forecast.
    }
  }
  if (!saved) {
    const source = ["api", "page"].includes(weather.forecastSource)
      ? weather.forecastSource
      : weather.fetchedAt > 0
        ? weather.provider === "yandex-page"
          ? "page"
          : ["yandex-informers", "yandex-forecast"].includes(weather.provider)
            ? "api"
            : null
        : null;
    if (source) cache[source] = structuredClone(weather);
  }
  return cache;
}
function mergeForecast(
  record,
  weather,
  source,
  fullPage = false,
  at = Date.now(),
) {
  const cache = restoreForecastCache(record.forecastCache, record.weather);
  // A background page response inherits the display's merged forecast; it is
  // never an independent page forecast and must not overwrite this cache.
  if (source === "api" || fullPage) cache[source] = structuredClone(weather);
  const fields = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: record.settings.clock.timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    })
      .formatToParts(at)
      .map((part) => [part.type, part.value]),
  );
  const today = `${fields.year}-${fields.month}-${fields.day}`;
  const sameLocation = (snapshot) =>
    snapshot &&
    snapshot.location.lat === weather.location.lat &&
    snapshot.location.lon === weather.location.lon;
  const merged = new Map();
  if (record.source.page.enabled && sameLocation(cache.page))
    for (const part of cache.page.forecast.filter((part) => part.date >= today))
      merged.set(`${part.date}/${part.part}`, part);
  let hasApi = false;
  if (record.source.keys.some((key) => key.apiKey) && sameLocation(cache.api))
    for (const part of cache.api.forecast) {
      if (part.date < today) continue;
      hasApi = true;
      merged.set(`${part.date}/${part.part}`, part);
    }
  const forecast = [...merged.values()].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      order.indexOf(a.part) - order.indexOf(b.part),
  );
  return {
    forecastCache: cache,
    weather: { ...weather, forecast, forecastSource: hasApi ? "api" : "page" },
  };
}
module.exports = { restoreForecastCache, mergeForecast };
