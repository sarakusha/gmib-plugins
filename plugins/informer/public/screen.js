(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DEFAULT = {
    layout: { mode: "auto", leftWidth: 320 },
    clock: { seconds: false, locale: "ru-RU", timeZone: "Europe/Moscow" },
    date: {
      lines: 2,
      weekday: true,
      options: { day: "numeric", month: "long" },
    },
    appearance: { theme: "auto", shadow: 0.6, dim: 0.15, outline: 0 },
    styles: {
      clock: { font: "sans", size: 80, color: "#ffffff" },
      date: { font: "sans", size: 19, color: "#ffffff" },
      weekday: { font: "sans", size: 16, color: "#d6e9f4" },
      temperature: { font: "sans", size: 44, color: "#ffffff" },
      weather: { font: "sans", size: 18, color: "#ffffff" },
    },
    slides: { seconds: 8, current: true, details: true, forecast: true },
  };
  const fonts = {
    sans: "Arial,Helvetica,sans-serif",
    mono: "ui-monospace,SFMono-Regular,Menlo,Consolas,monospace",
    serif: "Georgia,Times New Roman,serif",
  };
  const labels = {
    clear: "Ясно",
    "partly-cloudy": "Малооблачно",
    cloudy: "Облачно",
    overcast: "Пасмурно",
    drizzle: "Морось",
    rain: "Дождь",
    "light-rain": "Небольшой дождь",
    "heavy-rain": "Сильный дождь",
    showers: "Ливень",
    snow: "Снег",
    "light-snow": "Небольшой снег",
    "heavy-snow": "Сильный снег",
    "wet-snow": "Мокрый снег",
    hail: "Град",
    thunderstorm: "Гроза",
    "thunderstorm-with-rain": "Гроза с дождём",
  };
  const windDirections = {
    n: "С",
    ne: "СВ",
    e: "В",
    se: "ЮВ",
    s: "Ю",
    sw: "ЮЗ",
    w: "З",
    nw: "СЗ",
    c: "штиль",
  };
  const windName = (value) =>
    windDirections[String(value || "").toLowerCase()] || text(value);
  const parts = {
    day: "Днём",
    evening: "Вечером",
    night: "Ночью",
    morning: "Утром",
  };
  let snapshot = null,
    settings = DEFAULT,
    slide = 0,
    lastSlide = Date.now(),
    lastDate = "",
    skyIndex = 0,
    lastSky = "",
    preview = false,
    ws = null,
    reconnect = null,
    disposed = false,
    connectionLost = false,
    refreshTimer = null,
    tickTimer = null,
    slideTimer = null;
  const pluginId = decodeURIComponent(
    location.pathname.match(/\/plugins\/([^/]+)\//)?.[1] || "informer",
  );
  const icon = (condition, daytime) => {
    const c = String(condition || "");
    const moon = daytime === "n";
    let core = "";
    if (c.includes("snow") || c === "hail")
      core =
        '<path d="M23 46l-3 5m15-5l-3 5m15-5l-3 5"/><path d="M20 48l3 1m12-1l3 1m12-1l3 1"/>';
    else if (
      c.includes("rain") ||
      c === "showers" ||
      c === "drizzle" ||
      c.includes("thunderstorm")
    )
      core = '<path d="M21 47l-3 6m17-6l-3 6m17-6l-3 6"/>';
    else if (c === "clear")
      core = moon
        ? '<path d="M42 12a22 22 0 1 0 14 38A22 22 0 0 1 42 12Z" fill="rgba(255,255,255,.72)" stroke="none"/>'
        : '<circle cx="36" cy="34" r="13" fill="rgba(255,221,144,.9)" stroke="none"/><path d="M36 8v6m0 40v6M10 34h6m40 0h6M18 16l5 5m26 26l5 5m0-36l-5 5M23 47l-5 5"/>';
    if (c !== "clear")
      core = `${c === "partly-cloudy" ? (moon ? '<path d="M31 9a14 14 0 1 0 10 22A14 14 0 0 1 31 9Z" fill="#e8f3ff" stroke="none"/>' : '<circle cx="28" cy="28" r="12" fill="rgba(255,221,144,.85)" stroke="none"/>') : ""}<path d="M20 43c-6 0-9-4-9-9s4-9 9-9c2 0 4 0 6 1 3-7 9-11 16-11 10 0 17 7 18 16 5 1 8 5 8 10 0 6-4 10-11 10H19" fill="rgba(237,246,252,.8)" stroke="rgba(255,255,255,.95)"/>${core}`;
    return `<svg viewBox="0 0 72 64" aria-hidden="true" fill="none" stroke="rgba(255,255,255,.95)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">${core}</svg>`;
  };
  const condition = (c) => labels[c] || "Погода";
  const temp = (n) =>
    Number.isFinite(n) ? `${n > 0 ? "+" : ""}${Math.round(n)}°` : "—";
  const text = (v) =>
    v === null || v === undefined || v === ""
      ? "—"
      : String(v).replace(
          /[&<>"']/g,
          (ch) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[ch],
        );
  const pad = (n) => String(n).padStart(2, "0");
  function clockParts(now) {
    try {
      return Object.fromEntries(
        new Intl.DateTimeFormat(settings.clock.locale, {
          timeZone: settings.clock.timeZone,
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hourCycle: "h23",
        })
          .formatToParts(now)
          .map((p) => [p.type, p.value]),
      );
    } catch {
      return {
        hour: pad(now.getHours()),
        minute: pad(now.getMinutes()),
        second: pad(now.getSeconds()),
      };
    }
  }
  function dateLines(now) {
    let options = settings.date.options || {};
    try {
      const locale = settings.clock.locale,
        zone = settings.clock.timeZone;
      const d = new Intl.DateTimeFormat(locale, {
        ...options,
        timeZone: zone,
      }).format(now);
      const weekday = settings.date.weekday
        ? new Intl.DateTimeFormat(locale, {
            timeZone: zone,
            weekday: "long",
          }).format(now)
        : "";
      if (settings.date.lines === 2 && options.year) {
        const parts = new Intl.DateTimeFormat(locale, {
          ...options,
          timeZone: zone,
        }).formatToParts(now);
        const year = parts.find((part) => part.type === "year")?.value;
        if (
          year &&
          parts.filter((part) => part.type !== "literal").length > 1
        ) {
          const main = parts
            .filter((part) => part.type !== "year")
            .map((part) => part.value)
            .join("")
            .replace(/^[,\s.]+|[,\s.]+$/g, "");
          return { main, extra: year, weekday };
        }
      }
      return { main: d, extra: "", weekday };
    } catch {
      return { main: now.toLocaleDateString(), extra: "", weekday: "" };
    }
  }
  function updateClock() {
    const now = new Date(),
      p = clockParts(now);
    $("hour").textContent = p.hour;
    $("minute").textContent = p.minute;
    $("second").textContent = p.second;
    const dayKey = `${new Intl.DateTimeFormat("en-CA", { timeZone: settings.clock.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)}-${settings.clock.locale}-${JSON.stringify(settings.date)}`;
    if (dayKey !== lastDate) {
      lastDate = dayKey;
      const d = dateLines(now);
      $("date-main").textContent = d.main;
      $("date-extra").textContent = d.extra;
      $("weekday").textContent = d.weekday;
    }
    updateSky(now);
  }
  // Solar elevation: NOAA fractional-year approximation, recalculated from live system time.
  function sunElevation(date, lat, lon) {
    const n = Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate(),
    );
    const day =
      Math.floor((n - Date.UTC(date.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    const minutes =
      date.getUTCHours() * 60 +
      date.getUTCMinutes() +
      date.getUTCSeconds() / 60;
    const g = ((2 * Math.PI) / 365) * (day - 1 + (minutes / 60 - 12) / 24);
    const eq =
      229.18 *
      (0.000075 +
        0.001868 * Math.cos(g) -
        0.032077 * Math.sin(g) -
        0.014615 * Math.cos(2 * g) -
        0.040849 * Math.sin(2 * g));
    const dec =
      0.006918 -
      0.399912 * Math.cos(g) +
      0.070257 * Math.sin(g) -
      0.006758 * Math.cos(2 * g) +
      0.000907 * Math.sin(2 * g) -
      0.002697 * Math.cos(3 * g) +
      0.00148 * Math.sin(3 * g);
    const hour = (minutes + eq + 4 * lon) / 4 - 180;
    const r = Math.PI / 180;
    return (
      Math.asin(
        Math.sin(lat * r) * Math.sin(dec) +
          Math.cos(lat * r) * Math.cos(dec) * Math.cos(hour * r),
      ) / r
    );
  }
  function timeOfDay(now) {
    if (settings.appearance.theme !== "auto") return settings.appearance.theme;
    const loc = snapshot?.weather?.location;
    let elevation = NaN;
    if (Number.isFinite(loc?.lat) && Number.isFinite(loc?.lon))
      elevation = sunElevation(now, loc.lat, loc.lon);
    if (Number.isFinite(elevation))
      return elevation > 0 ? "day" : elevation > -6 ? "dusk" : "night";
    const h = Number(clockParts(now).hour);
    return h >= 7 && h < 18
      ? "day"
      : (h >= 5 && h < 7) || (h >= 18 && h < 21)
        ? "dusk"
        : "night";
  }
  function weatherKind(c) {
    if (!c) return "clear";
    if (c.includes("snow") || c === "hail") return "snow";
    if (c.includes("thunder")) return "storm";
    if (c.includes("rain") || c === "drizzle" || c === "showers") return "rain";
    if (c.includes("cloud") || c === "overcast") return "cloud";
    return "clear";
  }
  function updateSky(now) {
    const key = `${timeOfDay(now)}/${weatherKind(snapshot?.weather?.condition)}`;
    if (key === lastSky) return;
    lastSky = key;
    skyIndex = 1 - skyIndex;
    const active = document.querySelector(skyIndex ? ".sky-b" : ".sky-a");
    const inactive = document.querySelector(skyIndex ? ".sky-a" : ".sky-b");
    const [tod, kind] = key.split("/");
    active.dataset.time = tod;
    active.dataset.weather = kind;
    active.style.opacity = "1";
    inactive.style.opacity = "0";
    if (snapshot) render();
  }
  function applySettings(value) {
    settings = value && value.styles ? value : DEFAULT;
    const root = document.documentElement.style;
    const s = settings.styles;
    for (const key of Object.keys(DEFAULT.styles)) {
      const v = s[key] || DEFAULT.styles[key];
      root.setProperty(`--${key}-font`, fonts[v.font] || fonts.sans);
      root.setProperty(`--${key}-size`, `${v.size}px`);
      root.setProperty(`--${key}-color`, v.color);
    }
    root.setProperty("--shade", String(settings.appearance.dim));
    root.setProperty("--shadow", String(settings.appearance.shadow));
    root.setProperty("--outline", `${settings.appearance.outline}px`);
    const weatherSize = s.weather?.size || DEFAULT.styles.weather.size;
    const tempSize = s.temperature?.size || DEFAULT.styles.temperature.size;
    root.setProperty(
      "--weather-label-size",
      `${Math.max(9, weatherSize * 0.61)}px`,
    );
    root.setProperty(
      "--detail-value-size",
      `${Math.max(13, weatherSize * 1.1)}px`,
    );
    root.setProperty(
      "--forecast-temp-size",
      `${Math.max(12, tempSize * 0.34)}px`,
    );
    root.setProperty(
      "--compact-weather-size",
      `${Math.max(9, weatherSize * 0.67)}px`,
    );
    root.setProperty(
      "--compact-detail-size",
      `${Math.max(11, weatherSize * 0.72)}px`,
    );
    root.setProperty(
      "--compact-temp-size",
      `${Math.min(40, Math.max(20, tempSize * 0.72))}px`,
    );
    root.setProperty(
      "--compact-forecast-temp-size",
      `${Math.max(10, tempSize * 0.27)}px`,
    );

    $("seconds-wrap").hidden = !settings.clock.seconds;
    document.body.classList.toggle("with-seconds", settings.clock.seconds);
    lastDate = "";
    layout();
    updateClock();
    render();
  }
  function layout() {
    const w = innerWidth,
      h = innerHeight;
    const compact =
      settings.layout.mode === "compact" ||
      (settings.layout.mode === "auto" &&
        w < Math.max(settings.layout.leftWidth + 220, 520));
    document.body.classList.toggle("compact", compact);
    document.documentElement.style.setProperty(
      "--scale",
      String(
        Math.max(
          0.1,
          Math.min(
            2.5,
            h / 192,
            (compact ? w : settings.layout.leftWidth) / 320,
            compact ? Infinity : (w - settings.layout.leftWidth) / 384,
          ),
        ),
      ),
    );
    document.querySelector(".time-pane").style.flexBasis = compact
      ? "100%"
      : `${settings.layout.leftWidth}px`;
  }
  function availableSlides() {
    const w = snapshot?.weather;
    if (!w) return ["empty"];
    const a = [];
    if (settings.slides.current) a.push("current");
    if (
      settings.slides.details &&
      [w.windSpeed, w.pressureMm, w.humidity].some(Number.isFinite)
    )
      a.push("details");
    if (
      settings.slides.forecast &&
      Array.isArray(w.forecast) &&
      w.forecast.length
    )
      a.push("forecast");
    return a.length ? a : ["empty"];
  }
  function forecastItem(f) {
    const label = `${parts[f.part] || "Прогноз"}${f.date ? " · " + new Intl.DateTimeFormat(settings.clock.locale, { day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(`${f.date}T12:00:00Z`)) : ""}`;
    const t =
      Number.isFinite(f.tempMin) && Number.isFinite(f.tempMax)
        ? `${temp(f.tempMin)}…${temp(f.tempMax)}`
        : temp(Number.isFinite(f.tempMax) ? f.tempMax : f.tempMin);
    return `<div class="forecast-item">${icon(f.condition, f.daytime)}<span class="forecast-label">${label}</span><span class="forecast-temp">${t}</span></div>`;
  }
  function render() {
    const weather = snapshot?.weather,
      cache = snapshot?.cache;
    const slides = availableSlides(),
      kind = slides[slide % slides.length];
    let html = "";
    if (kind === "empty")
      html = '<div class="empty-weather">Погода недоступна</div>';
    if (kind === "current")
      html = `<div class="weather-caption">Сейчас</div><div class="weather-current"><div class="weather-icon">${icon(weather.condition, timeOfDay(new Date()) === "night" ? "n" : "d")}</div><div><div class="weather-temp">${temp(weather.temp)}</div><div class="weather-condition">${condition(weather.condition)}</div>${Number.isFinite(weather.feelsLike) ? `<div class="weather-sub">Ощущается как ${temp(weather.feelsLike)}</div>` : ""}</div></div>${document.body.classList.contains("compact") || !settings.slides.forecast ? "" : `<div class="forecast-row">${(weather.forecast || []).slice(0, 2).map(forecastItem).join("")}</div>`}`;
    if (kind === "details")
      html = `<div class="weather-caption">Погодные условия</div><div class="detail-grid">${Number.isFinite(weather.windSpeed) ? `<div><div class="detail-label">Ветер</div><div class="detail-value">${weather.windSpeed} м/с ${windName(weather.windDir)}</div></div>` : ""}${Number.isFinite(weather.pressureMm) ? `<div><div class="detail-label">Давление</div><div class="detail-value">${weather.pressureMm} мм</div></div>` : ""}${Number.isFinite(weather.humidity) ? `<div><div class="detail-label">Влажность</div><div class="detail-value">${weather.humidity}%</div></div>` : ""}</div>`;
    if (kind === "forecast")
      html = `<div class="weather-caption">Прогноз · сохранённый снимок</div><div class="forecast-row">${weather.forecast.slice(0, 2).map(forecastItem).join("")}</div>`;
    $("weather-slide").innerHTML = html;
    const origin =
      cache?.origin === "sample"
        ? "Демо · "
        : cache?.origin === "capture"
          ? "Снимок · "
          : cache?.origin === "import"
            ? "Импорт · "
            : "";
    const date = weather?.observedAt || weather?.fetchedAt || cache?.fetchedAt;
    $("freshness").textContent =
      (connectionLost ? "Нет связи · " : "") +
      origin +
      (date
        ? new Intl.DateTimeFormat(settings.clock.locale, {
            day: "numeric",
            month: "short",
            year: "numeric",
            hour: "2-digit",
            minute: "2-digit",
            timeZone: settings.clock.timeZone,
          }).format(new Date(date))
        : "нет данных");
  }
  function advance() {
    const count = availableSlides().length;
    if (count < 2) return;
    const now = Date.now();
    if (now - lastSlide < (settings.slides.seconds || 8) * 1000) return;
    lastSlide = now;
    const el = $("weather-slide");
    el.classList.add("out");
    slideTimer = setTimeout(() => {
      slide = (slide + 1) % count;
      render();
      el.classList.remove("out");
    }, 340);
  }
  function accept(data) {
    if (!data || typeof data !== "object" || !data.settings) return;
    connectionLost = false;
    snapshot = data;
    if (!preview) applySettings(data.settings);
    else {
      updateSky(new Date());
      render();
    }
  }
  async function fetchState() {
    if (preview || disposed) return;
    try {
      const r = await fetch("api/state", { cache: "no-store" });
      if (!r.ok) throw Error();
      accept(await r.json());
    } catch {
      connectionLost = true;
      render();
    }
  }
  function connect() {
    if (preview || disposed) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      ws = new WebSocket(`${protocol}//${location.host}`);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ sourceId: Date.now() }));
        fetchState();
      });
      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === `plugin:${pluginId}:changed`) accept(msg.data?.[0]);
        } catch {}
      });
      ws.addEventListener("close", () => {
        if (disposed) return;
        connectionLost = true;
        render();
        reconnect = setTimeout(connect, 3000);
      });
    } catch {
      reconnect = setTimeout(connect, 5000);
    }
  }
  addEventListener("message", (event) => {
    if (
      event.origin !== location.origin ||
      event.source !== parent ||
      event.data?.type !== "informer:preview"
    )
      return;
    preview = true;
    if (event.data.snapshot) accept(event.data.snapshot);
    if (event.data.settings) applySettings(event.data.settings);
  });
  addEventListener("resize", () => {
    layout();
    render();
  });
  addEventListener("visibilitychange", () => {
    if (!document.hidden) updateClock();
  });
  addEventListener("pagehide", () => {
    disposed = true;
    ws?.close();
    clearTimeout(reconnect);
    clearTimeout(slideTimer);
    clearInterval(refreshTimer);
    clearInterval(tickTimer);
  });
  const isPreview = new URLSearchParams(location.search).has("preview");
  preview = isPreview;
  layout();
  updateClock();
  render();
  if (!preview) {
    fetchState();
    connect();
    refreshTimer = setInterval(fetchState, 60000);
  }
  tickTimer = setInterval(() => {
    updateClock();
    advance();
  }, 250);
})();
