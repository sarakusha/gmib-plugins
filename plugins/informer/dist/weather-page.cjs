"use strict";
const {
  normalizeWeather,
  restoreWeather,
  yandexIconUrl,
} = require("./model.cjs");
const MAX_PAGE_BYTES = 4 * 1024 * 1024;
function validatePageUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Error("Некорректный адрес страницы погоды");
  }
  if (
    url.protocol !== "https:" ||
    !["yandex.ru", "www.yandex.ru"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/pogoda\/(?:ru\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(url.pathname)
  )
    throw Error("Разрешена только страница города https://yandex.ru/pogoda/…");
  url.hash = "";
  url.search = "";
  return url.toString();
}
function pageRequestUrl(page, source) {
  const url = new URL(
    validatePageUrl(typeof page === "string" ? page : page.url),
  );
  const location = source.location || source;
  if (
    !Number.isFinite(location.lat) ||
    !Number.isFinite(location.lon) ||
    Math.abs(location.lat) > 90 ||
    Math.abs(location.lon) > 180
  )
    throw Error("Некорректные координаты");
  // Preserve the chosen city, while coordinates always come from the source settings.
  url.search = "";
  url.searchParams.set("lat", String(location.lat));
  url.searchParams.set("lon", String(location.lon));
  return url;
}
const condition = (value) =>
  typeof value === "string"
    ? value.toLowerCase().replaceAll("_", "-")
    : "unknown";
const wind = {
  NORTH: "n",
  NORTH_EAST: "ne",
  EAST: "e",
  SOUTH_EAST: "se",
  SOUTH: "s",
  SOUTH_WEST: "sw",
  WEST: "w",
  NORTH_WEST: "nw",
  CALM: "c",
};
const russianConditions = {
  ясно: "clear",
  малооблачно: "partly-cloudy",
  "облачно с прояснениями": "cloudy",
  пасмурно: "overcast",
  "небольшой дождь": "light-rain",
  дождь: "rain",
  "сильный дождь": "heavy-rain",
  ливень: "showers",
  морось: "drizzle",
  снег: "snow",
  "небольшой снег": "light-snow",
  "сильный снег": "heavy-snow",
  "дождь со снегом": "wet-snow",
  гроза: "thunderstorm",
};
const pageIcon = yandexIconUrl;
// Yandex's WeatherIcon component uses this ordered sprite atlas in Flight
// style["--icon"], not an <img src>. Verified against its published frontend
// chunks 5763-84daf4b01d83c9fd.js and 3885-12467b2f8620834d.js.
const pageSpriteIcons = [
  "bkn_-ra_d",
  "bkn_ra_d",
  "bkn_+ra_d",
  "bkn_-sn_d",
  "bkn_sn_d",
  "bkn_+sn_d",
  "bkn_-ra_n",
  "bkn_ra_n",
  "bkn_+ra_n",
  "bkn_-sn_n",
  "bkn_sn_n",
  "bkn_+sn_n",
  "ovc_-ra",
  "ovc_ra",
  "ovc_+ra",
  "ovc_-sn",
  "ovc_sn",
  "ovc_+sn",
  "ovc_ra_sn",
  "ovc_ha",
  "ovc_ts",
  "ovc_ts_ra",
  "ovc_ts_ha",
  "bkn_d",
  "bkn_n",
  "ovc",
  "skc_d",
  "skc_n",
];
function pageForecastIcon(node) {
  const direct = pageIcon(node.src);
  if (direct) return direct;
  const sprite = node.style?.["--icon"];
  if (
    !Number.isInteger(sprite) ||
    sprite < 0 ||
    sprite >= pageSpriteIcons.length
  )
    return null;
  return pageIcon(
    `https://yastatic.net/weather/i/icons/confident/dark/svg/${pageSpriteIcons[sprite]}.svg`,
  );
}

function parsePage(html, location, fetchedAt = Date.now()) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_PAGE_BYTES)
    throw pageFormatError(html);
  const chunks = [];
  for (const script of html.matchAll(
    /<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi,
  )) {
    const call = /^\s*self\.__next_f\.push\(([\s\S]*)\)\s*;?\s*$/.exec(
      script[1],
    );
    if (!call) continue;
    try {
      const data = JSON.parse(call[1]);
      if (Array.isArray(data) && data[0] === 1 && typeof data[1] === "string")
        chunks.push(data[1]);
    } catch {
      /* Never execute page scripts. */
    }
  }
  const records = new Map();
  for (const line of chunks.join("").split("\n")) {
    const row = /^([a-f\d]+):([\s\S]*)$/i.exec(line);
    if (!row) continue;
    try {
      records.set(row[1], JSON.parse(row[2]));
    } catch {
      /* Flight also has non-JSON records. */
    }
  }
  // Resolve only ordinary Flight record references. Ignore module references and code.
  function walk(root, visit, resolve = false) {
    let budget = 100000;
    function next(value, depth, trail) {
      if (--budget < 0 || depth > 60) return;
      if (
        resolve &&
        typeof value === "string" &&
        /^\$L?[a-f\d]+$/i.test(value)
      ) {
        const id = value.replace(/^\$L?/, "");
        if (!trail.has(id) && records.has(id))
          next(records.get(id), depth + 1, new Set([...trail, id]));
        return;
      }
      if (!value || typeof value !== "object") return;
      visit(value);
      for (const child of Object.values(value)) next(child, depth + 1, trail);
    }
    next(root, 0, new Set());
  }
  let current = null,
    baseDate = null;
  const cards = [];
  for (const record of records.values())
    walk(record, (value) => {
      if (
        value.fact &&
        Number.isFinite(value.fact.temperatureInCelsius) &&
        (value.goalPrefix === "main_feedback" ||
          typeof value.visibilityGoalLocationKey === "string")
      )
        current ||= value;
      if (
        !baseDate &&
        typeof value.dateTime === "string" &&
        /^\d{4}-\d\d-\d\dT/.test(value.dateTime)
      )
        baseDate = value.dateTime.slice(0, 10);
      if (
        Array.isArray(value) &&
        value[1] === "li" &&
        typeof value[3]?.className === "string" &&
        value[3].className.includes("AppForecastDay_dayCard")
      )
        cards.push(value);
    });
  if (!current) throw pageFormatError(html);
  const fact = current.fact;
  if (typeof fact.condition !== "string" || !fact.condition.trim())
    throw pageFormatError(html);
  // The page supplies UTC timestamps and local clock labels, but no timezone.
  // Derive a consistent offset from those pairs without using the machine zone.
  const hourly = new Map();
  const offsets = new Set();
  for (const record of records.values())
    walk(record, (node) => {
      if (!node.className?.includes?.("AppHourlyItem_container__")) return;
      let timestamp, clock, temperature;
      walk(
        node,
        (child) => {
          if (child.className?.includes?.("AppHourlyItem_time__")) {
            timestamp = child.dateTime;
            clock =
              typeof child.children === "string"
                ? /(?:^|\s)(\d{2}):(\d{2})$/.exec(child.children)
                : null;
          }
          if (
            child.className?.includes?.("AppHourlyItem_main__") &&
            typeof child.children === "string"
          ) {
            const match = /^([+−-]?\d+(?:[.,]\d+)?)°$/.exec(child.children);
            if (match)
              temperature = Number(
                match[1].replace("−", "-").replace(",", "."),
              );
          }
        },
        true,
      );
      if (
        !clock ||
        !Number.isFinite(temperature) ||
        temperature < -100 ||
        temperature > 70 ||
        typeof timestamp !== "string" ||
        !/^\d{4}-\d\d-\d\dT\d\d:\d\d:00(?:\.000)?Z$/.test(timestamp)
      )
        return;
      const instant = Date.parse(timestamp);
      const hour = Number(clock[1]),
        minute = Number(clock[2]);
      if (!Number.isFinite(instant) || hour > 23 || minute !== 0) return;
      const utc = new Date(instant);
      let offset =
        hour * 60 + minute - (utc.getUTCHours() * 60 + utc.getUTCMinutes());
      if (offset < -720) offset += 1440;
      if (offset > 840) offset -= 1440;
      offsets.add(offset);
      // Conflicting duplicates invalidate this hour rather than inventing a range.
      if (hourly.has(instant) && hourly.get(instant) !== temperature)
        hourly.set(instant, null);
      else if (!hourly.has(instant)) hourly.set(instant, temperature);
    });
  const hourlyParts = new Map();
  if (offsets.size === 1) {
    const offset = [...offsets][0];
    for (const [instant, temperature] of hourly) {
      if (!Number.isFinite(temperature)) continue;
      const local = new Date(instant + offset * 60000);
      const hour = local.getUTCHours();
      const part = ["night", "morning", "day", "evening"][Math.floor(hour / 6)];
      const key = `${local.toISOString().slice(0, 10)}:${part}`;
      if (!hourlyParts.has(key)) hourlyParts.set(key, new Map());
      hourlyParts.get(key).set(hour, temperature);
    }
  }
  const forecasts = [];
  const months = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
  ];
  for (const card of cards.slice(0, 2)) {
    const label = String(card[2]).replaceAll("&nbsp;", " ");
    const match = /(\d{1,2})\s+([а-я]+)/i.exec(label);
    if (!match || !baseDate) continue;
    const month = months.indexOf(match[2].toLowerCase()) + 1;
    if (!month) continue;
    let year = Number(baseDate.slice(0, 4));
    if (Number(baseDate.slice(5, 7)) - month > 6) year++;
    if (month - Number(baseDate.slice(5, 7)) > 6) year--;
    const day = {
      date: `${year}-${String(month).padStart(2, "0")}-${match[1].padStart(2, "0")}`,
      parts: [],
    };
    walk(
      card,
      (value) => {
        if (
          !Array.isArray(value) ||
          !["morning", "day", "evening", "night"].includes(value[2])
        )
          return;
        const name = value[2],
          prefix = name[0];
        let temperature, description, iconUrl;
        walk(
          value[3],
          (node) => {
            const area = node.style?.gridArea;
            if (
              area === `${prefix}-temp` &&
              typeof node.children === "string"
            ) {
              const parsed = /^([+−-]?\d+(?:[.,]\d+)?)°$/.exec(node.children);
              if (parsed)
                temperature = Number(
                  parsed[1].replace("−", "-").replace(",", "."),
                );
            }
            if (area === `${prefix}-text` && typeof node.children === "string")
              description =
                russianConditions[node.children.toLowerCase()] || "unknown";
            if (area === `${prefix}-icon`) iconUrl ||= pageForecastIcon(node);
          },
          true,
        );
        const hours = hourlyParts.get(`${day.date}:${name}`);
        const temperatures =
          hours?.size === 6 ? [...hours.values()] : [temperature];
        if (Number.isFinite(temperature))
          day.parts.push({
            part_name: name,
            temp_min: Math.min(...temperatures),
            temp_max: Math.max(...temperatures),
            condition: description || "unknown",
            daytime: ["night", "evening"].includes(name) ? "n" : "d",
            ...(iconUrl ? { iconUrl } : {}),
          });
      },
      true,
    );
    forecasts.push(day);
  }
  const iconUrl = pageIcon(fact.iconUrl || fact.icon);
  let weather;
  try {
    weather = normalizeWeather(
      {
        info: location,
        fact: {
          temp: fact.temperatureInCelsius,
          feels_like: fact.feelsLikeInCelsius,
          condition: condition(fact.condition),
          daytime: fact.daytime === "NIGHT" ? "n" : "d",
          wind_speed: fact.windSpeedInMetersPerSecond,
          wind_dir: wind[fact.windDirection],
          pressure_mm: fact.pressure,
          humidity: fact.humidity,
          ...(iconUrl ? { iconUrl } : {}),
        },
        forecasts,
      },
      fetchedAt,
    );
  } catch {
    throw pageFormatError(html);
  }
  weather.forecastSource = "page";
  weather.provider = "yandex-page";
  return weather;
}
// Classify a changed response separately from transient network failures.
function pageFormatError(body) {
  const challenge =
    typeof body === "string" &&
    /(?:showcaptcha|checkcaptcha|smartcaptcha|captcha-container|<title[^>]*>[^<]*(?:captcha|проверка|робот|robot)|подтвердите,? что вы не робот)/i.test(
      body,
    );
  const error = Error(
    challenge
      ? "Яндекс запросил проверку доступа"
      : "Изменился формат ответа Яндекс Погоды",
  );
  error.code = challenge ? "ACCESS_CHALLENGE" : "FORMAT_CHANGED";
  return error;
}
function pageActionRequest(page, source, actionId) {
  if (typeof actionId !== "string" || !/^[a-f0-9]{40,42}$/i.test(actionId))
    throw pageFormatError("");
  const url = pageRequestUrl(page, source);
  const location = source.location || source;
  const segments = url.pathname.split("/").filter(Boolean);
  const locale = segments.length === 3 ? segments[1] : "ru";
  return {
    url,
    options: {
      method: "POST",
      headers: {
        "Next-Action": actionId,
        "Content-Type": "text/plain;charset=UTF-8",
        Accept: "text/x-component",
        Origin: url.origin,
      },
      body: JSON.stringify([
        {
          page: "main",
          routeParams: {
            serviceNameRoute: "pogoda",
            localeRoute: locale,
            slugRoute: segments.at(-1),
          },
          searchParams: {
            lat: String(location.lat),
            lon: String(location.lon),
          },
          lat: location.lat,
          lon: location.lon,
        },
      ]),
    },
  };
}
function parsePageAction(
  body,
  location,
  fetchedAt = Date.now(),
  previousWeather,
) {
  if (typeof body !== "string" || Buffer.byteLength(body) > 512 * 1024)
    throw pageFormatError(body);
  let data;
  for (const line of body.split("\n")) {
    const row = /^[a-f\d]+:([\s\S]*)$/i.exec(line);
    if (!row) continue;
    try {
      const record = JSON.parse(row[1]);
      if (
        record?.data?.weather?.now &&
        typeof record.data.weather.now === "object"
      ) {
        data = record.data;
        break;
      }
    } catch {
      /* Flight error/module records cannot supply weather. */
    }
  }
  const now = data?.weather.now;
  const temperature =
    now?.temperatureInCelsius ?? now?.tempC ?? now?.temperature ?? now?.temp;
  if (
    !Number.isFinite(temperature) ||
    typeof now?.condition !== "string" ||
    !now.condition.trim()
  )
    throw pageFormatError(body);
  let previous;
  if (
    previousWeather?.location?.lat === location.lat &&
    previousWeather?.location?.lon === location.lon
  ) {
    try {
      previous = restoreWeather(previousWeather);
    } catch {
      /* Ignore invalid previous snapshots. */
    }
  }
  const iconUrl = pageIcon(now.iconUrl || now.icon);
  let weather;
  try {
    weather = normalizeWeather(
      {
        info: location,
        fact: {
          temp: temperature,
          condition: condition(now.condition),
          daytime: ["NIGHT", "n"].includes(now.daytime) ? "n" : "d",
          feels_like: now.feelsLikeInCelsius ?? now.feelsLike,
          wind_speed:
            now.windSpeedInMetersPerSecond ?? now.windSpeedMps ?? now.windSpeed,
          wind_dir: wind[now.windDirection] || now.windDir,
          pressure_mm: now.pressure ?? now.pressureMm,
          humidity: now.humidity,
          obs_time: Number(data.serverTimestamp),
          ...(iconUrl ? { iconUrl } : {}),
        },
      },
      fetchedAt,
    );
  } catch {
    throw pageFormatError(body);
  }
  if (previous) {
    for (const field of ["feelsLike", "humidity", "windDir"]) {
      if (weather[field] === null) weather[field] = previous[field];
    }
    // The lightweight action has no forecast. Keep its original dates and values.
    weather.forecast = previous.forecast;
    if (previous.forecastSource)
      weather.forecastSource = previous.forecastSource;
    weather.sunrise = previous.sunrise;
    weather.sunset = previous.sunset;
  }
  weather.provider = "yandex-page";
  return weather;
}
function pageActionAssets(html) {
  if (typeof html !== "string" || Buffer.byteLength(html) > MAX_PAGE_BYTES)
    throw pageFormatError(html);
  const assets = [];
  for (const match of html.matchAll(
    /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/gi,
  )) {
    try {
      const url = new URL(match[1]);
      if (
        url.protocol === "https:" &&
        url.hostname === "weather.yastatic.net" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.search &&
        !url.hash &&
        /^\/s3\/weather-frontend\/front2\/_next\/static\/chunks\/[a-zA-Z0-9_/%@.\[\]-]+\.js$/.test(
          url.pathname,
        )
      )
        assets.push(url.toString());
    } catch {
      /* Ignore untrusted script locations. */
    }
  }
  const unique = [...new Set(assets)];
  // Stable module number from the observed app build; discover the action anew,
  // never pin its build-specific identifier. Try other page chunks after it.
  return unique
    .filter((url) => /\/6998-/.test(url))
    .concat(unique.filter((url) => !/\/6998-/.test(url)).reverse())
    .slice(0, 8);
}
function findPageAction(js) {
  if (typeof js !== "string" || Buffer.byteLength(js) > 2 * 1024 * 1024)
    return null;
  const match =
    /createServerReference\)?\s*\(\s*["']([a-f0-9]{40,42})["'][^;]{0,400}?["']getMapsUserLocationDataAction["']/i.exec(
      js,
    );
  return match ? match[1] : null;
}
module.exports = {
  parsePage,
  validatePageUrl,
  pageRequestUrl,
  MAX_PAGE_BYTES,
  pageActionRequest,
  parsePageAction,
  pageActionAssets,
  findPageAction,
};
