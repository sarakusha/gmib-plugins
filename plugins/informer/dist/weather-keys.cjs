"use strict";

const { createHash } = require("node:crypto");
const DAY = 86400000,
  MOSCOW = 10800000;
const dayAt = (now) => new Date(now + MOSCOW).toISOString().slice(0, 10);
const resetAt = (now) => (Math.floor((now + MOSCOW) / DAY) + 1) * DAY - MOSCOW;
const fingerprint = (key) => createHash("sha256").update(key).digest("hex");
const finite = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const validType = (type) => ["auto", "home", "site"].includes(type);
function validateSource(value, previous = { keys: [] }) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    !finite(value.lat, -90, 90) ||
    !finite(value.lon, -180, 180) ||
    typeof value.useLastResponse !== "boolean"
  )
    throw Error("Проверьте координаты и режим источника.");
  let entries = value.keys;
  if (entries === undefined) {
    if (previous.keys.length > 1)
      throw Error("Обновите страницу для настройки нескольких ключей.");
    entries = [
      {
        id: previous.keys[0]?.id || "legacy",
        name: previous.keys[0]?.name || "Ключ 1",
        type: previous.keys[0]?.type || "site",
        dailyLimit: value.dailyLimit,
        apiKey: value.apiKey,
      },
    ];
  }
  if (!Array.isArray(entries) || entries.length > 10)
    throw Error("Можно добавить не более 10 ключей.");
  const ids = new Set(),
    secrets = new Set();
  const keys = entries.map((item, index) => {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      typeof item.id !== "string" ||
      !/^[a-zA-Z0-9_-]{1,80}$/.test(item.id) ||
      ids.has(item.id) ||
      !validType(item.type) ||
      !Number.isSafeInteger(item.dailyLimit) ||
      item.dailyLimit < 1 ||
      item.dailyLimit > 10000
    )
      throw Error(
        "Проверьте тип, суточный лимит (1–10000) и уникальность ключей.",
      );
    ids.add(item.id);
    const name =
      typeof item.name === "string"
        ? item.name.trim().normalize("NFC")
        : `Ключ ${index + 1}`;
    if (name.length > 80 || /[\p{Cc}\p{Cf}]/u.test(name))
      throw Error(
        "Название ключа — не более 80 символов без управляющих знаков.",
      );
    const old = previous.keys.find((key) => key.id === item.id);
    const apiKey =
      item.apiKey === undefined || item.apiKey === ""
        ? old?.apiKey || ""
        : item.apiKey;
    if (
      typeof apiKey !== "string" ||
      (apiKey && !/^[a-zA-Z0-9_-]{16,200}$/.test(apiKey))
    )
      throw Error("Проверьте ключ API Яндекс Погоды.");
    if (apiKey && secrets.has(apiKey))
      throw Error("Один API-ключ нельзя добавить дважды.");
    if (apiKey) secrets.add(apiKey);
    return {
      id: item.id,
      name,
      type: item.type,
      dailyLimit: item.dailyLimit,
      apiKey,
    };
  });
  if (
    !value.useLastResponse &&
    (!keys.length || keys.some((key) => !key.apiKey))
  )
    throw Error("Для обновления погоды укажите API-ключ в каждой строке.");
  return {
    lat: value.lat,
    lon: value.lon,
    useLastResponse: value.useLastResponse,
    keys,
  };
}
function restoreSource(saved, weather) {
  const fallback = {
    lat: weather.location.lat ?? 56.6333,
    lon: weather.location.lon ?? 47.8908,
    useLastResponse: true,
    keys: [],
  };
  try {
    return validateSource(saved, fallback);
  } catch {
    return fallback;
  }
}
function counterAt(saved, now, legacyAttempt) {
  const count = (n) => (Number.isSafeInteger(n) && n >= 0 ? n : 0);
  const legacy = finite(legacyAttempt, 1, 1e15) ? legacyAttempt : null;
  const value =
    saved && typeof saved === "object"
      ? saved
      : {
          day: legacy ? dayAt(legacy) : dayAt(now),
          used: legacy ? 1 : 0,
          total: legacy ? 1 : 0,
          lastAttemptAt: legacy,
        };
  const same = value.day === dayAt(now);
  return {
    day: dayAt(now),
    used: same ? count(value.used) : 0,
    attempts: same ? count(value.attempts ?? value.used) : 0,
    total: Math.max(count(value.total), count(value.used)),
    lastAttemptAt: finite(value.lastAttemptAt, 0, 1e15)
      ? value.lastAttemptAt
      : null,
    nextRequestAt:
      same && finite(value.nextRequestAt, 0, 1e15) ? value.nextRequestAt : null,
    blockedUntil:
      same && finite(value.blockedUntil, 0, 1e15) ? value.blockedUntil : 0,
    detectedType: ["home", "site"].includes(value.detectedType)
      ? value.detectedType
      : null,
    lastStatus:
      Number.isInteger(value.lastStatus) &&
      value.lastStatus >= 100 &&
      value.lastStatus <= 599
        ? value.lastStatus
        : null,
    message:
      typeof value.message === "string" ? value.message.slice(0, 240) : "",
  };
}
function usageAt(saved, now, legacyAttempt) {
  const result = counterAt(saved, now, legacyAttempt);
  result.keys = {};
  if (
    saved?.keys &&
    typeof saved.keys === "object" &&
    !Array.isArray(saved.keys)
  ) {
    for (const [hash, value] of Object.entries(saved.keys))
      if (/^[a-f0-9]{64}$/.test(hash))
        result.keys[hash] = counterAt(value, now);
  }
  return result;
}
function restoreUsage(saved, now, legacyAttempt, source) {
  const result = usageAt(saved, now, legacyAttempt);
  if (!saved?.keys && source.keys.length === 1 && source.keys[0].apiKey) {
    const { keys, ...counter } = result;
    result.keys[fingerprint(source.keys[0].apiKey)] = {
      ...counter,
      detectedType: source.keys[0].type === "auto" ? null : source.keys[0].type,
    };
  }
  return result;
}
const poolSignature = (source) =>
  JSON.stringify(
    source.keys
      .map((key) => [key.apiKey, key.type, key.dailyLimit])
      .sort((a, b) => a[0].localeCompare(b[0])),
  );
module.exports = {
  dayAt,
  resetAt,
  fingerprint,
  validateSource,
  restoreSource,
  counterAt,
  usageAt,
  restoreUsage,
  poolSignature,
};
