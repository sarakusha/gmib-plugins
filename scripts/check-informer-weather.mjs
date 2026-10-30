import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  parsePage,
  parsePageAction,
  pageRequestUrl,
  pageActionRequest,
  pageActionAssets,
  findPageAction,
  MAX_PAGE_BYTES,
} = require("../plugins/informer/dist/weather-page.cjs");
const HELP = `Проверка парсинга Яндекс Погоды (без API-ключа и настроек GMIB).

Свежие ответы:
  npm run informer:check-weather -- --url https://yandex.ru/pogoda/ru/yoshkar-ola --lat 56.6333 --lon 47.8908 --save-dir /tmp/informer-weather-check

Сохранённые ответы (без сети):
  npm run informer:check-weather -- --page /tmp/informer-weather-check/page.html --light /tmp/informer-weather-check/light.txt --lat 56.6333 --lon 47.8908

Параметры:
  --mode page|light|both  Что проверять (для URL по умолчанию both).
  --page FILE            Сохранённый HTML; для offline-режима page или both.
  --light FILE           Сохранённый лёгкий ответ; для offline-режима light или both.
  --asset FILE           Необязательно: проверить поиск идентификатора в сохранённом JS.
  --save-dir DIR         Сохранить свежие ответы в новый каталог для дальнейшей отладки.
  --lat N --lon N        Координаты (обязательны, в URL заменяются указанными).
  --help                Показать справку.

Для live light тоже нужны HTML и публичный JS для обнаружения запроса.
Команда делает одну проверку, без повторов. Сохранённый JavaScript не исполняется.
Изменения парсера вносятся в plugins/informer/dist/weather-page.cjs.
`;
const flags = new Set([
  "url",
  "lat",
  "lon",
  "mode",
  "page",
  "light",
  "asset",
  "save-dir",
]);
function options(argv) {
  const args = argv.filter((arg) => arg !== "--");
  if (!args.length || args.includes("--help")) return null;
  const result = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i].startsWith("--") ? args[i].slice(2) : "";
    if (!flags.has(name) || result[name] !== undefined)
      throw Error(`Неизвестный или повторный параметр: ${args[i]}`);
    const value = args[++i];
    if (!value || value.startsWith("--"))
      throw Error(`Нужно значение --${name}`);
    result[name] = value;
  }
  for (const [name, min, max] of [
    ["lat", -90, 90],
    ["lon", -180, 180],
  ]) {
    if (
      result[name] === undefined ||
      !Number.isFinite(Number(result[name])) ||
      Number(result[name]) < min ||
      Number(result[name]) > max
    )
      throw Error(`Укажите --${name} от ${min} до ${max}`);
    result[name] = Number(result[name]);
  }
  if (result.url && (result.page || result.light || result.asset))
    throw Error("Выберите --url или сохранённые файлы.");
  if (!result.url && !result.page && !result.light)
    throw Error("Нужен --url, --page или --light.");
  result.mode ||=
    result.url || (result.page && result.light)
      ? "both"
      : result.page
        ? "page"
        : "light";
  if (!["page", "light", "both"].includes(result.mode))
    throw Error("Режим: page, light или both.");
  if (
    !result.url &&
    ((result.mode !== "light" && !result.page) ||
      (result.mode !== "page" && !result.light))
  )
    throw Error("Для выбранного режима не хватает --page или --light.");
  if (result["save-dir"] && !result.url)
    throw Error("--save-dir используется только с --url.");
  if (result.url) result.url = pageRequestUrl(result.url, result).href;
  return result;
}
function summary(weather) {
  return {
    temperature: weather.temp,
    condition: weather.condition,
    iconUrl: weather.iconUrl || null,
    windSpeed: weather.windSpeed,
    windDir: weather.windDir,
    pressureMm: weather.pressureMm,
    humidity: weather.humidity,
    feelsLike: weather.feelsLike,
    forecast: weather.forecast,
  };
}
async function fileText(file, max) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size > max)
    throw Error(`Недопустимый размер файла: ${file}`);
  return fs.readFile(file, "utf8");
}
export async function run(
  argv,
  { request = fetch, stdout = console.log, stderr = console.error } = {},
) {
  let stage = "параметры";
  try {
    const config = options(argv);
    if (!config) {
      stdout(HELP);
      return 0;
    }
    const result = {
      mode: config.mode,
      location: { lat: config.lat, lon: config.lon },
      checks: {},
    };
    const saveDir = config["save-dir"] && path.resolve(config["save-dir"]);
    if (saveDir) await fs.mkdir(saveDir); // Avoid overwriting an earlier diagnostic capture.
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30000),
    ]);
    const headers = {
      "User-Agent": "Mozilla/5.0",
      "Accept-Language": "ru-RU,ru;q=0.9",
    };
    async function load(url, opts, max, filename) {
      const response = await request(url, {
        ...opts,
        headers: { ...headers, ...opts.headers },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw Error(`HTTP ${response.status}`);
      const chunks = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > max) {
          controller.abort();
          throw Error(`Ответ превышает ${max} байт`);
        }
        chunks.push(Buffer.from(chunk));
      }
      const text = Buffer.concat(chunks).toString("utf8");
      if (saveDir)
        await fs.writeFile(path.join(saveDir, filename), text, { flag: "wx" });
      return { text, status: response.status, bytes: size };
    }
    let html, previous;
    if (config.url || config.page) {
      stage = "полная страница";
      const response = config.url
        ? await load(
            config.url,
            { headers: { Accept: "text/html,application/xhtml+xml" } },
            MAX_PAGE_BYTES,
            "page.html",
          )
        : { text: await fileText(config.page, MAX_PAGE_BYTES) };
      html = response.text;
      if (config.mode !== "light") {
        previous = parsePage(html, config);
        result.checks.page = {
          status: response.status || null,
          bytes: Buffer.byteLength(html),
          ...summary(previous),
        };
        if (!previous.forecast.length)
          throw Error("Текущая погода распознана, но блок прогноза не найден.");
      }
    }
    let actionId;
    if (config.asset) {
      stage = "поиск лёгкого запроса в JS";
      actionId = findPageAction(await fileText(config.asset, 2 * 1024 * 1024));
      if (!actionId) throw Error("Идентификатор лёгкого запроса не найден.");
      result.actionFound = true;
    }
    if (config.mode !== "page") {
      let response;
      if (config.url) {
        stage = "поиск лёгкого запроса в JS";
        for (const [index, asset] of pageActionAssets(html)
          .slice(0, 4)
          .entries()) {
          const js = await load(
            asset,
            { headers: { Accept: "text/javascript" } },
            1024 * 1024,
            `asset-${index}.js`,
          );
          actionId = findPageAction(js.text);
          if (actionId) break;
        }
        if (!actionId)
          throw Error(
            "Идентификатор не найден в четырёх разрешённых JS-файлах.",
          );
        result.actionFound = true;
        stage = "лёгкий ответ";
        const action = pageActionRequest(config.url, config, actionId);
        response = await load(
          action.url,
          action.options,
          512 * 1024,
          "light.txt",
        );
      } else {
        stage = "лёгкий ответ";
        response = { text: await fileText(config.light, 512 * 1024) };
      }
      const weather = parsePageAction(
        response.text,
        config,
        Date.now(),
        previous,
      );
      result.checks.light = {
        status: response.status || null,
        bytes: Buffer.byteLength(response.text),
        ...summary(weather),
      };
      result.lightForecastRetained = Boolean(previous);
    }
    if (saveDir) {
      result.savedTo = saveDir;
      await fs.writeFile(
        path.join(saveDir, "report.json"),
        `${JSON.stringify(result, null, 2)}\n`,
        { flag: "wx" },
      );
    }
    stdout(JSON.stringify(result, null, 2));
    return 0;
  } catch (error) {
    stderr(
      `Ошибка (${stage}): ${error.message}${error.code ? ` [${error.code}]` : ""}`,
    );
    return 1;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
)
  process.exitCode = await run(process.argv.slice(2));
