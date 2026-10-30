"use strict";
const {
  dayAt,
  resetAt,
  fingerprint,
  validateSource,
  restoreSource,
  counterAt,
  usageAt,
  restoreUsage,
  poolSignature,
} = require("./weather-keys.cjs");
const { requestUrl, adaptResponse } = require("./weather-providers.cjs");
const {
  pageCacheAt,
  createPageService,
} = require("./weather-page-service.cjs");

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
      ...(part.iconUrl ? { iconUrl: part.iconUrl } : {}),
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
      ...(weather.iconUrl ? { iconUrl: weather.iconUrl } : {}),
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
  const now = runtime.now || Date.now,
    setTimer = runtime.setTimeout || setTimeout,
    clearTimer = runtime.clearTimeout || clearTimeout;
  const request = runtime.fetch || ((...args) => fetch(...args));
  let timer = null,
    disposed = false,
    controller = null;
  const pageService = createPageService({
    getRecord,
    persist,
    request,
    now,
    isDisposed: () => disposed,
    testResponse,
  });
  function entries(record, usage, at) {
    return record.source.keys.map((key) => {
      const hash = key.apiKey ? fingerprint(key.apiKey) : null;
      const counter = counterAt(hash ? usage.keys[hash] : null, at);
      const remaining =
        key.apiKey && counter.blockedUntil <= at
          ? Math.max(0, key.dailyLimit - counter.used)
          : 0;
      return { key, hash, counter, remaining };
    });
  }
  const available = (record, usage, at) =>
    entries(record, usage, at).reduce((sum, key) => sum + key.remaining, 0);
  function dueAt(record, usage, at) {
    const remaining = available(record, usage, at),
      reset = resetAt(at);
    if (!remaining) return reset;
    if (usage.nextRequestAt !== null) return usage.nextRequestAt;
    if (
      usage.lastAttemptAt !== null &&
      dayAt(usage.lastAttemptAt) === usage.day
    )
      return Math.min(
        reset,
        usage.lastAttemptAt +
          Math.max(60000, (reset - usage.lastAttemptAt) / (remaining + 1)),
      );
    return at;
  }
  function state() {
    const record = getRecord(),
      at = now(),
      usage = usageAt(record.usage, at);
    const keys = entries(record, usage, at).map(
      ({ key, counter, remaining }) => ({
        id: key.id,
        name: key.name,
        type: key.type,
        dailyLimit: key.dailyLimit,
        hasApiKey: Boolean(key.apiKey),
        detectedType: counter.detectedType,
        usedToday: counter.used,
        requestsToday: counter.attempts,
        totalRequests: counter.total,
        remaining: key.apiKey ? Math.max(0, key.dailyLimit - counter.used) : 0,
        invalid:
          counter.blockedUntil > at &&
          [401, 403, 404].includes(counter.lastStatus),
        blockedUntil: counter.blockedUntil,
        lastStatus: counter.lastStatus,
        message: counter.message,
      }),
    );
    const hasApiKey = keys.some((key) => key.hasApiKey);
    return {
      source: {
        lat: record.source.lat,
        lon: record.source.lon,
        useLastResponse: record.source.useLastResponse,
        keys,
        dailyLimit: keys.reduce((sum, key) => sum + key.dailyLimit, 0),
        hasApiKey,
        page: { ...record.source.page },
      },
      cache: {
        mode: record.source.useLastResponse ? "frozen" : "live",
        usedToday: usage.used,
        totalRequests: usage.total,
        requestsToday: usage.attempts,
        remaining: available(record, usage, at),
        resetAt: resetAt(at),
        nextRequestAt:
          !record.source.useLastResponse && hasApiKey
            ? dueAt(record, usage, at)
            : null,
        nextUpdateAt: record.source.useLastResponse
          ? null
          : Math.min(
                hasApiKey ? dueAt(record, usage, at) : Infinity,
                pageService.dueAt(record, at),
              ) === Infinity
            ? null
            : Math.min(
                hasApiKey ? dueAt(record, usage, at) : Infinity,
                pageService.dueAt(record, at),
              ),
        page: pageService.state(record, at),
        lastAttemptAt: usage.lastAttemptAt,
        fetchedAt: record.weather.fetchedAt,
        message: record.cache?.message || "",
      },
    };
  }
  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (disposed) return;
    const record = getRecord(),
      at = now(),
      usage = usageAt(record.usage, at);
    const frozen =
      record.source.useLastResponse ||
      (!record.source.keys.some((key) => key.apiKey) &&
        !record.source.page.enabled);
    timer = setTimer(
      () => {
        timer = null;
        return serial(tick).catch(() => {
          logger.warn(
            "Informer: обновление погоды не выполнено; повтор отложен",
          );
          if (!disposed) {
            if (timer !== null) clearTimer(timer);
            timer = setTimer(schedule, 60000);
            timer?.unref?.();
          }
        });
      },
      Math.min(
        2147483647,
        Math.max(
          0,
          (frozen
            ? resetAt(at)
            : Math.min(
                resetAt(at),
                record.source.keys.some((key) => key.apiKey)
                  ? dueAt(record, usage, at)
                  : Infinity,
                pageService.dueAt(record, at),
              )) - at,
        ),
      ),
    );
    timer?.unref?.();
  }
  async function saveOutcome(hash, patch, weather, refundDay) {
    const record = getRecord(),
      usage = usageAt(record.usage, now());
    const counter = counterAt(usage.keys[hash], now());
    // A known non-billable response refunds only its own day's reservation.
    if (refundDay === usage.day) {
      usage.used = Math.max(0, usage.used - 1);
      counter.used = Math.max(0, counter.used - 1);
    }
    usage.keys[hash] = { ...counter, ...patch };
    if (weather) weather.forecastSource = "api";
    const remaining = available(record, usage, now());
    usage.nextRequestAt = Math.min(
      resetAt(now()),
      usage.lastAttemptAt +
        Math.max(
          60000,
          (resetAt(now()) - usage.lastAttemptAt) / (remaining + 1),
        ),
    );
    await persist({
      ...record,
      usage,
      ...(weather
        ? {
            weather,
            testResponse: testResponse(weather),
            pageCache: pageService.afterApiSuccess(record, now()),
          }
        : {}),
      cache: { message: weather ? "" : patch.message || "" },
    });
  }
  async function attempt(key, type) {
    if (disposed) return { stopped: true };
    const record = getRecord(),
      at = now(),
      usage = usageAt(record.usage, at),
      hash = fingerprint(key.apiKey);
    const counter = counterAt(usage.keys[hash], at);
    if (counter.used >= key.dailyLimit || counter.blockedUntil > at)
      return { stopped: true };
    usage.keys[hash] = {
      ...counter,
      used: counter.used + 1,
      attempts: counter.attempts + 1,
      total: counter.total + 1,
      lastAttemptAt: at,
    };
    usage.used++;
    usage.attempts++;
    usage.total++;
    usage.lastAttemptAt = at;
    const remaining = available(record, usage, at);
    usage.nextRequestAt = Math.min(
      resetAt(at),
      at + Math.max(60000, (resetAt(at) - at) / (remaining + 1)),
    );
    // Every probe and failed request is durably reserved before dispatch.
    await persist({
      ...record,
      usage,
      cache: { message: "Обновление погоды…" },
    });
    if (disposed) return { stopped: true };
    let response;
    controller = new AbortController();
    try {
      response = await request(requestUrl(type, record.source), {
        headers: { "X-Yandex-Weather-Key": key.apiKey },
        signal: AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(15000),
        ]),
        redirect: "error",
      });
      if (!response.ok) return { status: response.status, day: usage.day };
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) {
          controller.abort();
          throw Error("too large");
        }
        chunks.push(Buffer.from(chunk));
      }
      const weather = adaptResponse(
        JSON.parse(Buffer.concat(chunks).toString("utf8")),
        type,
        record.source,
        now(),
      );
      return { status: response.status, weather, day: usage.day };
    } catch {
      return { status: response?.status || null, failed: true, day: usage.day };
    } finally {
      controller = null;
    }
  }
  async function tick() {
    if (disposed) return;
    let record = getRecord(),
      at = now(),
      usage = usageAt(record.usage, at);
    const pageCache = pageCacheAt(record.pageCache, at);
    if (
      record.usage.day !== usage.day ||
      record.pageCache.day !== pageCache.day
    ) {
      await persist({ ...record, usage, pageCache });
      record = getRecord();
    }
    if (disposed) return;
    if (record.source.useLastResponse) {
      schedule();
      return;
    }
    if (
      !record.source.keys.some((key) => key.apiKey) ||
      dueAt(record, usage, at) > at
    ) {
      try {
        if (pageService.dueAt(record, at) <= at) await pageService.tick();
      } finally {
        schedule();
      }
      return;
    }
    const eligible = entries(record, usage, at)
      .filter((item) => item.remaining > 0)
      .sort(
        (a, b) =>
          b.remaining / b.key.dailyLimit - a.remaining / a.key.dailyLimit ||
          a.key.id.localeCompare(b.key.id),
      );
    if (!eligible.length) {
      schedule();
      return;
    }
    const { key, hash, counter } = eligible[0];
    const unknown = key.type === "auto" && !counter.detectedType;
    let type =
      key.type === "auto"
        ? counter.detectedType || (key.dailyLimit === 50 ? "site" : "home")
        : key.type;
    try {
      let result = await attempt(key, type);
      if (disposed || result.stopped) return;
      // A 403/404 from an unclassified key can mean the other v2 endpoint is required.
      // Bound auto detection to two requests; each attempt is counted and reserves quota before dispatch.
      if (unknown && [403, 404].includes(result.status) && !result.failed) {
        await saveOutcome(
          hash,
          { lastStatus: result.status, message: "Проверка другого API…" },
          null,
          result.day,
        );
        const current = usageAt(getRecord().usage, now());
        const entry = counterAt(current.keys[hash], now());
        if (entry.used < key.dailyLimit) {
          type = type === "home" ? "site" : "home";
          result = await attempt(key, type);
        } else result = { ...result, day: null };
      }
      if (disposed || result.stopped) return;
      if (result.weather)
        await saveOutcome(
          hash,
          {
            detectedType: type,
            lastStatus: result.status,
            message: "",
            blockedUntil: 0,
          },
          result.weather,
        );
      else {
        const blocked = [401, 403, 404, 429].includes(result.status);
        const message = `Погода не обновлена.${result.status ? ` HTTP ${result.status}.` : ""} Используется последний ответ.${blocked ? " Этот ключ приостановлен до сброса суток." : ""}`;
        await saveOutcome(
          hash,
          {
            lastStatus: result.status,
            message,
            blockedUntil: blocked ? resetAt(now()) : 0,
          },
          null,
          [403, 404].includes(result.status) ? result.day : null,
        );
      }
    } finally {
      schedule();
    }
  }
  return {
    state,
    schedule,
    resumePage: pageService.resume,
    dispose() {
      disposed = true;
      pageService.dispose();
      if (timer !== null) clearTimer(timer);
      controller?.abort();
    },
  };
}
module.exports = {
  dayAt,
  resetAt,
  usageAt,
  restoreUsage,
  validateSource,
  restoreSource,
  poolSignature,
  testResponse,
  createWeatherService,
};
