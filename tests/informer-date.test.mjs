import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";

const sandbox = { module: { exports: {} } };
vm.runInNewContext(
  fs.readFileSync(
    new URL("../plugins/informer/public/date-format.js", import.meta.url),
    "utf8",
  ),
  sandbox,
);
const { formatDate } = sandbox.module.exports;
const clock = { locale: "ru-RU", timeZone: "Europe/Moscow" };
const now = new Date("2027-07-15T07:12:00Z");
const render = (options, weekday = false, c = clock) =>
  JSON.parse(JSON.stringify(formatDate(now, { options, weekday }, c)));

test("date fields render once and disabled fields never fall back to numeric date", () => {
  assert.deepEqual(render({ day: "numeric", month: "long" }, true), {
    weekday: "Четверг",
    calendar: "15 июля",
  });
  assert.deepEqual(render({}), { weekday: "", calendar: "" });
  assert.deepEqual(render({}, true), { weekday: "Четверг", calendar: "" });
  assert.equal(render({ weekday: "short" }, true).weekday, "Чт");
  assert.equal(render({ weekday: "short" }, false).weekday, "");
  assert.equal(render({ year: "numeric" }).calendar.includes("2027"), true);
  assert.equal(/\d/.test(render({ era: "short" }).calendar), false);
});

test("legacy full date style does not duplicate weekday and timezone applies to both fields", () => {
  const old = render({ dateStyle: "full" }, true);
  assert.equal(old.weekday, "Четверг");
  assert.equal(old.calendar.toLowerCase().includes("четверг"), false);
  assert.equal(old.calendar.includes("2027"), true);
  const local = render({ day: "numeric", month: "long" }, true, {
    locale: "ru-RU",
    timeZone: "Pacific/Honolulu",
  });
  assert.deepEqual(local, { weekday: "Среда", calendar: "14 июля" });
});
