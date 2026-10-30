"use strict";

const { normalizeWeather } = require("./model.cjs");
const DAY = 86400000;
const MOSCOW = 3 * 3600000;
const ENDPOINT = "https://api.weather.yandex.ru/v2/informers";
const dayAt = (now) => new Date(now + MOSCOW).toISOString().slice(0, 10);
const resetAt = (now) => (Math.floor((now + MOSCOW) / DAY) + 1) * DAY - MOSCOW;
const finite = (value, min, max) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;

function validateSource(value, previous) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !finite(value.lat, -90, 90) ||
    !finite(value.lon, -180, 180) ||
    !Number.isSafeInteger(value.dailyLimit) ||
    value.dailyLimit < 1 ||
    value.dailyLimit > 10000 ||
    typeof value.useLastResponse !== "boolean"
  )
    throw Error("Проверьте координаты и суточный лимит (1–10000).");
  let apiKey = previous?.apiKey || "";
  if (value.apiKey !== undefined && value.apiKey !== "") {
    if (
      typeof value.apiKey !== "string" ||
      !/^[a-zA-Z0-9_-]{16,200}$/.test(value.apiKey)
    )
      throw Error("Проверьте ключ API Яндекс Погоды.");
    apiKey = value.apiKey;
  }
  if (!value.useLastResponse && !apiKey)
    throw Error("Для обновления погоды укажите ключ API.");
  return {
    lat: value.lat,
    lon: value.lon,
    dailyLimit: value.dailyLimit,
    useLastResponse: value.useLastResponse,
    apiKey,
  };
}

function restoreSource(saved, weather) {
  const fallback = {
    lat: weather.location.lat ?? 56.6333,
    lon: weather.location.lon ?? 47.8908,
    dailyLimit: 50,
    useLastResponse: true,
    apiKey: "",
  };
  try {
    return validateSource(saved, fallback);
  } catch {
    return fallback;
  }
}

function usageAt(saved, now, legacyAttempt) {
  const count = (value) =>
    Number.isSafeInteger(value) && value >= 0 ? value : 0;
  const legacy = finite(legacyAttempt, 1, 1e15) ? legacyAttempt : null;
  const usage =
    saved && typeof saved === "object"
      ? saved
      : {
          day: legacy ? dayAt(legacy) : dayAt(now),
          used: legacy ? 1 : 0,
          total: legacy ? 1 : 0,
          lastAttemptAt: legacy,
        };
  const sameDay = usage.day === dayAt(now);
  return {
    day: dayAt(now),
    used: sameDay ? count(usage.used) : 0,
    total: Math.max(count(usage.total), count(usage.used)),
    lastAttemptAt: finite(usage.lastAttemptAt, 0, 1e15)
      ? usage.lastAttemptAt
      : null,
    nextRequestAt:
      sameDay && finite(usage.nextRequestAt, 0, 1e15)
        ? usage.nextRequestAt
        : null,
    blockedUntil:
      sameDay && finite(usage.blockedUntil, 0, 1e15)
        ? usage.blockedUntil
        : null,
  };
}

// Store a usable test response through an allowlist, never arbitrary provider fields.
function testResponse(weather) {
  const groups = new Map();
  for (const part of weather.forecast) {
    if (!groups.has(part.date))
      groups.set(part.date, { date: part.date, parts: [] });
    groups.get(part.date).parts.push({
      part_name: part.part,
      temp_min: part.tempMin,
      temp_max: part.tempMax,
      condition: part.condition,
      daytime: part.daytime,
      prec_prob: part.precipitationProbability,
    });
  }
  const forecasts = [...groups.values()];
  if (forecasts[0])
    Object.assign(forecasts[0], {
      sunrise: weather.sunrise,
      sunset: weather.sunset,
    });
  return {
    info: weather.location,
    fact: {
      temp: weather.temp,
      feels_like: weather.feelsLike,
      condition: weather.condition,
      daytime: weather.daytime,
      obs_time:
        weather.observedAt === null ? undefined : weather.observedAt / 1000,
      wind_speed: weather.windSpeed,
      wind_dir: weather.windDir,
      pressure_mm: weather.pressureMm,
      humidity: weather.humidity,
    },
    forecasts,
  };
}

function createWeatherService({
  getRecord,
  persist,
  serial,
  logger,
  runtime = {},
}) {
  const now = runtime.now || Date.now;
  const setTimer = runtime.setTimeout || setTimeout;
  const clearTimer = runtime.clearTimeout || clearTimeout;
  const request = runtime.fetch || ((...args) => fetch(...args));
  let timer = null,
    disposed = false,
    controller = null;
  const dueAt = (record, usage, at) => {
    const reset = resetAt(at);
    if (usage.used >= record.source.dailyLimit) return reset;
    if (usage.blockedUntil && usage.blockedUntil > at)
      return usage.blockedUntil;
    if (usage.nextRequestAt !== null) return usage.nextRequestAt;
    if (
      usage.lastAttemptAt !== null &&
      dayAt(usage.lastAttemptAt) === usage.day
    ) {
      const remaining = Math.max(0, record.source.dailyLimit - usage.used);
      return Math.min(
        reset,
        usage.lastAttemptAt +
          Math.max(60000, (reset - usage.lastAttemptAt) / (remaining + 1)),
      );
    }
    return at;
  };
  function state() {
    const record = getRecord(),
      at = now(),
      usage = usageAt(record.usage, at);
    const { apiKey, ...source } = record.source;
    return {
      source: { ...source, hasApiKey: Boolean(apiKey) },
      cache: {
        mode: source.useLastResponse ? "frozen" : "live",
        usedToday: usage.used,
        totalRequests: usage.total,
        remaining: Math.max(0, source.dailyLimit - usage.used),
        resetAt: resetAt(at),
        nextRequestAt:
          !source.useLastResponse && apiKey ? dueAt(record, usage, at) : null,
        lastAttemptAt: usage.lastAttemptAt,
        fetchedAt: record.weather.fetchedAt,
        message: record.cache?.message || "",
      },
    };
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const record = getRecord();
    if (disposed) return;
    const at = now(),
      usage = usageAt(record.usage, at);
    const frozen = record.source.useLastResponse || !record.source.apiKey;
    const delay = Math.max(
      0,
      (frozen ? resetAt(at) : dueAt(record, usage, at)) - at,
    );
    timer = setTimer(
      () => {
        timer = null;
        return serial(tick).catch(() => {
          logger.warn(
            "Informer: обновление погоды не выполнено; повтор отложен",
          );
          // A failed durable reservation must not become a tight retry loop.
          if (!disposed) {
            timer = setTimer(schedule, 60000);
            timer?.unref?.();
          }
        });
      },
      Math.min(delay, 2147483647),
    );
    timer?.unref?.();
  }
  async function tick() {
    if (disposed) return;
    let record = getRecord();
    const at = now(),
      usage = usageAt(record.usage, at);
    if (record.usage.day !== usage.day) {
      await persist({ ...record, usage });
      record = getRecord();
    }
    if (disposed) return;
    if (record.source.useLastResponse || !record.source.apiKey) {
      schedule();
      return;
    }
    if (dueAt(record, usage, at) > at) {
      schedule();
      return;
    }
    const used = usage.used + 1;
    const nextRequestAt = Math.min(
      resetAt(at),
      at +
        Math.max(
          60000,
          (resetAt(at) - at) /
            (Math.max(0, record.source.dailyLimit - used) + 1),
        ),
    );
    // Persist the attempt before dispatch, including errors and interrupted processes.
    await persist({
      ...record,
      usage: {
        ...usage,
        used,
        total: usage.total + 1,
        lastAttemptAt: at,
        nextRequestAt,
      },
      cache: { message: "Обновление погоды…" },
    });
    if (disposed) return;
    record = getRecord();
    let response;
    controller = new AbortController();
    try {
      const url = new URL(ENDPOINT);
      url.searchParams.set("lat", String(record.source.lat));
      url.searchParams.set("lon", String(record.source.lon));
      url.searchParams.set("lang", "ru_RU");
      response = await request(url, {
        headers: { "X-Yandex-Weather-Key": record.source.apiKey },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
        redirect: "error",
      });
      if (!response.ok) throw Error("provider");
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          controller.abort();
          throw Error("response too large");
        }
        chunks.push(Buffer.from(chunk));
      }
      const raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const weather = normalizeWeather(
        { ...raw, info: { lat: record.source.lat, lon: record.source.lon } },
        now(),
      );
      if (!disposed)
        await persist({
          ...getRecord(),
          weather,
          testResponse: testResponse(weather),
          cache: { message: "" },
        });
    } catch {
      if (!disposed) {
        const current = getRecord();
        const blocked = [401, 403, 429].includes(response?.status);
        await persist({
          ...current,
          usage: {
            ...current.usage,
            blockedUntil: blocked ? resetAt(now()) : null,
          },
          cache: {
            message: `Погода не обновлена.${response && !response.ok ? ` HTTP ${response.status}.` : ""} Используется последний ответ.${blocked ? " Следующая попытка — после сброса лимита." : ""}`,
          },
        });
      }
    } finally {
      controller = null;
      schedule();
    }
  }
  return {
    state,
    schedule,
    dispose() {
      disposed = true;
      if (timer !== null) clearTimer(timer);
      controller?.abort();
    },
  };
}

module.exports = {
  dayAt,
  resetAt,
  usageAt,
  validateSource,
  restoreSource,
  testResponse,
  createWeatherService,
};
