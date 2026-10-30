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
    appearance: {
      theme: "auto",
      backdrop: "gradient",
      showSource: false,
      sourceSize: 16,
      valueAnimation: "none",
      shadow: 0.6,
      dim: 0.15,
      outline: 0,
    },
    styles: {
      clock: { font: "sans", size: 80, color: "#ffffff" },
      date: { font: "sans", size: 19, color: "#ffffff" },
      weekday: { font: "sans", size: 16, color: "#d6e9f4" },
      temperature: { font: "sans", size: 44, color: "#ffffff" },
      weather: { font: "sans", size: 18, color: "#ffffff" },
      forecast: { font: "sans", size: 18, color: "#ffffff" },
      metrics: { font: "sans", size: 14, color: "#ffffff" },
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
    day: "День",
    evening: "Вечер",
    night: "Ночь",
    morning: "Утро",
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
  const remoteIcon = (url) => {
    if (typeof url !== "string" || url.length > 1000) return null;
    try {
      const parsed = new URL(url);
      return parsed.protocol === "https:" &&
        !parsed.username &&
        !parsed.password &&
        !parsed.port &&
        ((parsed.hostname === "yastatic.net" &&
          parsed.pathname.startsWith("/weather/")) ||
          parsed.hostname === "weather.yastatic.net") &&
        /\.(?:svg|png|webp)$/.test(parsed.pathname)
        ? parsed.toString()
        : null;
    } catch {
      return null;
    }
  };
  const weatherIcon = (weather, daytime = weather.daytime) => {
    const url = remoteIcon(weather.iconUrl);
    return url
      ? `<img class="page-weather-icon" src="${text(url)}" alt="" aria-hidden="true" referrerpolicy="no-referrer" data-condition="${text(weather.condition)}" data-daytime="${daytime === "n" ? "n" : "d"}">`
      : icon(weather.condition, daytime);
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
  function fitDateTime() {
    const line = document.querySelector(".datetime");
    line.style.setProperty("--line-fit", "1");
    if (settings.date.lines !== 1) return;
    const pane = document.querySelector(".time-pane");
    const style = getComputedStyle(pane);
    const available =
      pane.clientWidth -
      parseFloat(style.paddingLeft) -
      parseFloat(style.paddingRight);
    line.style.setProperty(
      "--line-fit",
      String(Math.min(1, available / line.scrollWidth)),
    );
  }
  function updateClock() {
    const now = new Date(),
      p = clockParts(now);
    const animated = settings.appearance.valueAnimation === "flip";
    InformerMotion.set($("hour"), p.hour, animated);
    InformerMotion.set($("minute"), p.minute, animated);
    InformerMotion.set($("second"), p.second, animated);
    const dayKey = `${new Intl.DateTimeFormat("en-CA", { timeZone: settings.clock.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)}-${settings.clock.locale}-${JSON.stringify(settings.date)}`;
    if (dayKey !== lastDate) {
      lastDate = dayKey;
      const d = InformerDate.formatDate(now, settings.date, settings.clock);
      InformerMotion.set($("date-main"), d.calendar, animated);
      InformerMotion.set($("weekday"), d.weekday, animated);
      $("date-join").hidden = !(d.calendar && d.weekday);
      const hasDate = Boolean(d.calendar || d.weekday);
      document.querySelector(".date-area").hidden = !hasDate;
      $("time-join").hidden = settings.date.lines !== 1 || !hasDate;
    }
    fitDateTime();
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
  function updateSky(now) {
    const time = timeOfDay(now);
    // Keep the saved dusk setting compatible; the bundled assets call it dawn.
    const tod = time === "dusk" ? "dawn" : time;
    const condition = snapshot?.weather?.condition;
    const backdrop = settings.appearance.backdrop || "gradient";
    const cover = InformerWeather.cloudCover(condition);
    const key = `${tod}/${backdrop}/${cover}`;
    if (key === lastSky) return;
    lastSky = key;
    skyIndex = 1 - skyIndex;
    const active = document.querySelector(skyIndex ? ".sky-b" : ".sky-a");
    const inactive = document.querySelector(skyIndex ? ".sky-a" : ".sky-b");
    active.className = [
      "sky",
      skyIndex ? "sky-b" : "sky-a",
      backdrop,
      tod,
      cover,
    ].join(" ");
    active.style.opacity = "1";
    inactive.style.opacity = "0";
    if (snapshot) render();
  }
  function applySettings(value) {
    settings = value && value.styles ? value : DEFAULT;
    if (settings.appearance.valueAnimation !== "flip") {
      document.querySelectorAll("[data-value]").forEach((el) => {
        const value = el.dataset.value;
        delete el.dataset.value;
        InformerMotion.set(el, value, false);
      });
    }
    const root = document.documentElement.style;
    const s = settings.styles;
    for (const key of Object.keys(DEFAULT.styles)) {
      const v = s[key] || DEFAULT.styles[key];
      root.setProperty(`--${key}-font`, fonts[v.font] || fonts.sans);
      root.setProperty(`--${key}-size`, `${v.size}px`);
      root.setProperty(`--${key}-color`, v.color);
    }
    root.setProperty(
      "--source-size",
      `${settings.appearance.sourceSize ?? 16}px`,
    );
    root.setProperty("--shade", String(settings.appearance.dim));
    document.querySelector(".weather-footer").hidden =
      !settings.appearance.showSource;
    document.body.classList.toggle(
      "no-source",
      !settings.appearance.showSource,
    );
    root.setProperty("--shadow", String(settings.appearance.shadow));
    root.setProperty("--outline", `${settings.appearance.outline}px`);
    const tempSize = s.temperature?.size || DEFAULT.styles.temperature.size;
    root.setProperty(
      "--compact-temp-size",
      `${Math.min(40, Math.max(20, tempSize * 0.72))}px`,
    );

    root.setProperty(
      "--inline-clock-size",
      `${(s.clock.size / 80) * s.date.size}px`,
    );
    document.body.classList.toggle("single-line", settings.date.lines === 1);
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
    clearTimeout(slideTimer);
    $("weather-slide").classList.remove("out");
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
  function forecastItem(f, index) {
    const label = parts[f.part] || "Прогноз";
    const t =
      Number.isFinite(f.tempMin) &&
      Number.isFinite(f.tempMax) &&
      f.tempMin !== f.tempMax
        ? `${temp(f.tempMin)}…${temp(f.tempMax)}`
        : temp(Number.isFinite(f.tempMax) ? f.tempMax : f.tempMin);
    return `<div class="forecast-item">${weatherIcon(f)}<span class="forecast-label" data-value-key="forecast-${index}-${f.part}-label">${label}</span><span class="forecast-temp" data-value-key="forecast-${index}-${f.part}-temp">${t}</span></div>`;
  }
  function metrics(weather) {
    if (!weather) return "";
    const angle = InformerWeather.windAngle(weather.windDir);
    const direction = weather.windDir
      ? `${angle === null ? "" : `<img class="wind-direction" src="assets/icons/wind-direction.svg" alt="" aria-hidden="true" style="transform:rotate(${angle}deg)">`}<span>${windName(weather.windDir)}</span>`
      : "";
    const detail = (name, asset, value, extra = "") =>
      `<div class="detail-reading" role="group" aria-label="${name}" title="${name}"><img class="detail-icon" src="assets/icons/${asset}.svg" alt="" aria-hidden="true"><span class="detail-value" data-value-key="${asset}">${value}</span>${extra}</div>`;
    return `<div class="detail-grid">${Number.isFinite(weather.windSpeed) ? detail("Ветер", "wind", `${weather.windSpeed} м/с`, direction) : ""}${Number.isFinite(weather.pressureMm) ? detail("Давление", "pressure", `${weather.pressureMm} мм рт.ст.`) : ""}${Number.isFinite(weather.humidity) ? detail("Влажность", "humidity", `${weather.humidity}%`) : ""}</div>`;
  }
  let lastWeatherKind = "",
    lastWeatherMarkup = "";
  const valueSelector =
    ".weather-temp, .weather-condition, .weather-sub, .forecast-label, .forecast-temp, .detail-value";
  const valueKey = (el) => el.dataset.valueKey || el.className;
  function render() {
    const weather = snapshot?.weather;
    const compact = document.body.classList.contains("compact");
    const slides = availableSlides(),
      kind = !weather
        ? "empty"
        : compact
          ? slides[slide % slides.length]
          : "current";
    const weatherKind = `${compact}/${kind}`;
    const oldValues = new Map(
      weatherKind === lastWeatherKind
        ? [...document.querySelectorAll(valueSelector)].map((el) => [
            valueKey(el),
            el.dataset.value ?? el.textContent,
          ])
        : [],
    );
    lastWeatherKind = weatherKind;
    const metricsHtml = compact
      ? ""
      : `<div class="weather-content">${metrics(weather)}</div>`;
    let html = "";
    if (kind === "empty")
      html = '<div class="empty-weather">Погода недоступна</div>';
    if (kind === "current")
      html = `<div class="weather-current"><div class="weather-icon">${weatherIcon(weather, timeOfDay(new Date()) === "night" ? "n" : "d")}</div><div><div class="weather-temp">${temp(weather.temp)}</div><div class="weather-condition">${condition(weather.condition)}</div>${Number.isFinite(weather.feelsLike) ? `<div class="weather-sub">Ощущается как ${temp(weather.feelsLike)}</div>` : ""}</div></div>${compact ? "" : `<div class="forecast-row">${(weather.forecast || []).slice(0, 2).map(forecastItem).join("")}</div>`}`;
    if (kind === "details")
      html = `<div class="weather-caption">Погодные условия</div>${metrics(weather)}`;
    if (kind === "forecast")
      html = `<div class="weather-caption">Прогноз · сохранённый снимок</div><div class="forecast-row">${weather.forecast.slice(0, 2).map(forecastItem).join("")}</div>`;
    const markup = `${weatherKind}/${metricsHtml}/${html}`;
    if (markup === lastWeatherMarkup) {
      fitWeatherContent();
      if (!compact) fitContent($("clock-metrics"));
      return;
    }
    lastWeatherMarkup = markup;
    $("clock-metrics").innerHTML = metricsHtml;
    $("weather-slide").innerHTML = `<div class="weather-content">${html}</div>`;
    document.querySelectorAll(".page-weather-icon").forEach((img) => {
      img.addEventListener(
        "error",
        () => {
          // Render only the bundled, trusted SVG when an external image is unavailable.
          const fallback = document.createElement("template");
          fallback.innerHTML = icon(img.dataset.condition, img.dataset.daytime);
          img.replaceWith(fallback.content);
          fitWeatherContent();
        },
        { once: true },
      );
      img.addEventListener("load", fitWeatherContent, { once: true });
    });
    document.querySelectorAll(valueSelector).forEach((el) => {
      InformerMotion.set(
        el,
        el.textContent,
        settings.appearance.valueAnimation === "flip",
        oldValues.get(valueKey(el)),
      );
    });
    fitWeatherContent();
    if (!compact) fitContent($("clock-metrics"));
  }
  function fitWeatherContent() {
    fitContent($("weather-slide"));
  }
  function fitContent(pane) {
    const content = pane.querySelector(".weather-content");
    if (!content || !content.offsetWidth || !content.offsetHeight) return;
    content.style.setProperty("--weather-fit", "1");
    content.style.marginTop = "0";
    const natural = content.getBoundingClientRect();
    const fit = Math.min(
      1,
      pane.clientWidth / natural.width,
      pane.clientHeight / natural.height,
    );
    content.style.setProperty("--weather-fit", String(fit));
    content.style.marginTop =
      document.body.classList.contains("compact") || pane.id === "clock-metrics"
        ? `${Math.max(0, (pane.clientHeight - natural.height * fit) / 2)}px`
        : "0";
  }
  function advance() {
    if (!document.body.classList.contains("compact")) return;
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
    snapshot = data;
    $("test-output").hidden = data.source?.useLastResponse === false;
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
    if (event.data.source)
      $("test-output").hidden = event.data.source.useLastResponse === false;
    if (event.data.settings) applySettings(event.data.settings);
  });
  addEventListener("resize", () => {
    layout();
    fitDateTime();
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
