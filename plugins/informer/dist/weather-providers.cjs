"use strict";
const { normalizeWeather } = require("./model.cjs");
const endpoints = Object.freeze({
  home: "https://api.weather.yandex.ru/v2/forecast",
  site: "https://api.weather.yandex.ru/v2/informers",
});
function requestUrl(type, location) {
  if (!Object.hasOwn(endpoints, type)) throw Error("Неизвестный погодный API");
  const url = new URL(endpoints[type]);
  url.searchParams.set("lat", String(location.lat));
  url.searchParams.set("lon", String(location.lon));
  url.searchParams.set("lang", "ru_RU");
  if (type === "home") {
    url.searchParams.set("limit", "2");
    url.searchParams.set("hours", "false");
  }
  return url;
}
function adaptResponse(raw, type, location, fetchedAt) {
  const weather = normalizeWeather(
    { ...raw, info: { lat: location.lat, lon: location.lon } },
    fetchedAt,
  );
  weather.provider = type === "home" ? "yandex-forecast" : "yandex-informers";
  return weather;
}
module.exports = { requestUrl, adaptResponse };
