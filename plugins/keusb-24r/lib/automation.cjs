"use strict";

const fail = (message) => {
  throw new TypeError(message);
};
const text = (value, label, max = 160) =>
  typeof value === "string" && value.trim() && value.length <= max
    ? value.trim()
    : fail(`${label}: требуется непустая строка`);
const number = (value, label, min, max) =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max
    ? value
    : fail(`${label}: недопустимое число`);
const choice = (value, values, label) =>
  values.includes(value) ? value : fail(`${label}: недопустимое значение`);
const record = (value) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? value
    : fail("Требуется объект");
const validateOutputs = (input) => {
  record(input);
  const result = {};
  for (const [key, value] of Object.entries(input)) {
    if (!/^[1-4]$/.test(key) || typeof value !== "boolean")
      fail("Выходы: допустимы каналы 1–4 и boolean");
    result[key] = value;
  }
  if (!Object.keys(result).length) fail("Выберите хотя бы один выход");
  return result;
};
const base = (input) => {
  record(input);
  if (typeof input.enabled !== "boolean") fail("Активность: требуется boolean");
  return {
    ...(input.id === undefined ? {} : { id: text(input.id, "ID") }),
    name: text(input.name, "Название"),
    enabled: input.enabled,
    target: text(input.target, "Устройство", 256),
    outputs: validateOutputs(input.outputs),
  };
};
const validDate = (value) => {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value))
    fail("Дата: требуется YYYY-MM-DD");
  const date = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  )
    fail("Некорректная дата");
  return value;
};
const validateJob = (input) => {
  const result = base(input);
  result.kind = choice(input.kind, ["once", "daily"], "Повторение");
  result.event = choice(
    input.event,
    ["time", "sunrise", "day", "sunset", "night"],
    "Событие",
  );
  if (result.kind === "once") result.date = validDate(input.date);
  if (result.event === "time") {
    if (
      typeof input.time !== "string" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.time)
    )
      fail("Время: требуется HH:MM");
    result.time = input.time;
    result.offsetMinutes = 0;
  } else {
    result.offsetMinutes = number(
      input.offsetMinutes ?? 0,
      "Смещение",
      -1440,
      1440,
    );
    if (!Number.isInteger(result.offsetMinutes))
      fail("Смещение: требуется целое число минут");
  }
  return result;
};
const validateRule = (input) => {
  const result = base(input);
  result.sensorId = text(input.sensorId, "Датчик", 256);
  result.operator = choice(input.operator, ["lt", "between", "gt"], "Условие");
  if (result.operator !== "lt")
    result.min = number(input.min, "Нижний порог", 0, 1e9);
  if (result.operator !== "gt")
    result.max = number(input.max, "Верхний порог", 0, 1e9);
  if (result.operator === "between" && result.min >= result.max)
    fail("Нижний порог должен быть меньше верхнего");
  result.hysteresis = number(input.hysteresis ?? 0, "Гистерезис", 0, 1e9);
  return result;
};

const local = (timestamp, timeZone) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(timestamp);
  const p = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    time: `${p.hour}:${p.minute}`,
  };
};

// Run only within the current scheduled minute. Never replay old actions after an outage.
// Persist the returned key BEFORE dispatch to prevent duplicate commands after restart.
const due = (job, nowMs, environment, lastRun) => {
  if (!job.enabled || !Number.isFinite(nowMs) || !environment?.timeZone)
    return null;
  try {
    const now = local(nowMs, environment.timeZone);
    let anchorDate = now.date;
    if (job.event === "time") {
      if (now.time !== job.time) return null;
    } else {
      const days = Array.isArray(environment.solarDays)
        ? [...environment.solarDays, environment.solar]
        : [environment.solar];
      const anchor = days
        .map((day) => {
          const raw = day?.[job.event];
          return typeof raw === "string" ? Date.parse(raw) : NaN;
        })
        .find((timestamp) => {
          if (!Number.isFinite(timestamp)) return false;
          const scheduled = timestamp + job.offsetMinutes * 60_000;
          const date = local(timestamp, environment.timeZone).date;
          return (
            nowMs >= scheduled &&
            nowMs < scheduled + 60_000 &&
            (job.kind !== "once" || date === job.date)
          );
        });
      if (anchor === undefined) return null;
      anchorDate = local(anchor, environment.timeZone).date;
    }
    if (job.kind === "once" && anchorDate !== job.date) return null;
    const key = `${job.id || ""}:${anchorDate}`;
    return key === lastRun ? null : key;
  } catch {
    return null;
  }
};

// null is intentionally distinct from false: no fresh measurement means do nothing.
const luxMatch = (rule, sensor, previous = false, nowMs = Date.now()) => {
  if (
    !rule.enabled ||
    !sensor ||
    sensor.id !== rule.sensorId ||
    typeof sensor.lux !== "number" ||
    !Number.isFinite(sensor.lux) ||
    sensor.lux < 0
  )
    return null;
  const updated =
    typeof sensor.updatedAt === "number"
      ? sensor.updatedAt
      : Date.parse(sensor.updatedAt);
  if (
    !Number.isFinite(updated) ||
    updated > nowMs + 5000 ||
    nowMs - updated > 120_000
  )
    return null;
  const h = previous ? rule.hysteresis : 0;
  if (rule.operator === "lt") return sensor.lux < rule.max + h;
  if (rule.operator === "gt") return sensor.lux > rule.min - h;
  return sensor.lux >= rule.min - h && sensor.lux <= rule.max + h;
};
module.exports = { validateOutputs, validateJob, validateRule, due, luxMatch };
