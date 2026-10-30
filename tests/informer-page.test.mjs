import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  parsePage,
  validatePageUrl,
  pageRequestUrl,
  MAX_PAGE_BYTES,
} = require("../plugins/informer/dist/weather-page.cjs");
const model = require("../plugins/informer/dist/model.cjs");
const location = { lat: 55.75, lon: 37.62 };
const fact = {
  temperatureInCelsius: 8,
  feelsLikeInCelsius: 5,
  condition: "PARTLY_CLOUDY",
  windSpeedInMetersPerSecond: 2,
  windDirection: "SOUTH",
  pressure: 765,
  humidity: 82,
  daytime: "DAY",
  icon: "skc_d",
};
function html(value, split = false) {
  const row = `1:${JSON.stringify([
    "$",
    "component",
    null,
    {
      goalPrefix: "main_feedback",
      fact: value,
    },
  ])}\n`;
  const chunks = split ? [row.slice(0, 37), row.slice(37)] : [row];
  return chunks
    .map(
      (chunk) =>
        `<script>self.__next_f.push(${JSON.stringify([1, chunk])});</script>`,
    )
    .join("");
}
test("page parser reads split Flight chunks as data and normalizes weather", () => {
  const result = parsePage(html(fact, true), location, 1234);
  assert.equal(result.temp, 8);
  assert.equal(result.feelsLike, 5);
  assert.equal(result.condition, "partly-cloudy");
  assert.equal(result.windDir, "s");
  assert.equal(result.pressureMm, 765);
  assert.equal(result.humidity, 82);
  assert.equal(result.fetchedAt, 1234);
  assert.deepEqual(result.location, location);
  assert.equal(result.provider, "yandex-page");
  assert.equal(
    result.iconUrl,
    "https://yastatic.net/weather/i/icons/confident/dark/svg/skc_d.svg",
  );
});
test("page parser rejects challenges, malformed data, executable scripts and oversized HTML", () => {
  for (const source of [
    "<html>captcha</html>",
    html({ ...fact, temperatureInCelsius: "8" }),
    '<script>self.__next_f.push([1, (() => { throw Error("executed"); })()]);</script>',
    "x".repeat(MAX_PAGE_BYTES + 1),
  ])
    assert.throws(() => parsePage(source, location));
});
test("page request replaces untrusted coordinates and all unrelated query parameters", () => {
  const result = pageRequestUrl(
    "https://yandex.ru/pogoda/ru/moscow?lat=0&lat=1&lon=0&tracking=secret#today",
    location,
  );
  assert.equal(
    String(result),
    "https://yandex.ru/pogoda/ru/moscow?lat=55.75&lon=37.62",
  );
  assert.throws(() =>
    pageRequestUrl("https://yandex.ru/pogoda/moscow", { lat: 91, lon: 0 }),
  );
});
test("manual page URL normalization discards query and fragment", () => {
  assert.equal(
    validatePageUrl("https://yandex.ru/pogoda/moscow?secret=unused#today"),
    "https://yandex.ru/pogoda/moscow",
  );
});
test("page icon accepts provider SVGs, rejects arbitrary URLs, and survives restore", () => {
  const value = parsePage(html(fact), location, 1234);
  const restored = model.restoreWeather(value);
  assert.equal(restored.provider, "yandex-page");
  assert.equal(restored.iconUrl, value.iconUrl);
  for (const iconUrl of [
    "https://evil.example/weather.svg",
    "javascript:alert(1)",
    "https://yastatic.net.evil.example/icon.svg",
  ]) {
    assert.equal(
      parsePage(html({ ...fact, icon: undefined, iconUrl }), location).iconUrl,
      undefined,
    );
  }
});

const {
  pageActionRequest,
  parsePageAction,
  pageActionAssets,
  findPageAction,
} = require("../plugins/informer/dist/weather-page.cjs");
const actionId = "a".repeat(42);
const asset =
  "https://weather.yastatic.net/s3/weather-frontend/front2/_next/static/chunks/6998-test.js";
test("action discovery restricts assets to bounded Yandex script locations and reads identifiers without execution", () => {
  const unsafe = [
    "https://evil.example/test.js",
    asset.replace("weather.yastatic.net", "weather.yastatic.net.evil.example"),
    asset + "?token=secret",
    asset + "#fragment",
    asset.replace("https://", "http://"),
    asset.replace("https://", "https://user:secret@"),
  ];
  assert.deepEqual(
    pageActionAssets(
      [asset, ...unsafe, asset]
        .map((src) => `<script src="${src}"></script>`)
        .join(""),
    ),
    [asset],
  );
  assert.equal(
    findPageAction(
      `createServerReference('${actionId}',null,null,'getMapsUserLocationDataAction');`,
    ),
    actionId,
  );
  assert.equal(
    findPageAction(
      `createServerReference('${actionId}',null,null,'unrelatedAction');`,
    ),
    null,
  );
  assert.equal(findPageAction("x".repeat(2 * 1024 * 1024 + 1)), null);
  assert.throws(() =>
    pageActionRequest("https://yandex.ru/pogoda/moscow", location, "invalid"),
  );
});
test("light Flight parser retains forecast only for identical coordinates and accepts safe field aliases", () => {
  const previous = parsePage(html(fact), location, 1234);
  previous.forecastSource = "api";
  previous.forecast = [
    {
      date: "2026-10-30",
      part: "day",
      tempMin: 1,
      tempMax: 8,
      condition: "clear",
      daytime: "d",
      precipitationProbability: 0,
    },
  ];
  const payload = `1:${JSON.stringify({ data: { weather: { now: { tempC: 12, condition: "CLEAR" } } } })}\n`;
  const same = parsePageAction(payload, location, 2345, previous);
  assert.equal(same.temp, 12);
  assert.equal(same.humidity, 82);
  assert.deepEqual(same.forecast, previous.forecast);
  assert.equal(same.forecastSource, "api");
  const moved = parsePageAction(
    payload,
    { lat: 56, lon: 37.62 },
    2345,
    previous,
  );
  assert.equal(moved.humidity, null);
  assert.deepEqual(moved.forecast, []);
  for (const invalid of ["0:{}\n", "0:{invalid}", "x".repeat(512 * 1024 + 1)]) {
    assert.throws(
      () => parsePageAction(invalid, location),
      (error) => error.code === "FORMAT_CHANGED",
    );
  }
});

function hourlyForecastPage(
  hours,
  date = "2026-10-31",
  part = "night",
  iconProps,
) {
  const element = (type, key, props) => ["$", type, key, props];
  const card = element("li", "31 октября", {
    className: "AppForecastDay_dayCard_test",
    children: element("section", part, {
      children: [
        { style: { gridArea: `${part[0]}-temp` }, children: "+20°" },
        {
          style: { gridArea: `${part[0]}-text` },
          children: "облачно с прояснениями",
        },
        iconProps &&
          element("div", null, {
            ...iconProps,
            style: { gridArea: `${part[0]}-icon`, ...iconProps.style },
          }),
      ],
    }),
  });
  const records = [
    { dateTime: `${date}T00:00:00.000Z` },
    card,
    ...hours.map(([iso, clock, value]) => ({
      className: "AppHourlyItem_container__test",
      children: [
        element("time", null, {
          className: "AppHourlyItem_time__test",
          dateTime: iso,
          children: clock,
        }),
        element("p", null, {
          className: "AppHourlyItem_main__test",
          children: value,
        }),
      ],
    })),
  ];
  const rows = records
    .map(
      (record, index) =>
        `${(index + 2).toString(16)}:${JSON.stringify(record)}\n`,
    )
    .join("");
  return (
    html(fact) +
    `<script>self.__next_f.push(${JSON.stringify([1, rows])});</script>`
  );
}
function nightHours() {
  return Array.from({ length: 6 }, (_, hour) => [
    new Date(Date.UTC(2026, 9, 30, 21 + hour)).toISOString(),
    `${String(hour).padStart(2, "0")}:00`,
    `${hour - 2}°`,
  ]);
}
test("hourly ranges use all six local hours and carry UTC dates across midnight", () => {
  const hours = nightHours();
  // Non-temperature sunrise entries must not override the temperature hour.
  hours.push([hours[0][0], "00:00", "Восход"]);
  const result = parsePage(hourlyForecastPage(hours), location);
  assert.equal(result.forecast[0].date, "2026-10-31");
  assert.equal(result.forecast[0].tempMin, -2);
  assert.equal(result.forecast[0].tempMax, 3);
});
test("incomplete hourly periods and repeated hours retain the card's single value", () => {
  const hours = nightHours().slice(0, 5);
  hours.push(hours[0], hours[0]);
  const result = parsePage(hourlyForecastPage(hours), location);
  assert.equal(result.forecast[0].tempMin, 20);
  assert.equal(result.forecast[0].tempMax, 20);
});
test("inconsistent local offsets and conflicting duplicate hours do not produce ranges", () => {
  for (const hours of [
    [...nightHours().slice(0, 5), [nightHours()[5][0], "06:00", "3°"]],
    [...nightHours(), [nightHours()[0][0], "00:00", "9°"]],
  ]) {
    const result = parsePage(hourlyForecastPage(hours), location);
    assert.equal(result.forecast[0].tempMin, 20);
    assert.equal(result.forecast[0].tempMax, 20);
  }
});

test("forecast sprite icons preserve the provider's moon despite a cloudy caption and hourly aggregation", () => {
  const result = parsePage(
    hourlyForecastPage(nightHours(), "2026-10-31", "night", {
      className: "style_weatherIcon__OE4YL AppForecastDayPart_icon__CUyCQ",
      style: { "--icon": 27 },
    }),
    location,
  );
  const night = result.forecast[0];
  assert.equal(
    night.iconUrl,
    "https://yastatic.net/weather/i/icons/confident/dark/svg/skc_n.svg",
  );
  assert.equal(night.condition, "cloudy");
  assert.equal(night.daytime, "n");
  assert.equal(night.tempMin, -2);
  assert.equal(night.tempMax, 3);
  assert.equal(result.forecastSource, "page");
  assert.deepEqual(model.restoreWeather(result).forecast, result.forecast);
});

test("forecast sprite atlas includes clear, cloudy and precipitation day/night provider icons", () => {
  for (const [sprite, code] of [
    [0, "bkn_-ra_d"],
    [2, "bkn_+ra_d"],
    [6, "bkn_-ra_n"],
    [11, "bkn_+sn_n"],
    [12, "ovc_-ra"],
    [17, "ovc_+sn"],
    [18, "ovc_ra_sn"],
    [22, "ovc_ts_ha"],
    [23, "bkn_d"],
    [24, "bkn_n"],
    [25, "ovc"],
    [26, "skc_d"],
    [27, "skc_n"],
  ]) {
    const result = parsePage(
      hourlyForecastPage([], "2026-10-31", "night", {
        style: { "--icon": sprite },
      }),
      location,
    );
    assert.equal(
      result.forecast[0].iconUrl,
      `https://yastatic.net/weather/i/icons/confident/dark/svg/${code}.svg`,
    );
  }
});

test("forecast icons keep explicit provider URLs and ignore unknown sprite indices", () => {
  const src = "https://yastatic.net/weather/i/icons/confident/dark/svg/ovc.svg";
  const direct = parsePage(
    hourlyForecastPage([], "2026-10-31", "night", {
      src,
      style: { "--icon": 27 },
    }),
    location,
  );
  assert.equal(direct.forecast[0].iconUrl, src);
  for (const sprite of [-1, 28, 1.5, "27", null]) {
    const result = parsePage(
      hourlyForecastPage([], "2026-10-31", "night", {
        src: "https://evil.example/weather.svg",
        style: { "--icon": sprite },
      }),
      location,
    );
    assert.equal(result.forecast[0].iconUrl, undefined);
    assert.equal(result.forecast[0].condition, "cloudy");
  }
});
