"use strict";
const dayAt = (at) => new Date(at + 10800000).toISOString().slice(0, 10);
const {
  parsePage,
  validatePageUrl,
  pageRequestUrl,
  MAX_PAGE_BYTES,
  pageActionRequest,
  parsePageAction,
  pageActionAssets,
  findPageAction,
} = require("./weather-page.cjs");
const { mergeForecast } = require("./weather-forecast.cjs");
const DAY = 86400000;
// Bump when parsing changes require rebuilding weather from full HTML.
const PAGE_PARSER_REVISION = 2;
const pageDefaults = Object.freeze({
  enabled: false,
  url: "",
  intervalMinutes: 15,
});
const validTime = (value) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= 1e15;
function validatePage(value = pageDefaults) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.enabled !== "boolean" ||
    !Number.isInteger(value.intervalMinutes) ||
    value.intervalMinutes < 5 ||
    value.intervalMinutes > 1440 ||
    typeof value.url !== "string" ||
    value.url.length > 2048
  )
    throw Error("Проверьте адрес страницы и интервал от 5 до 1440 минут.");
  const url = value.url ? validatePageUrl(value.url) : "";
  if (value.enabled && !url)
    throw Error("Укажите адрес страницы Яндекс Погоды.");
  return {
    enabled: value.enabled,
    url,
    intervalMinutes: value.intervalMinutes,
  };
}
function pageCacheAt(saved, at) {
  const value = saved && typeof saved === "object" ? saved : {};
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  const header = (v) =>
    typeof v === "string" && v.length <= 512 && !/[\r\n]/.test(v) ? v : "";
  return {
    parserRevision:
      value.parserRevision === PAGE_PARSER_REVISION ? PAGE_PARSER_REVISION : 0,
    day: dayAt(at),
    attempts: value.day === dayAt(at) ? count(value.attempts) : 0,
    total: count(value.total),
    lastAttemptAt: validTime(value.lastAttemptAt) ? value.lastAttemptAt : null,
    nextRequestAt: validTime(value.nextRequestAt) ? value.nextRequestAt : null,
    fetchedAt: validTime(value.fetchedAt) ? value.fetchedAt : null,
    actionCheckedAt: validTime(value.actionCheckedAt)
      ? value.actionCheckedAt
      : null,
    fullFetchedAt: validTime(value.fullFetchedAt) ? value.fullFetchedAt : null,
    lastStatus:
      Number.isInteger(value.lastStatus) &&
      value.lastStatus >= 100 &&
      value.lastStatus <= 599
        ? value.lastStatus
        : null,
    failures: Math.min(10, count(value.failures)),
    suspended: value.suspended === true,
    formatChanged: value.formatChanged === true,
    retryAt: validTime(value.retryAt) ? value.retryAt : 0,
    message:
      typeof value.message === "string" ? value.message.slice(0, 300) : "",
    etag: header(value.etag),
    lastModified: header(value.lastModified),
    validatedFor:
      typeof value.validatedFor === "string"
        ? value.validatedFor.slice(0, 4096)
        : "",
    actionId:
      typeof value.actionId === "string" &&
      /^[a-f0-9]{40,42}$/.test(value.actionId)
        ? value.actionId
        : "",
    assetUrl:
      typeof value.assetUrl === "string" &&
      pageActionAssets(
        `<script src="${value.assetUrl.replaceAll('"', "")}"></script>`,
      ).includes(value.assetUrl)
        ? value.assetUrl
        : "",
    mode: value.mode === "background" ? "background" : "page",
  };
}
function createPageService({
  getRecord,
  persist,
  request,
  now,
  isDisposed,
  testResponse,
}) {
  let controller = null;
  const identity = (record) =>
    pageRequestUrl(record.source.page, record.source).href;
  function dueAt(record, at) {
    if (
      !record.source.page.enabled ||
      !record.source.page.url ||
      record.source.useLastResponse
    )
      return Infinity;
    const cache = pageCacheAt(record.pageCache, at);
    if (cache.suspended) return Infinity;
    return Math.max(
      cache.retryAt,
      cache.nextRequestAt ??
        (cache.lastAttemptAt === null
          ? at
          : cache.lastAttemptAt + record.source.page.intervalMinutes * 60000),
    );
  }
  function state(record, at) {
    const cache = pageCacheAt(record.pageCache, at),
      next = dueAt(record, at);
    return {
      requestsToday: cache.attempts,
      totalRequests: cache.total,
      lastAttemptAt: cache.lastAttemptAt,
      fetchedAt: cache.fetchedAt,
      nextRequestAt: Number.isFinite(next) ? next : null,
      lastStatus: cache.lastStatus,
      message: cache.message,
      retryAt: cache.retryAt || null,
      suspended: cache.suspended,
      formatChanged: cache.formatChanged,
      mode: cache.mode,
    };
  }
  function afterApiSuccess(record, at) {
    const cache = pageCacheAt(record.pageCache, at);
    if (record.source.page.enabled && !cache.suspended)
      cache.nextRequestAt = Math.max(
        cache.retryAt,
        at + record.source.page.intervalMinutes * 60000,
      );
    return cache;
  }
  async function read(response, max = MAX_PAGE_BYTES) {
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > max) {
        controller?.abort();
        const error = Error("Ответ страницы слишком велик.");
        error.code = "FORMAT_CHANGED";
        throw error;
      }
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  const headers = {
    "User-Agent": "Mozilla/5.0",
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "ru-RU,ru;q=0.9",
  };
  async function discover(html, cache, signal) {
    const assets = pageActionAssets(html);
    if (
      cache.actionCheckedAt !== null &&
      now() - cache.actionCheckedAt < DAY &&
      cache.validatedFor === identity(getRecord()) &&
      !cache.formatChanged
    )
      return {
        actionId: cache.actionId,
        assetUrl: cache.assetUrl,
        actionCheckedAt: cache.actionCheckedAt,
      };
    if (cache.actionId && assets.includes(cache.assetUrl))
      return {
        actionId: cache.actionId,
        assetUrl: cache.assetUrl,
        actionCheckedAt: now(),
      };
    // Fetch a bounded subset of public code as text; never execute it.
    for (const url of assets.slice(0, 4)) {
      if (isDisposed()) break;
      try {
        const response = await request(url, {
          headers: { ...headers, Accept: "text/javascript" },
          redirect: "error",
          signal,
        });
        if (!response.ok) break;
        const id = findPageAction(await read(response, 1024 * 1024));
        if (id) return { actionId: id, assetUrl: url, actionCheckedAt: now() };
      } catch {
        break;
      }
    }
    return { actionId: "", assetUrl: "", actionCheckedAt: now() };
  }
  function retryAfter(response, at) {
    const value = response?.headers?.get("retry-after");
    if (!value) return 0;
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return at + numeric * 1000;
    const date = Date.parse(value);
    return Number.isFinite(date) && date > at ? date : 0;
  }
  async function tick() {
    if (isDisposed()) return;
    const record = getRecord(),
      at = now(),
      page = record.source.page;
    if (dueAt(record, at) > at) return;
    const cache = pageCacheAt(record.pageCache, at),
      interval = page.intervalMinutes * 60000;
    const url = identity(record),
      same = cache.validatedFor === url,
      currentParser = cache.parserRevision === PAGE_PARSER_REVISION;
    const background = Boolean(
      same &&
      currentParser &&
      cache.actionId &&
      cache.fullFetchedAt !== null &&
      at - cache.fullFetchedAt < DAY &&
      !cache.formatChanged,
    );
    const reserved = {
      ...cache,
      attempts: cache.attempts + 1,
      total: cache.total + 1,
      lastAttemptAt: at,
      nextRequestAt: at + interval,
      message: "Обновление со страницы…",
    };
    await persist({ ...record, pageCache: reserved });
    if (isDisposed()) return;
    controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15000),
    ]);
    let response;
    try {
      let options = { headers: { ...headers }, redirect: "error", signal };
      if (background) {
        const action = pageActionRequest(page, record.source, cache.actionId);
        options = {
          ...options,
          ...action.options,
          headers: { ...headers, ...action.options.headers },
        };
      } else if (same && currentParser && !cache.formatChanged) {
        if (cache.etag) options.headers["If-None-Match"] = cache.etag;
        if (cache.lastModified)
          options.headers["If-Modified-Since"] = cache.lastModified;
      }
      response = await request(url, options);
      if (response.status === 403) {
        const error = Error("Яндекс ограничил доступ к странице.");
        error.code = "ACCESS_CHALLENGE";
        throw error;
      }
      if (response.status === 404) {
        const error = Error("Адрес или формат запроса Яндекса изменился.");
        error.code = "FORMAT_CHANGED";
        throw error;
      }
      let weather = null,
        discovered = {},
        success = {};
      if (
        response.status === 304 &&
        same &&
        currentParser &&
        cache.fetchedAt !== null
      ) {
        success = { fullFetchedAt: now() };
      } else {
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        const text = await read(
          response,
          background ? 512 * 1024 : MAX_PAGE_BYTES,
        );
        if (background)
          weather = parsePageAction(text, record.source, now(), record.weather);
        else {
          weather = parsePage(text, record.source, now());
          discovered = await discover(text, cache, signal);
          success = {
            parserRevision: PAGE_PARSER_REVISION,
            fullFetchedAt: now(),
            etag: response.headers.get("etag") || "",
            lastModified: response.headers.get("last-modified") || "",
          };
        }
      }
      if (isDisposed()) return;
      const current = getRecord(),
        next = pageCacheAt(current.pageCache, now());
      let forecastCache = current.forecastCache;
      if (weather)
        ({ weather, forecastCache } = mergeForecast(
          current,
          weather,
          "page",
          !background,
          now(),
        ));
      await persist({
        ...current,
        ...(weather
          ? { weather, forecastCache, testResponse: testResponse(weather) }
          : {}),
        pageCache: {
          ...next,
          ...success,
          ...discovered,
          validatedFor: url,
          mode: background ? "background" : "page",
          fetchedAt: now(),
          lastStatus: response.status,
          failures: 0,
          retryAt: 0,
          suspended: false,
          formatChanged: false,
          message: "",
        },
      });
    } catch (error) {
      if (isDisposed()) return;
      const current = getRecord(),
        next = pageCacheAt(current.pageCache, now());
      const failures = next.failures + 1;
      const suspended = error.code === "ACCESS_CHALLENGE";
      const formatChanged = error.code === "FORMAT_CHANGED";
      const wait = Math.min(DAY, interval * 2 ** Math.min(10, failures));
      const retryAt = suspended
        ? 0
        : Math.max(
            now() + (formatChanged ? DAY : wait),
            retryAfter(response, now()),
          );
      const message = suspended
        ? "Яндекс ограничил доступ. Обновления страницы приостановлены; используется последняя погода."
        : formatChanged
          ? "Формат Яндекса изменился. Следующая проверка через сутки; используется последняя погода."
          : `Не удалось обновить страницу${response ? ` (HTTP ${response.status})` : ""}. Повтор отложен; используется последняя погода.`;
      await persist({
        ...current,
        pageCache: {
          ...next,
          failures,
          suspended,
          formatChanged,
          retryAt,
          nextRequestAt: suspended ? null : retryAt,
          lastStatus: response?.status || null,
          message,
        },
      });
    } finally {
      controller = null;
    }
  }
  async function resume() {
    const record = getRecord(),
      at = now(),
      cache = pageCacheAt(record.pageCache, at);
    await persist({
      ...record,
      pageCache: {
        ...cache,
        suspended: false,
        formatChanged: false,
        ...(cache.formatChanged
          ? {
              actionId: "",
              assetUrl: "",
              actionCheckedAt: null,
              fullFetchedAt: null,
              etag: "",
              lastModified: "",
              validatedFor: "",
            }
          : {}),
        failures: 0,
        retryAt: 0,
        message: "",
        nextRequestAt: Math.max(
          at,
          (cache.lastAttemptAt ??
            at - record.source.page.intervalMinutes * 60000) +
            record.source.page.intervalMinutes * 60000,
        ),
      },
    });
  }
  return {
    dueAt,
    state,
    afterApiSuccess,
    tick,
    resume,
    dispose() {
      controller?.abort();
    },
  };
}
module.exports = { validatePage, pageDefaults, pageCacheAt, createPageService };
