import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { run } from "../scripts/check-informer-weather.mjs";

const require = createRequire(import.meta.url);
const { MAX_PAGE_BYTES } = require("../plugins/informer/dist/weather-page.cjs");
const assetUrl =
  "https://weather.yastatic.net/s3/weather-frontend/front2/_next/static/chunks/check.js";
const actionId = "a".repeat(42);
const asset = `globalThis.__weatherCliExecuted = true; createServerReference('${actionId}',null,null,'getMapsUserLocationDataAction');`;
const light =
  '1:{"data":{"weather":{"now":{"tempC":12,"condition":"CLEAR"}}}}\n';
const element = (type, key, props) => ["$", type, key, props];
const records = [
  element("component", null, {
    goalPrefix: "main_feedback",
    fact: {
      temperatureInCelsius: 8,
      feelsLikeInCelsius: 5,
      condition: "PARTLY_CLOUDY",
      humidity: 82,
      windSpeedInMetersPerSecond: 2,
      windDirection: "SOUTH",
      pressure: 765,
      daytime: "DAY",
      icon: "skc_d",
    },
  }),
  { dateTime: "2026-10-31T00:00:00.000Z" },
  element("li", "31 октября", {
    className: "AppForecastDay_dayCard_test",
    children: element("section", "day", {
      children: { style: { gridArea: "d-temp" }, children: "+20°" },
    }),
  }),
];
const flight = records
  .map((record, index) => `${index + 1}:${JSON.stringify(record)}\n`)
  .join("");
const page = `<script src="https://evil.example/unsafe.js"></script><script src="${assetUrl}"></script><script>self.__next_f.push(${JSON.stringify([1, flight])});</script>`;
const coordinates = ["--lat", "55.75", "--lon", "37.62"];
const liveArgs = [
  "--url",
  "https://yandex.ru/pogoda/ru/moscow?lat=0&tracking=secret#today",
  ...coordinates,
];
async function invoke(
  args,
  request = async () => {
    throw Error("Unexpected network request");
  },
) {
  const stdout = [],
    stderr = [];
  const code = await run(args, {
    request,
    stdout: (value) => stdout.push(value),
    stderr: (value) => stderr.push(value),
  });
  return { code, stdout, stderr };
}
async function temporary(t) {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "informer-weather-check-"),
  );
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("weather CLI shows help without requests", async () => {
  for (const args of [[], ["--help"]]) {
    const result = await invoke(args);
    assert.equal(result.code, 0);
    assert.match(result.stdout[0], /informer:check-weather/);
    assert.deepEqual(result.stderr, []);
  }
});

test("weather CLI rejects malformed arguments before fetching", async () => {
  for (const args of [
    ["--unknown", "value"],
    [...liveArgs, "--mode"],
    [...liveArgs, "--mode", "invalid"],
    ["--url", "https://yandex.ru/pogoda/moscow", "--lat", "91", "--lon", "0"],
    ["--url", "https://yandex.ru/pogoda/moscow", "--lat", "NaN", "--lon", "0"],
    ["--url", "https://yandex.ru/pogoda/moscow", "--lat", "0"],
    [...liveArgs, "--page", "page.html"],
    [...liveArgs, "--lat", "1"],
  ]) {
    let requested = false;
    const result = await invoke(args, async () => {
      requested = true;
    });
    assert.equal(result.code, 1, JSON.stringify(args));
    assert.equal(requested, false);
    assert.match(result.stderr[0], /параметры/);
  }
});

test("weather CLI checks both live responses and saves exact raw captures", async (t) => {
  const root = await temporary(t),
    saveDir = path.join(root, "capture");
  const calls = [];
  const result = await invoke(
    [...liveArgs, "--save-dir", saveDir],
    async (url, options) => {
      calls.push({ url: String(url), options });
      return new Response([page, asset, light][calls.length - 1]);
    },
  );
  assert.equal(result.code, 0, result.stderr.join("\n"));
  assert.equal(calls.length, 3);
  assert.equal(
    calls[0].url,
    "https://yandex.ru/pogoda/ru/moscow?lat=55.75&lon=37.62",
  );
  assert.equal(calls[1].url, assetUrl);
  assert.equal(calls[2].options.method, "POST");
  assert.equal(calls[2].options.headers["Next-Action"], actionId);
  assert.deepEqual(JSON.parse(calls[2].options.body)[0].searchParams, {
    lat: "55.75",
    lon: "37.62",
  });
  assert.ok(
    calls.every(
      (call) => call.options.redirect === "error" && call.options.signal,
    ),
  );
  const report = JSON.parse(result.stdout[0]);
  assert.equal(report.checks.page.temperature, 8);
  assert.equal(report.checks.light.temperature, 12);
  assert.equal(report.checks.page.forecast.length, 1);
  assert.deepEqual(report.checks.light.forecast, report.checks.page.forecast);
  assert.equal(report.lightForecastRetained, true);
  for (const [name, content] of [
    ["page.html", page],
    ["asset-0.js", asset],
    ["light.txt", light],
  ])
    assert.equal(await fs.readFile(path.join(saveDir, name), "utf8"), content);
  assert.deepEqual(
    JSON.parse(await fs.readFile(path.join(saveDir, "report.json"), "utf8")),
    report,
  );
  assert.equal(globalThis.__weatherCliExecuted, undefined);
});

test("weather CLI reads offline page/light and optional JS without executing it", async (t) => {
  const root = await temporary(t);
  for (const [name, content] of [
    ["page.html", page],
    ["light.txt", light],
    ["asset.js", asset],
  ])
    await fs.writeFile(path.join(root, name), content);
  for (const includeAsset of [false, true]) {
    const result = await invoke([
      "--page",
      path.join(root, "page.html"),
      "--light",
      path.join(root, "light.txt"),
      ...coordinates,
      ...(includeAsset ? ["--asset", path.join(root, "asset.js")] : []),
    ]);
    assert.equal(result.code, 0, result.stderr.join("\n"));
    const report = JSON.parse(result.stdout[0]);
    assert.equal(report.mode, "both");
    assert.equal(report.checks.light.temperature, 12);
    assert.equal(report.checks.page.status, null);
    assert.equal(report.actionFound, includeAsset ? true : undefined);
  }
  assert.equal(globalThis.__weatherCliExecuted, undefined);
});

test("weather CLI stops on HTTP failure, oversized page, or malformed light response", async () => {
  for (const scenario of [
    {
      responses: [new Response("Forbidden", { status: 403 })],
      expected: /полная страница.*HTTP 403/,
      calls: 1,
    },
    {
      responses: [new Response("x".repeat(MAX_PAGE_BYTES + 1))],
      expected: /полная страница.*превышает/,
      calls: 1,
    },
    {
      responses: [
        new Response(page),
        new Response(asset),
        new Response("0:{}\n"),
      ],
      expected: /лёгкий ответ.*FORMAT_CHANGED/,
      calls: 3,
    },
  ]) {
    let calls = 0;
    const result = await invoke(
      liveArgs,
      async () => scenario.responses[calls++],
    );
    assert.equal(result.code, 1);
    assert.equal(calls, scenario.calls);
    assert.deepEqual(result.stdout, []);
    assert.match(result.stderr[0], scenario.expected);
  }
});

test("weather CLI reports separately missing forecast and changed action discovery", async () => {
  for (const scenario of [
    {
      bodies: [
        page.replace("AppForecastDay_dayCard_test", "ChangedForecastCard"),
      ],
      expected: /полная страница.*блок прогноза/,
    },
    {
      bodies: [page, "/* action signature changed */"],
      expected: /поиск лёгкого запроса.*Идентификатор/,
    },
  ]) {
    let index = 0;
    const result = await invoke(
      liveArgs,
      async () => new Response(scenario.bodies[index++]),
    );
    assert.equal(result.code, 1);
    assert.equal(index, scenario.bodies.length);
    assert.match(result.stderr[0], scenario.expected);
  }
});

test("weather CLI supports page-only and light-only live checks", async () => {
  for (const mode of ["page", "light"]) {
    let index = 0;
    const result = await invoke(
      [...liveArgs, "--mode", mode],
      async () => new Response([page, asset, light][index++]),
    );
    assert.equal(result.code, 0, result.stderr.join("\n"));
    assert.equal(index, mode === "page" ? 1 : 3);
    const report = JSON.parse(result.stdout[0]);
    assert.deepEqual(Object.keys(report.checks), [mode]);
  }
});
