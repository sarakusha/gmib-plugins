"use strict";

const defaults = require("../public/defaults.json");
const object = (value) =>
  value && typeof value === "object" && !Array.isArray(value);
const fail = (message) => {
  throw new Error(message);
};
const number = (value, min, max) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const optional = (value, min, max) => (number(value, min, max) ? value : null);
const text = (value, fallback = "") =>
  typeof value === "string" ? value.slice(0, 100) : fallback;
const dateOptions = new Set([
  "dateStyle",
  "weekday",
  "era",
  "year",
  "month",
  "day",
]);
const calendarDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;
  const timestamp = Date.parse(`${value}T00:00:00Z`);
  return (
    Number.isFinite(timestamp) &&
    new Date(timestamp).toISOString().slice(0, 10) === value
  );
};

// Remote images remain data: only Yandex's weather asset hosts are accepted.
function safeIconUrl(value) {
  if (typeof value !== "string" || value.length > 1000) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ((url.hostname === "yastatic.net" &&
        url.pathname.startsWith("/weather/")) ||
        url.hostname === "weather.yastatic.net") &&
      /\.(?:svg|png|webp)$/.test(url.pathname)
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function validateSettings(value) {
  if (!object(value)) fail("Настройки должны быть объектом");
  const result = structuredClone(defaults);
  for (const key of Object.keys(result)) {
    if (!object(value[key])) fail(`Не задана группа ${key}`);
    for (const field of Object.keys(result[key])) {
      if (key === "styles") {
        let style = value.styles[field];
        // Older saved settings used the weather style for all weather text.
        // Only absent new groups migrate; explicitly malformed styles remain errors.
        if (
          ["forecast", "metrics"].includes(field) &&
          !Object.hasOwn(value.styles, field) &&
          object(value.styles.weather)
        ) {
          style = { ...value.styles.weather };
          if (field === "metrics")
            style.size = Math.min(
              160,
              Math.max(8, Math.round((style.size * 14) / 18)),
            );
        }
        if (
          !object(style) ||
          !["sans", "mono", "serif"].includes(style.font) ||
          !number(style.size, 8, 160) ||
          !/^#[0-9a-f]{6}$/i.test(style.color)
        )
          fail(`Некорректное оформление: ${field}`);
        result.styles[field] = {
          font: style.font,
          size: style.size,
          color: style.color,
        };
      } else
        result[key][field] =
          key === "appearance" &&
          ["backdrop", "showSource", "sourceSize", "valueAnimation"].includes(
            field,
          ) &&
          value[key][field] === undefined
            ? defaults.appearance[field]
            : value[key][field];
    }
  }
  const { layout, clock, date, appearance, slides } = result;
  if (
    !["auto", "wide", "compact"].includes(layout.mode) ||
    !number(layout.leftWidth, 160, 1920)
  )
    fail("Некорректная ширина или режим");
  if (
    typeof clock.seconds !== "boolean" ||
    typeof clock.locale !== "string" ||
    clock.locale.length > 40 ||
    typeof clock.timeZone !== "string" ||
    !clock.timeZone ||
    clock.timeZone.length > 80
  )
    fail("Некорректные настройки часов");
  if (
    ![1, 2].includes(date.lines) ||
    typeof date.weekday !== "boolean" ||
    !object(date.options)
  )
    fail("Некорректные настройки даты");
  if (
    Object.keys(date.options).some((key) => !dateOptions.has(key)) ||
    Object.values(date.options).some(
      (value) => typeof value !== "string" || value.length > 20,
    )
  )
    fail("Разрешены только параметры формата даты Intl");
  // Accept legacy era settings without resetting other preferences; era is no longer shown.
  date.options = { ...date.options };
  delete date.options.era;
  try {
    new Intl.DateTimeFormat(clock.locale, {
      ...date.options,
      timeZone: clock.timeZone,
    }).format();
  } catch {
    fail("Проверьте локаль, часовой пояс и параметры Intl.DateTimeFormat");
  }
  if (
    typeof appearance.showSource !== "boolean" ||
    !number(appearance.sourceSize, 8, 160) ||
    !["gradient", "photo"].includes(appearance.backdrop) ||
    !["none", "flip"].includes(appearance.valueAnimation) ||
    !["auto", "day", "dusk", "night"].includes(appearance.theme) ||
    !number(appearance.shadow, 0, 1) ||
    !number(appearance.dim, 0, 1) ||
    !number(appearance.outline, 0, 3)
  )
    fail("Некорректные параметры фона");
  if (
    !number(slides.seconds, 3, 120) ||
    ["current", "details", "forecast"].some(
      (key) => typeof slides[key] !== "boolean",
    ) ||
    ![slides.current, slides.details, slides.forecast].some(Boolean)
  )
    fail("Включите хотя бы один слайд; интервал — 3–120 секунд");
  return structuredClone(result);
}

function normalizeWeather(raw, fetchedAt = Date.now()) {
  if (
    !object(raw) ||
    !object(raw.fact) ||
    !number(raw.fact.temp, -100, 70) ||
    typeof raw.fact.condition !== "string" ||
    !raw.fact.condition ||
    raw.fact.condition.length > 80
  )
    fail("Нужен ответ Яндекса с fact.temp и fact.condition");
  const fact = raw.fact;
  const days = Array.isArray(raw.forecasts)
    ? raw.forecasts.slice(0, 2)
    : [raw.forecast];
  const forecast = [];
  for (const day of days) {
    if (!object(day) || !calendarDate(day.date)) continue;
    const parts = Array.isArray(day.parts)
      ? day.parts
      : object(day.parts)
        ? Object.entries(day.parts).map(([part_name, data]) => ({
            ...data,
            part_name,
          }))
        : [];
    for (const part of parts) {
      if (
        !object(part) ||
        !["day", "evening", "night", "morning"].includes(part.part_name)
      )
        continue;
      const tempMin = optional(part.temp_min, -100, 70),
        tempMax = optional(part.temp_max, -100, 70);
      if (tempMin === null || tempMax === null || tempMin > tempMax) continue;
      forecast.push({
        date: day.date,
        part: part.part_name,
        tempMin,
        tempMax,
        condition: text(part.condition, "unknown"),
        daytime: part.daytime === "n" ? "n" : "d",
        precipitationProbability: optional(part.prec_prob, 0, 100),
        ...(safeIconUrl(part.iconUrl)
          ? { iconUrl: safeIconUrl(part.iconUrl) }
          : {}),
      });
    }
  }
  const first = days.find(object);
  const sun = (value) =>
    typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)
      ? value
      : null;
  const observed = number(fact.obs_time, 0, 1e11)
    ? fact.obs_time
    : number(raw.now, 0, 1e11)
      ? raw.now
      : null;
  return {
    provider: "yandex-informers",
    providerName: "Яндекс Погода",
    location: {
      lat: optional(raw.info?.lat, -90, 90),
      lon: optional(raw.info?.lon, -180, 180),
    },
    observedAt: observed === null ? null : observed * 1000,
    fetchedAt,
    temp: fact.temp,
    ...(safeIconUrl(fact.iconUrl)
      ? { iconUrl: safeIconUrl(fact.iconUrl) }
      : {}),
    feelsLike: optional(fact.feels_like, -120, 80),
    condition: fact.condition,
    daytime: fact.daytime === "n" ? "n" : "d",
    windSpeed: optional(fact.wind_speed, 0, 150),
    windDir: ["n", "ne", "e", "se", "s", "sw", "w", "nw", "c"].includes(
      fact.wind_dir,
    )
      ? fact.wind_dir
      : null,
    pressureMm: optional(fact.pressure_mm, 300, 850),
    humidity: optional(fact.humidity, 0, 100),
    forecast: forecast.slice(0, 8),
    sunrise: sun(first?.sunrise),
    sunset: sun(first?.sunset),
  };
}

// Rehydrate through the same allowlist as untrusted provider/import input.
function restoreWeather(value) {
  if (
    !object(value) ||
    !Array.isArray(value.forecast) ||
    !number(value.fetchedAt, 0, 1e15)
  )
    fail("Повреждённый кеш");
  const groups = new Map();
  for (const item of value.forecast.slice(0, 8)) {
    if (!object(item)) continue;
    if (!groups.has(item.date))
      groups.set(item.date, { date: item.date, parts: [] });
    groups.get(item.date).parts.push({
      part_name: item.part,
      temp_min: item.tempMin,
      temp_max: item.tempMax,
      condition: item.condition,
      daytime: item.daytime,
      prec_prob: item.precipitationProbability,
      iconUrl: item.iconUrl,
    });
  }
  const forecasts = [...groups.values()];
  if (forecasts[0])
    Object.assign(forecasts[0], {
      sunrise: value.sunrise,
      sunset: value.sunset,
    });
  const restored = normalizeWeather(
    {
      info: value.location,
      fact: {
        temp: value.temp,
        iconUrl: value.iconUrl,
        feels_like: value.feelsLike,
        condition: value.condition,
        daytime: value.daytime,
        obs_time:
          typeof value.observedAt === "number" ? value.observedAt / 1000 : null,
        wind_speed: value.windSpeed,
        wind_dir: value.windDir,
        pressure_mm: value.pressureMm,
        humidity: value.humidity,
      },
      forecasts,
    },
    value.fetchedAt,
  );
  if (["yandex-forecast", "yandex-page"].includes(value.provider))
    restored.provider = value.provider;
  return restored;
}

exports.defaults = defaults;
exports.validateSettings = validateSettings;
exports.normalizeWeather = normalizeWeather;
exports.restoreWeather = restoreWeather;

exports.safeIconUrl = safeIconUrl;
