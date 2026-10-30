"use strict";

const {
  defaults,
  validateSettings,
  normalizeWeather,
  restoreWeather,
} = require("./model.cjs");
const sample = require("./sample.json");
const {
  LIMIT,
  normalizeName,
  importTheme,
  restoreThemes,
} = require("./themes.cjs");
const STORAGE_KEY = "informer.v1";
const {
  restoreSource,
  validateSource,
  usageAt,
  restoreUsage,
  poolSignature,
  testResponse,
  createWeatherService,
} = require("./weather.cjs");

exports.activate = async (
  { storage, http, events, output, logger, lifecycle },
  runtime = {},
) => {
  let saved = await storage.get(STORAGE_KEY);
  if (!saved || saved.version !== 1) saved = {};
  let settings, weather;
  try {
    settings = validateSettings(saved.settings);
  } catch {
    settings = structuredClone(defaults);
  }
  try {
    weather = restoreWeather(saved.weather);
  } catch {
    weather = normalizeWeather(sample, 0);
  }
  const now = runtime.now || Date.now;
  const source = restoreSource(saved.source, weather);
  let record = {
    version: 1,
    settings,
    weather,
    themes: restoreThemes(saved.themes),
    source,
    usage: restoreUsage(saved.usage, now(), saved.cache?.attemptedAt, source),
    testResponse: testResponse(weather),
    cache: {
      message:
        typeof saved.cache?.message === "string"
          ? saved.cache.message.slice(0, 240)
          : "",
    },
  };
  let weatherService;
  const snapshot = () =>
    structuredClone({
      settings: record.settings,
      weather: record.weather,
      ...weatherService.state(),
    });
  const persist = async (next) => {
    await storage.set(STORAGE_KEY, next);
    record = next;
    events.publish("changed", snapshot());
    return snapshot();
  };
  let queue = Promise.resolve();
  const serial = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => {});
    return next;
  };
  const error = (status, message) => http.response(status, { error: message });
  const route = (work) => async (request) => {
    try {
      return await work(request);
    } catch {
      logger.warn(
        "Informer: не удалось сохранить данные или выполнить операцию",
      );
      return error(500, "Операция не выполнена. Проверьте журнал GMIB.");
    }
  };
  weatherService = createWeatherService({
    getRecord: () => record,
    persist,
    serial,
    logger,
    runtime,
  });
  lifecycle?.onDispose(() => weatherService.dispose());
  http.get("/state", () => snapshot());
  const catalog = () => structuredClone({ themes: record.themes });
  http.get("/themes", () => catalog());
  http.post(
    "/themes",
    route((request) =>
      serial(async () => {
        let theme;
        try {
          theme = importTheme(request.body);
        } catch (err) {
          return error(422, err.message);
        }
        const index = record.themes.findIndex(
          (item) => item.name === theme.name,
        );
        if (index < 0 && record.themes.length >= LIMIT)
          return error(409, "Можно сохранить не более 50 тем");
        const themes = record.themes.slice();
        if (index < 0) themes.push(theme);
        else themes[index] = theme;
        await persist({ ...record, themes });
        return { ...catalog(), theme: structuredClone(theme) };
      }),
    ),
  );
  http.delete(
    "/themes",
    route((request) =>
      serial(async () => {
        let name;
        try {
          name = normalizeName(request.body?.name);
        } catch (err) {
          return error(422, err.message);
        }
        await persist({
          ...record,
          themes: record.themes.filter((theme) => theme.name !== name),
        });
        return catalog();
      }),
    ),
  );
  http.put(
    "/settings",
    route((request) =>
      serial(async () => {
        let settings, source;
        try {
          settings = validateSettings(request.body);
          source =
            request.body?.weatherSource === undefined
              ? record.source
              : validateSource(request.body.weatherSource, record.source);
        } catch (err) {
          return error(422, err.message);
        }
        // Presentation and weather source are committed atomically; themes contain presentation only.
        const usage = usageAt(record.usage, now());
        const poolChanged =
          poolSignature(source) !== poolSignature(record.source);
        if (poolChanged) usage.nextRequestAt = null;
        const result = await persist({
          ...record,
          settings,
          source,
          usage,
          cache: poolChanged ? { message: "" } : record.cache,
        });
        weatherService.schedule();
        return result;
      }),
    ),
  );
  http.get(
    "/output",
    route(async () =>
      http.response(200, {
        screens: await output.listScreens(),
        status: await output.getStatus(),
      }),
    ),
  );
  http.put(
    "/output",
    route(async (request) => {
      const { screenId, pageId, autoStart } = request.body || {};
      if (
        !Number.isSafeInteger(screenId) ||
        pageId !== "screen" ||
        typeof autoStart !== "boolean"
      )
        return error(422, "Выберите экран GMIB");
      await output.start({ screenId, pageId, autoStart });
      return http.response(200, { status: await output.getStatus() });
    }),
  );
  http.delete(
    "/output",
    route(async () => {
      await output.stop();
      return http.response(200, { status: await output.getStatus() });
    }),
  );
  weatherService.schedule();
};
