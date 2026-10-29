(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const defaults = {
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
  let snapshot = null,
    draft = structuredClone(defaults),
    output = null,
    ready = false,
    previewMode = "wide",
    ws = null,
    reconnect = null,
    disposed = false;
  const pluginId = decodeURIComponent(
    location.pathname.match(/\/plugins\/([^/]+)\//)?.[1] || "informer",
  );
  const styleLabels = {
    clock: "Время",
    date: "Дата",
    weekday: "День недели",
    temperature: "Температура",
    weather: "Погодная подпись",
  };
  const styleRoot = $("style-fields");
  for (const [key, label] of Object.entries(styleLabels)) {
    const row = document.createElement("div");
    row.className = "style-row";
    row.innerHTML = `<strong>${label}</strong><label>Шрифт<select data-path="styles.${key}.font"><option value="sans">Без засечек</option><option value="mono">Моно</option><option value="serif">С засечками</option></select></label><label>Размер, px<input type="number" min="8" max="160" step="1" data-path="styles.${key}.size"></label><label>Цвет<input type="color" data-path="styles.${key}.color"></label>`;
    styleRoot.append(row);
  }
  function setPath(path, value) {
    const keys = path.split(".");
    let node = draft;
    for (const k of keys.slice(0, -1)) node = node[k];
    node[keys.at(-1)] = value;
  }
  function getPath(path) {
    return path.split(".").reduce((v, k) => v?.[k], draft);
  }
  function show(message, error = false) {
    $("feedback").textContent = message;
    $("feedback").classList.toggle("error", error);
  }
  function payloadError(body, status) {
    return typeof body?.error === "string"
      ? body.error
      : `Ошибка запроса (${status})`;
  }
  async function api(path, method = "GET", body) {
    const response = await fetch(`api/${path}`, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: "no-store",
    });
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw Error(payloadError(data, response.status));
    return data;
  }
  function bind() {
    document.querySelectorAll("[data-path]").forEach((input) => {
      const value = getPath(input.dataset.path);
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = value;
    });
    $("date-options").value = JSON.stringify(draft.date.options, null, 2);
    $("shadow-value").textContent = draft.appearance.shadow;
    $("dim-value").textContent = draft.appearance.dim;
  }
  function readDraft() {
    for (const input of document.querySelectorAll("[data-path]")) {
      let value = input.type === "checkbox" ? input.checked : input.value;
      if (
        input.type === "number" ||
        input.type === "range" ||
        input.dataset.path === "date.lines"
      )
        value = Number(value);
      setPath(input.dataset.path, value);
    }
    try {
      draft.date.options = JSON.parse($("date-options").value);
    } catch {
      throw Error("Параметры даты должны быть корректным JSON.");
    }
    validate();
  }
  function validate() {
    if (
      !draft.date.options ||
      typeof draft.date.options !== "object" ||
      Array.isArray(draft.date.options)
    )
      throw Error("Параметры даты должны быть объектом.");
    const allowed = new Set([
      "dateStyle",
      "weekday",
      "era",
      "year",
      "month",
      "day",
    ]);
    if (Object.keys(draft.date.options).some((k) => !allowed.has(k)))
      throw Error("Параметры даты содержат неподдерживаемое поле.");
    try {
      new Intl.DateTimeFormat(draft.clock.locale, {
        timeZone: draft.clock.timeZone,
        ...draft.date.options,
      });
    } catch {
      throw Error("Проверьте локаль, часовой пояс и параметры даты.");
    }
    if (!["current", "details", "forecast"].some((k) => draft.slides[k]))
      throw Error("Включите хотя бы один погодный слайд.");
    for (const input of document.querySelectorAll(
      "input[type=number][data-path]",
    ))
      if (!input.validity.valid)
        throw Error(
          `Проверьте поле «${input.closest("label")?.textContent?.trim() || input.dataset.path}».`,
        );
  }
  function preview() {
    if (!ready) return;
    try {
      readDraft();
      show("");
    } catch (e) {
      show(e.message, true);
      return;
    }
    const frame = $("preview-frame");
    frame.contentWindow?.postMessage(
      { type: "informer:preview", settings: draft, snapshot },
      location.origin,
    );
  }
  function resizePreview() {
    const holder = document.querySelector(".preview-frame"),
      frame = $("preview-frame");
    holder.classList.toggle("compact", previewMode === "compact");
    const base = previewMode === "compact" ? 320 : 704;
    const scale = holder.clientWidth / base;
    frame.style.transform = `scale(${scale})`;
  }
  function updateCache() {
    const c = snapshot?.cache,
      w = snapshot?.weather;
    const date = (v) =>
      v
        ? new Intl.DateTimeFormat("ru-RU", {
            dateStyle: "medium",
            timeStyle: "short",
          }).format(new Date(v))
        : "—";
    const origin =
      {
        sample: "демонстрационный образец",
        capture: "однократная загрузка",
        import: "импорт",
      }[c?.origin] || "нет данных";
    $("cache-status").textContent =
      `Режим: сохранённый снимок\nПроисхождение: ${origin}\nПолучен: ${date(c?.fetchedAt)}\nНаблюдение: ${date(w?.observedAt)}\nПопытка запроса: ${date(c?.attemptedAt)}${c?.message ? `\n${c.message}` : ""}`;
    $("capture").disabled = Boolean(c?.attemptedAt);
    if (Number.isFinite(w?.location?.lat)) $("latitude").value = w.location.lat;
    if (Number.isFinite(w?.location?.lon))
      $("longitude").value = w.location.lon;
  }
  function updateSnapshot(data, keepDraft = false) {
    if (!data || typeof data !== "object" || !data.settings) return;
    snapshot = data;
    if (!keepDraft) {
      draft = structuredClone(data.settings);
      bind();
    }
    updateCache();
    $("connection").textContent = "Подключено";
    preview();
  }
  async function load() {
    try {
      const data = await api("state");
      ready = true;
      updateSnapshot(data);
      await loadOutput();
    } catch (e) {
      $("connection").textContent = "Нет связи";
      show(e.message, true);
    }
  }
  async function loadOutput() {
    try {
      output = await api("output");
      const select = $("screen-select");
      select.replaceChildren(new Option("Выберите экран", ""));
      for (const s of output.screens || [])
        select.add(new Option(`${s.name} · ${s.width} × ${s.height}`, s.id));
      const status = output.status || {};
      $("output-status").textContent =
        status.message ||
        (status.active ? "Вывод запущен" : "Вывод не запущен") +
          (status.profile ? ` · ${status.profile}` : "");
      if (status.profile?.screenId)
        select.value = String(status.profile.screenId);
      $("auto-start").checked = Boolean(status.profile?.autoStart);
    } catch (e) {
      $("output-status").textContent =
        `Состояние вывода недоступно: ${e.message}`;
    }
  }
  async function action(path, method, body, done) {
    try {
      show("Выполняется…");
      const data = await api(path, method, body);
      if (data?.settings) updateSnapshot(data);
      else await loadOutput();
      show(done);
    } catch (e) {
      show(e.message, true);
      throw e;
    }
  }
  document
    .querySelectorAll("[data-path],#date-options")
    .forEach((input) => input.addEventListener("input", preview));
  $("save").addEventListener("click", async () => {
    try {
      readDraft();
      await action("settings", "PUT", draft, "Настройки сохранены.");
    } catch (e) {
      if (!$("feedback").textContent.includes(e.message)) show(e.message, true);
    }
  });
  $("import").addEventListener("click", async () => {
    let data;
    try {
      data = JSON.parse($("import-json").value);
    } catch {
      show("Введите корректный JSON ответа Яндекс Погоды.", true);
      return;
    }
    try {
      await action("weather/import", "POST", { data }, "Снимок импортирован.");
      $("import-json").value = "";
    } catch {}
  });
  $("capture").addEventListener("click", async () => {
    const key = $("api-key").value,
      lat = Number($("latitude").value),
      lon = Number($("longitude").value);
    if (
      !key ||
      !$("latitude").value ||
      !$("longitude").value ||
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      lat < -90 ||
      lat > 90 ||
      lon < -180 ||
      lon > 180
    ) {
      show("Укажите ключ и допустимые координаты.", true);
      return;
    }
    try {
      await action(
        "weather/capture",
        "POST",
        { apiKey: key, lat, lon },
        "Прогноз получен и сохранён.",
      );
    } catch {
      try {
        updateSnapshot(await api("state"), true);
      } catch {}
    } finally {
      $("api-key").value = "";
    }
  });
  $("start-output").addEventListener("click", async () => {
    const screenId = $("screen-select").value;
    if (!screenId) {
      show("Выберите экран GMIB.", true);
      return;
    }
    try {
      await action(
        "output",
        "PUT",
        {
          screenId: Number(screenId),
          pageId: "screen",
          autoStart: $("auto-start").checked,
        },
        "Вывод назначен.",
      );
    } catch {}
  });
  $("stop-output").addEventListener("click", async () => {
    try {
      await action("output", "DELETE", undefined, "Вывод остановлен.");
    } catch {}
  });
  for (const button of document.querySelectorAll("[data-preview]"))
    button.addEventListener("click", () => {
      previewMode = button.dataset.preview;
      document
        .querySelectorAll("[data-preview]")
        .forEach((b) => b.classList.toggle("active", b === button));
      resizePreview();
      preview();
    });
  $("preview-frame").addEventListener("load", preview);
  new ResizeObserver(resizePreview).observe(
    document.querySelector(".preview-frame"),
  );
  function connect() {
    if (disposed) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    try {
      ws = new WebSocket(`${protocol}//${location.host}`);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ sourceId: Date.now() }));
        api("state")
          .then((data) => {
            ready = true;
            updateSnapshot(data, ready && snapshot !== null);
          })
          .catch(() => {});
      });
      ws.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.event === `plugin:${pluginId}:changed`)
            updateSnapshot(msg.data?.[0], true);
        } catch {}
      });
      ws.addEventListener("close", () => {
        if (disposed) return;
        $("connection").textContent = "Нет realtime-связи";
        reconnect = setTimeout(connect, 3000);
      });
    } catch {
      reconnect = setTimeout(connect, 5000);
    }
  }
  addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(reconnect);
    ws?.close();
  });
  resizePreview();
  load();
  connect();
})();
