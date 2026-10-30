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
    appearance: {
      theme: "auto",
      backdrop: "gradient",
      valueAnimation: "none",
      showSource: false,
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
  let themeControls = null,
    toastTimer = null;
  function toast(message, error = false) {
    clearTimeout(toastTimer);
    const el = $("toast");
    el.textContent = message;
    el.classList.toggle("error", error);
    el.hidden = false;
    toastTimer = setTimeout(
      () => {
        el.hidden = true;
      },
      error ? 6500 : 3500,
    );
  }
  function unavailable() {
    ready = false;
    document.body.classList.add("gmib-unavailable");
    $("offline-notice").hidden = false;
    $("connection").textContent = "GMIB не запущен";
    $("save").disabled = true;
    themeControls?.refresh();
  }
  let snapshot = null,
    draft = structuredClone(defaults),
    output = null,
    settingsSupported = true,
    sourceSupported = false,
    sourceBound = false,
    saving = false,
    ready = false,
    previewScreenId = null,
    outputLoading = false,
    outputTimer = null,
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
    temperature: "Текущая температура",
    weather: "Погодные условия",
    forecast: "Прогноз",
    metrics: "Метеопоказатели",
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
    let response;
    try {
      response = await fetch(`api/${path}`, {
        method,
        headers:
          body === undefined ? {} : { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
      });
    } catch {
      unavailable();
      throw Error("Запустите GMIB на этом компьютере и повторите попытку.");
    }
    let data;
    try {
      data = await response.json();
    } catch {
      data = null;
    }
    if (!response.ok) throw Error(payloadError(data, response.status));
    return data;
  }
  function expandDateStyle() {
    const options = draft.date.options;
    const styles = {
      full: { weekday: "long", day: "numeric", month: "long", year: "numeric" },
      long: { day: "numeric", month: "long", year: "numeric" },
      medium: { day: "numeric", month: "short", year: "numeric" },
      short: { day: "numeric", month: "numeric", year: "2-digit" },
    };
    if (options.dateStyle) {
      const { dateStyle, ...fields } = options;
      draft.date.options = { ...styles[dateStyle], ...fields };
    }
  }
  function bind() {
    // Older settings used dateStyle; expose its fields in the same selectors.
    expandDateStyle();
    delete draft.date.options.era;
    document.querySelectorAll("[data-path]").forEach((input) => {
      const value = getPath(input.dataset.path);
      if (input.type === "checkbox") input.checked = Boolean(value);
      else input.value = value;
    });
    document.querySelectorAll("[data-date-option]").forEach((input) => {
      const field = input.dataset.dateOption;
      input.value =
        field === "weekday"
          ? draft.date.weekday
            ? draft.date.options.weekday || "long"
            : ""
          : draft.date.options[field] || "";
    });
    $("shadow-value").textContent = draft.appearance.shadow;
    $("dim-value").textContent = `${Math.round(draft.appearance.dim * 100)}%`;
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
    for (const input of document.querySelectorAll("[data-date-option]")) {
      const field = input.dataset.dateOption;
      if (field === "weekday") draft.date.weekday = Boolean(input.value);
      if (input.value) draft.date.options[field] = input.value;
      else delete draft.date.options[field];
    }
    $("dim-value").textContent = `${Math.round(draft.appearance.dim * 100)}%`;
    $("shadow-value").textContent = draft.appearance.shadow;
    validate();
  }
  function validate() {
    if (
      !draft.date.options ||
      typeof draft.date.options !== "object" ||
      Array.isArray(draft.date.options)
    )
      throw Error("Параметры даты должны быть объектом.");
    const allowed = new Set(["dateStyle", "weekday", "year", "month", "day"]);
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
    const previewSnapshot = structuredClone(snapshot);
    const condition = $("preview-weather-select").value;
    if (condition && previewSnapshot) {
      previewSnapshot.weather = { ...previewSnapshot.weather, condition };
    }
    const frame = $("preview-frame");
    frame.contentWindow?.postMessage(
      {
        type: "informer:preview",
        settings: draft,
        snapshot: previewSnapshot,
        source: {
          useLastResponse: sourceSupported
            ? $("use-last-response").checked
            : true,
        },
      },
      location.origin,
    );
  }
  function screenLabel(screen) {
    const dimensions = validDimensions(screen)
      ? `${screen.width} × ${screen.height}`
      : "размер не задан";
    return `${screen.name} · ${dimensions}`;
  }
  function validDimensions(screen) {
    return (
      Number.isFinite(screen?.width) &&
      screen.width > 0 &&
      Number.isFinite(screen?.height) &&
      screen.height > 0
    );
  }
  function syncScreenOptions(select, screens, placeholder = false) {
    const options = screens.map((screen) => [
      String(screen.id),
      screenLabel(screen),
    ]);
    if (placeholder) options.unshift(["", "Выберите экран"]);
    const unchanged =
      select.options.length === options.length &&
      options.every(
        ([value, label], index) =>
          select.options[index].value === value &&
          select.options[index].text === label,
      );
    // Leave native menus untouched during polling when their options did not change.
    if (!unchanged)
      select.replaceChildren(
        ...options.map(([value, label]) => new Option(label, value)),
      );
  }
  function updatePreviewScreens() {
    const screens = output?.screens || [];
    const select = $("preview-screen-select");
    const previous = previewScreenId;
    if (!screens.some((screen) => String(screen.id) === previewScreenId)) {
      const bound = output?.status?.profile?.screenId;
      previewScreenId = String(
        screens.find((screen) => screen.id === bound)?.id ??
          screens[0]?.id ??
          "",
      );
    }
    syncScreenOptions(select, screens);
    if (select.value !== previewScreenId) select.value = previewScreenId;
    $("preview-screen-field").hidden = screens.length <= 1;
    resizePreview();
    if (previous !== previewScreenId) preview();
  }
  function resizePreview() {
    const holder = document.querySelector(".preview-frame");
    const frame = $("preview-frame");
    const screen = output?.screens?.find(
      (s) => String(s.id) === previewScreenId,
    );
    const valid = validDimensions(screen);
    holder.hidden = !valid;
    $("preview-screen-status").hidden = valid;
    $("preview-screen-status").textContent = valid
      ? ""
      : screen
        ? "У выбранного экрана не заданы размеры. Настройте экран в GMIB."
        : "Нет доступных экранов. Добавьте экран в GMIB для предпросмотра.";
    if (!valid) return;
    // Keep the iframe viewport equal to the actual output; scale only its presentation.
    const scale = Math.min(
      1,
      holder.clientWidth / screen.width,
      420 / screen.height,
    );
    holder.style.height = `${screen.height * scale}px`;
    frame.style.width = `${screen.width}px`;
    frame.style.height = `${screen.height}px`;
    frame.style.transform = `scale(${scale})`;
    frame.style.left = `${Math.max(0, (holder.clientWidth - screen.width * scale) / 2)}px`;
  }
  function bindSource() {
    const source = snapshot?.source;
    if (!sourceSupported) return;
    $("latitude").value = source.lat;
    $("longitude").value = source.lon;
    $("daily-limit").value = source.dailyLimit;
    $("use-last-response").checked = source.useLastResponse;
    $("api-key").value = "";
    $("api-key").placeholder = source.hasApiKey
      ? "Ключ сохранён"
      : "Введите ключ API";
    sourceBound = true;
  }
  function readSource() {
    if (!sourceSupported)
      throw Error(
        "Обновите backend Informer и перезапустите GMIB для настройки источника.",
      );
    for (const id of ["latitude", "longitude", "daily-limit"])
      if (!$(id).validity.valid)
        throw Error("Проверьте координаты и суточный лимит запросов.");
    const source = {
      lat: Number($("latitude").value),
      lon: Number($("longitude").value),
      dailyLimit: Number($("daily-limit").value),
      useLastResponse: $("use-last-response").checked,
    };
    const apiKey = $("api-key").value.trim();
    if (apiKey) source.apiKey = apiKey;
    return source;
  }
  function updateCache() {
    const c = snapshot?.cache;
    const date = (value) => {
      if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
      return new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "Europe/Moscow",
      }).format(new Date(value));
    };
    $("cache-status").textContent = !sourceSupported
      ? "Настройки источника недоступны. Перезапустите GMIB после обновления backend Informer."
      : `Режим: ${c?.mode === "frozen" ? "последний ответ" : "автоматическое обновление"}\nСегодня: ${c?.usedToday ?? 0} / ${snapshot.source.dailyLimit}; осталось: ${c?.remaining ?? 0}\nВсего запросов: ${c?.totalRequests ?? 0}\nСледующее обновление: ${date(c?.nextRequestAt)}\nСброс лимита (МСК): ${date(c?.resetAt)}\nПолучен ответ: ${date(c?.fetchedAt)}${c?.message ? `\n${c.message}` : ""}`;
  }
  function updateSnapshot(data, keepDraft = false) {
    if (!data || typeof data !== "object" || !data.settings) return;
    const recovering = document.body.classList.contains("gmib-unavailable");
    document.body.classList.remove("gmib-unavailable");
    $("offline-notice").hidden = true;
    if (recovering) {
      show("");
      themeControls?.reload();
    }
    snapshot = data;
    sourceSupported = Boolean(
      data.source && typeof data.source.useLastResponse === "boolean",
    );
    $("source-notice").hidden = sourceSupported;
    $("source-fields").disabled = !sourceSupported;
    if (!sourceBound || !keepDraft) bindSource();
    settingsSupported =
      ["gradient", "photo"].includes(data.settings.appearance?.backdrop) &&
      ["none", "flip"].includes(data.settings.appearance?.valueAnimation) &&
      typeof data.settings.appearance?.showSource === "boolean" &&
      Boolean(data.settings.styles?.forecast && data.settings.styles?.metrics);
    $("runtime-notice").hidden = settingsSupported;
    $("save").disabled = saving || !ready || !settingsSupported;
    themeControls?.refresh();
    if (!keepDraft) {
      draft = structuredClone(data.settings);
      draft.appearance = { ...defaults.appearance, ...draft.appearance };
      for (const key of ["forecast", "metrics"]) {
        if (!draft.styles[key])
          draft.styles[key] = {
            ...draft.styles.weather,
            size:
              key === "forecast"
                ? draft.styles.weather.size
                : Math.min(
                    160,
                    Math.max(
                      8,
                      Math.round((draft.styles.weather.size * 14) / 18),
                    ),
                  ),
          };
      }
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
      updateSnapshot(data, snapshot !== null);
      await loadOutput();
    } catch (e) {
      if (!document.body.classList.contains("gmib-unavailable"))
        $("connection").textContent = "Не удалось загрузить настройки";
      show(e.message, true);
    }
  }
  async function loadOutput() {
    if (outputLoading || disposed || !ready) return;
    outputLoading = true;
    try {
      const data = await api("output");
      const select = $("screen-select");
      const previousSelection = select.value;
      const firstLoad = output === null;
      output = data;
      const screens = Array.isArray(output?.screens) ? output.screens : [];
      output.screens = screens;
      syncScreenOptions(select, screens, true);
      const status = output.status || {};
      $("output-status").textContent =
        status.message ||
        (status.active ? "Вывод запущен" : "Вывод не запущен");
      const bound = status.profile?.screenId;
      const selected = firstLoad ? String(bound ?? "") : previousSelection;
      const nextSelection = screens.some(
        (screen) => String(screen.id) === selected,
      )
        ? selected
        : "";
      if (select.value !== nextSelection) select.value = nextSelection;
      if (firstLoad)
        $("auto-start").checked = Boolean(status.profile?.autoStart);
      updatePreviewScreens();
    } catch (e) {
      $("output-status").textContent =
        `Состояние вывода недоступно: ${e.message}`;
      if (!output) {
        $("preview-screen-status").hidden = false;
        $("preview-screen-status").textContent =
          `Экраны недоступны: ${e.message}`;
      }
    } finally {
      outputLoading = false;
    }
  }
  async function action(path, method, body, done) {
    try {
      show("Выполняется…");
      const data = await api(path, method, body);
      if (
        path === "settings" &&
        (data?.settings?.appearance?.backdrop !== body.appearance.backdrop ||
          data?.settings?.appearance?.valueAnimation !==
            body.appearance.valueAnimation ||
          data?.settings?.appearance?.showSource !==
            body.appearance.showSource ||
          ["forecast", "metrics"].some((key) =>
            ["font", "size", "color"].some(
              (field) =>
                data?.settings?.styles?.[key]?.[field] !==
                body.styles[key][field],
            ),
          ))
      ) {
        $("runtime-notice").hidden = false;
        settingsSupported = false;
        $("save").disabled = true;
        throw Error(
          "Backend не сохранил новые параметры. Перезапустите GMIB и обновите страницу.",
        );
      }
      if (
        path === "settings" &&
        (!data?.source ||
          ["lat", "lon", "dailyLimit", "useLastResponse"].some(
            (key) => data.source[key] !== body.weatherSource[key],
          ) ||
          (body.weatherSource.apiKey && !data.source.hasApiKey))
      )
        throw Error(
          "Backend не сохранил источник погоды. Перезапустите GMIB и обновите страницу.",
        );
      if (data?.settings) updateSnapshot(data, path !== "settings");
      else await loadOutput();
      show(done);
    } catch (e) {
      show(e.message, true);
      throw e;
    }
  }
  document
    .querySelectorAll("[data-path],[data-date-option]")
    .forEach((input) => input.addEventListener("input", preview));
  $("save").addEventListener("click", async () => {
    if (saving || !ready) return;
    saving = true;
    $("save").disabled = true;
    $("save").textContent = "Применение…";
    try {
      if (!settingsSupported)
        throw Error(
          "Перезапустите GMIB, чтобы сохранять новые настройки Informer.",
        );
      readDraft();
      await action(
        "settings",
        "PUT",
        { ...draft, weatherSource: readSource() },
        "Настройки применены",
      );
      toast("Настройки применены");
    } catch (e) {
      if (!$("feedback").textContent.includes(e.message)) show(e.message, true);
      toast(e.message, true);
    } finally {
      saving = false;
      $("save").textContent = "Применить";
      $("save").disabled = !ready || !settingsSupported;
    }
  });
  $("use-last-response").addEventListener("change", preview);
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
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  function activateTab(tab, focus = false, updateHash = true) {
    for (const candidate of tabs) {
      const selected = candidate === tab;
      candidate.setAttribute("aria-selected", String(selected));
      candidate.tabIndex = selected ? 0 : -1;
      $(candidate.getAttribute("aria-controls")).hidden = !selected;
    }
    if (focus) tab.focus();
    const hash = `#${tab.getAttribute("aria-controls")}`;
    if (updateHash && location.hash !== hash) history.pushState(null, "", hash);
  }
  function activateHashTab() {
    const tab = tabs.find(
      (candidate) =>
        `#${candidate.getAttribute("aria-controls")}` === location.hash,
    );
    activateTab(tab || tabs[0], false, false);
  }
  activateHashTab();
  addEventListener("hashchange", activateHashTab);
  const narrowNavigation = matchMedia("(max-width: 700px)");
  function updateTabOrientation() {
    document
      .querySelector('[role="tablist"]')
      .setAttribute(
        "aria-orientation",
        narrowNavigation.matches ? "horizontal" : "vertical",
      );
  }
  updateTabOrientation();
  narrowNavigation.addEventListener("change", updateTabOrientation);
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activateTab(tab));
    tab.addEventListener("keydown", (event) => {
      let next;
      if (["ArrowDown", "ArrowRight"].includes(event.key))
        next = (index + 1) % tabs.length;
      if (["ArrowUp", "ArrowLeft"].includes(event.key))
        next = (index - 1 + tabs.length) % tabs.length;
      if (event.key === "Home") next = 0;
      if (event.key === "End") next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault();
      activateTab(tabs[next], true);
    });
  });
  $("preview-screen-select").addEventListener("change", (event) => {
    previewScreenId = event.target.value;
    resizePreview();
    preview();
  });
  $("preview-weather-select").addEventListener("change", preview);
  $("preview-frame").addEventListener("load", preview);
  const previewObserver = new ResizeObserver(resizePreview);
  previewObserver.observe(document.querySelector(".preview"));
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
        if (!document.body.classList.contains("gmib-unavailable"))
          $("connection").textContent = "Восстанавливаем связь…";
        load();
        reconnect = setTimeout(connect, 3000);
      });
    } catch {
      reconnect = setTimeout(connect, 5000);
    }
  }
  addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(toastTimer);
    clearTimeout(reconnect);
    clearInterval(outputTimer);
    previewObserver.disconnect();
    removeEventListener("hashchange", activateHashTab);
    narrowNavigation.removeEventListener("change", updateTabOrientation);
    ws?.close();
  });
  themeControls = InformerThemes.init({
    canUse: () => ready && settingsSupported,
    api,
    show,
    getDraft() {
      if (!ready) throw Error("Дождитесь загрузки настроек.");
      if (!settingsSupported)
        throw Error("Обновите backend Informer и перезапустите GMIB.");
      readDraft();
      return structuredClone(draft);
    },
    setDraft(settings) {
      if (!ready || !settingsSupported)
        throw Error("Дождитесь загрузки совместимых настроек Informer.");
      draft = structuredClone(settings);
      bind();
      preview();
    },
  });
  $("retry-connection").addEventListener("click", load);
  outputTimer = setInterval(loadOutput, 5000);
  load();
  connect();
})();
