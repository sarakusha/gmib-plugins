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
      sourceSize: 16,
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
    outputBusy = false,
    outputBound = false,
    outputRevision = 0,
    outputCommandGeneration = 0,
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
      previewSnapshot.weather = {
        ...previewSnapshot.weather,
        condition,
        iconUrl: "",
      };
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
  const keyRows = [];
  function opaqueKeyId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), (value) =>
      value.toString(16).padStart(2, "0"),
    ).join("");
  }
  function addKeyRow(key = {}, binding = false) {
    if (keyRows.length >= 10) return;
    const id = key.id || opaqueKeyId();
    const row = document.createElement("fieldset");
    row.className = "weather-key";
    const prefix = `weather-key-${opaqueKeyId()}`;
    // Only static markup is interpolated. Saved labels and ids stay in DOM values.
    row.innerHTML = `<legend>Ключ API</legend>
      <label for="${prefix}-name">Название (необязательно)</label>
      <input id="${prefix}-name" type="text" maxlength="80" autocomplete="off">
      <label for="${prefix}-secret">Ключ API</label>
      <input id="${prefix}-secret" type="password" autocomplete="new-password" aria-describedby="${prefix}-hint">
      <p id="${prefix}-hint" class="hint">Пустое поле сохраняет заданный ключ.</p>
      <div class="weather-key-options">
        <label>Тип API<select id="${prefix}-type"><option value="auto">Автоматически</option><option value="home">Умный дом</option><option value="site">Для сайта</option></select></label>
        <label>Лимит в сутки<input id="${prefix}-limit" type="number" min="1" max="10000" step="1" required></label>
      </div>
      <p id="${prefix}-status" class="weather-key-status" role="status"></p>
      <button type="button">Удалить ключ</button>`;
    const entry = {
      id,
      row,
      name: row.querySelector(`#${prefix}-name`),
      secret: row.querySelector(`#${prefix}-secret`),
      type: row.querySelector("select"),
      limit: row.querySelector('input[type="number"]'),
      status: row.querySelector(".weather-key-status"),
      customizedLimit: Boolean(key.id),
      hasApiKey: Boolean(key.hasApiKey),
    };
    entry.name.value = key.name || "";
    entry.type.value = key.type || "auto";
    entry.limit.value = key.dailyLimit ?? 30;
    entry.secret.placeholder = key.hasApiKey
      ? "Ключ сохранён"
      : "Введите ключ API";
    entry.limit.addEventListener("input", () => {
      entry.customizedLimit = true;
      updateKeyStatus(entry, entry.latestStatus);
      updateSourceGuard();
    });
    entry.type.addEventListener("change", () => {
      if (!entry.customizedLimit)
        entry.limit.value = entry.type.value === "site" ? 50 : 30;
      updateKeyStatus(entry, entry.latestStatus);
      updateSourceGuard();
    });
    entry.secret.addEventListener("input", () => {
      updateKeyStatus(entry, entry.latestStatus);
      updateSourceGuard();
    });
    row.querySelector("button").addEventListener("click", () => {
      const index = keyRows.indexOf(entry);
      keyRows.splice(index, 1);
      row.remove();
      $("add-weather-key").disabled = keyRows.length >= 10;
      updateSourceGuard();
    });
    keyRows.push(entry);
    $("weather-keys").append(row);
    $("add-weather-key").disabled = keyRows.length >= 10;
    updateKeyStatus(entry, key);
    if (!binding) updateSourceGuard();
    return entry;
  }
  function keyCredentialState(entry) {
    const secret = entry.secret.value.trim();
    const malformed =
      Boolean(secret) && !/^[a-zA-Z0-9_-]{16,200}$/.test(secret);
    const rejected = !secret && Boolean(entry.latestStatus?.invalid);
    return {
      malformed,
      rejected,
      usable: !malformed && (Boolean(secret) || entry.hasApiKey),
    };
  }
  function normalizedPageUrl(value) {
    if (!value.trim()) return "";
    try {
      const url = new URL(value.trim());
      if (
        url.protocol !== "https:" ||
        !["yandex.ru", "www.yandex.ru"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        !/^\/pogoda\/(?:ru\/)?[a-z0-9]+(?:-[a-z0-9]+)*\/?$/.test(url.pathname)
      )
        return null;
      return `${url.origin}${url.pathname}`;
    } catch {
      return null;
    }
  }
  function updatePageValidation() {
    const input = $("page-url");
    const normalized = normalizedPageUrl(input.value);
    const invalid =
      normalized === null || ($("page-enabled").checked && !normalized);
    input.setCustomValidity(
      invalid
        ? "Укажите HTTPS-адрес страницы города на yandex.ru/pogoda без имени пользователя и пароля."
        : "",
    );
    input.setAttribute("aria-invalid", String(invalid));
    return !invalid;
  }
  function updateSourceGuard(showPreview = true) {
    const input = $("use-last-response");
    const pageUsable =
      $("page-enabled").checked &&
      Boolean(normalizedPageUrl($("page-url").value));
    const disabled =
      !pageUsable && !keyRows.some((entry) => keyCredentialState(entry).usable);
    const changed = disabled && !input.checked;
    input.disabled = disabled;
    if (disabled) input.checked = true;
    if (changed && showPreview) preview();
  }
  function updateKeyStatus(entry, key) {
    entry.latestStatus = key;
    const credential = keyCredentialState(entry);
    entry.row.classList.toggle(
      "weather-key-invalid",
      credential.malformed || credential.rejected,
    );
    entry.secret.setAttribute(
      "aria-invalid",
      String(credential.malformed || credential.rejected),
    );
    entry.secret.setCustomValidity(
      credential.malformed
        ? "Ключ должен содержать 16–200 латинских букв, цифр, _ или -."
        : "",
    );
    const invalidHint = credential.malformed
      ? "Неверный формат ключа: 16–200 латинских букв, цифр, _ или -.\n"
      : credential.rejected
        ? "Ключ не принят API. Замените или удалите его.\n"
        : "";
    const types = { home: "Умный дом", site: "Для сайта" };
    const detected =
      entry.type.value === key?.type && !entry.secret.value.trim()
        ? types[key?.detectedType]
        : null;
    const limit = Number(entry.limit.value);
    const assumed = limit === 30 ? "home" : limit === 50 ? "site" : null;
    const apiStatus = detected
      ? `Подтверждённый API: ${detected}`
      : entry.type.value !== "auto"
        ? `Выбранный API: ${types[entry.type.value]}`
        : assumed
          ? `Предположительно: ${types[assumed]}. Подтверждение после успешного запроса.`
          : "API: автоматически; подтверждение после успешного запроса.";
    if (!key?.id) {
      entry.status.textContent = `${invalidHint}${apiStatus}\nНовый ключ: статистика появится после применения.`;
      return;
    }
    entry.status.textContent = `${invalidHint}Сегодня (квота): ${key.usedToday ?? 0} / ${key.dailyLimit}; остаток квоты: ${key.remaining ?? 0}\nВсего попыток запроса: ${key.totalRequests ?? 0}\n${apiStatus}${key.lastStatus ? `\nСтатус: ${key.lastStatus}` : ""}${key.blockedUntil ? `\nЗаблокирован до: ${sourceDate(key.blockedUntil)}` : ""}${key.message ? `\n${key.message}` : ""}`;
  }
  function bindSource() {
    const source = snapshot?.source;
    if (!sourceSupported) return;
    $("page-enabled").checked = source.page.enabled;
    $("page-url").value = source.page.url;
    $("page-interval").value = source.page.intervalMinutes;
    updatePageValidation();
    $("latitude").value = source.lat;
    $("longitude").value = source.lon;
    $("use-last-response").checked = source.useLastResponse;
    keyRows.length = 0;
    $("weather-keys").replaceChildren();
    for (const key of source.keys) addKeyRow(key, true);
    $("add-weather-key").disabled = keyRows.length >= 10;
    sourceBound = true;
    updateSourceGuard(false);
  }
  function sourceInputValid(input) {
    const valid = input.validity.valid;
    input.setAttribute("aria-invalid", String(!valid));
    if (!valid) {
      input.reportValidity();
      input.focus();
    }
    return valid;
  }
  function readSource() {
    if (!sourceSupported)
      throw Error(
        "Обновите backend Informer и перезапустите GMIB для настройки источника.",
      );
    updatePageValidation();
    if (
      !sourceInputValid($("page-url")) ||
      !sourceInputValid($("page-interval"))
    )
      throw Error(
        "Проверьте адрес страницы Яндекса и интервал (5–1440 минут).",
      );
    for (const id of ["latitude", "longitude"])
      if (!sourceInputValid($(id)))
        throw Error("Проверьте координаты источника погоды.");
    return {
      page: {
        enabled: $("page-enabled").checked,
        url: normalizedPageUrl($("page-url").value),
        intervalMinutes: Number($("page-interval").value),
      },
      lat: Number($("latitude").value),
      lon: Number($("longitude").value),
      useLastResponse: $("use-last-response").checked,
      keys: keyRows.map((entry, index) => {
        if (!sourceInputValid(entry.secret))
          throw Error(`Проверьте формат ключа № ${index + 1}.`);
        if (!sourceInputValid(entry.limit))
          throw Error(
            `Проверьте суточный лимит ключа № ${index + 1} (1–10000).`,
          );
        const key = {
          id: entry.id,
          name: entry.name.value.trim(),
          type: entry.type.value,
          dailyLimit: Number(entry.limit.value),
        };
        const secret = entry.secret.value.trim();
        if (secret) key.apiKey = secret;
        return key;
      }),
    };
  }
  function sourceDate(value) {
    if (!value || !Number.isFinite(new Date(value).getTime())) return "—";
    return new Intl.DateTimeFormat("ru-RU", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Europe/Moscow",
    }).format(new Date(value));
  }
  function updateCache() {
    const c = snapshot?.cache;
    for (const entry of keyRows) {
      const key = snapshot?.source?.keys?.find(
        (candidate) => candidate.id === entry.id,
      );
      updateKeyStatus(entry, key);
    }
    updateSourceGuard();
    const page = c?.page;
    $("page-resume").hidden =
      !sourceSupported || !(page?.suspended || page?.formatChanged);
    $("page-status").textContent = !sourceSupported
      ? "Обновите backend для настройки страницы Яндекса."
      : `Страница Яндекса: ${page?.suspended ? "приостановлена" : snapshot.source.page.enabled ? "включена" : "выключена"}\nОбновлений сегодня: ${page?.requestsToday ?? 0}; всего: ${page?.totalRequests ?? 0}${page?.mode === "background" ? "\nЛёгкое обновление" : ""}${page?.formatChanged ? "\nФормат страницы изменился — проверка раз в сутки" : ""}\nСледующее обновление страницы: ${sourceDate(page?.nextRequestAt)}\n${page?.retryAt ? `Повтор после: ${sourceDate(page.retryAt)}\n` : ""}Последняя попытка: ${sourceDate(page?.lastAttemptAt)}\nПоследний успешный ответ: ${sourceDate(page?.fetchedAt)}${page?.lastStatus ? `\nСтатус: ${page.lastStatus}` : ""}${page?.message ? `\n${page.message}` : ""}`;
    $("cache-status").textContent = !sourceSupported
      ? "Настройки источника недоступны. Перезапустите GMIB после обновления backend Informer."
      : `Режим: ${c?.mode === "frozen" ? "последний ответ" : "автоматическое обновление"}\nСегодня (квота): ${c?.usedToday ?? 0} / ${snapshot.source.dailyLimit}\nДоступный пул: ${c?.remaining ?? 0}\nВсего попыток запроса: ${c?.totalRequests ?? 0}\nСледующее обновление: ${sourceDate(c?.nextRequestAt)}\nСброс лимита (МСК): ${sourceDate(c?.resetAt)}\nПолучен ответ: ${sourceDate(c?.fetchedAt)}${c?.message ? `\n${c.message}` : ""}`;
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
      data.source &&
      typeof data.source.useLastResponse === "boolean" &&
      Array.isArray(data.source.keys) &&
      typeof data.source.page?.enabled === "boolean" &&
      typeof data.source.page.url === "string" &&
      Number.isInteger(data.source.page.intervalMinutes),
    );
    $("source-notice").hidden = sourceSupported;
    $("source-fields").disabled = !sourceSupported;
    if (!sourceBound) bindSource();
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
  function selectedOutputScreen(id) {
    const value = $(id).value;
    return output?.screens?.find((screen) => String(screen.id) === value);
  }
  function updateOutputControls() {
    const supported = output?.features?.playerControl === true;
    const wide = selectedOutputScreen("wide-screen-select");
    const compact = selectedOutputScreen("compact-screen-select");
    const current = $("output-mode").value === "compact" ? compact : wide;
    const unavailable = outputBusy || !ready || !outputBound;
    $("start-output").disabled = unavailable || !current;
    $("stop-output").disabled = unavailable;
    $("toggle-output").disabled =
      unavailable || !wide || !compact || wide.id === compact.id;
    $("player-enabled").disabled = !supported;
    $("player-select").disabled = !supported || !$("player-enabled").checked;
    $("player-control-notice").hidden = !outputBound || supported;
  }
  function syncOutputSelection(select, items, value, placeholder, label) {
    const options = [
      ["", placeholder],
      ...items.map((item) => [String(item.id), label(item)]),
    ];
    if (value && !options.some(([id]) => id === value))
      options.push([value, `Недоступен (ID: ${value})`]);
    if (
      select.options.length !== options.length ||
      options.some(
        ([id, text], index) =>
          select.options[index].value !== id ||
          select.options[index].text !== text,
      )
    )
      select.replaceChildren(
        ...options.map(([id, text]) => new Option(text, id)),
      );
    select.value = value;
  }
  function renderOutput(data, bindConfig = false) {
    output = {
      ...data,
      screens: Array.isArray(data?.screens) ? data.screens : [],
    };
    const config = data?.config;
    const bind = config && (!outputBound || bindConfig);
    for (const [id, key] of [
      ["wide-screen-select", "wideScreenId"],
      ["compact-screen-select", "compactScreenId"],
    ]) {
      const value = bind ? String(config[key] ?? "") : $(id).value;
      syncOutputSelection(
        $(id),
        output.screens,
        value,
        "Выберите экран",
        screenLabel,
      );
    }
    syncOutputSelection(
      $("player-select"),
      Array.isArray(data?.players) ? data.players : [],
      bind ? String(config.playerId ?? "") : $("player-select").value,
      "Выберите плеер",
      (player) => `${player.name}${player.playing ? " · воспроизводится" : ""}`,
    );
    if (bind) {
      $("output-mode").value = config.mode === "compact" ? "compact" : "wide";
      $("auto-start").checked = config.autoStart === true;
      $("player-enabled").checked = config.playerEnabled === true;
      outputBound = true;
    }
    if (output.features?.playerControl !== true)
      $("player-enabled").checked = false;
    const status = output.status || {};
    $("output-status").textContent = [
      status.message || (status.active ? "Вывод запущен" : "Вывод не запущен"),
      data?.message,
    ]
      .filter(Boolean)
      .join("\n");
    updateOutputControls();
    updatePreviewScreens();
  }
  async function loadOutput() {
    if (outputLoading || outputBusy || disposed || !ready) return;
    outputLoading = true;
    const generation = outputCommandGeneration;
    try {
      const data = await api("output");
      // A command may have started while this poll was in flight.
      if (!outputBusy && generation === outputCommandGeneration)
        renderOutput(data);
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
      updateOutputControls();
    }
  }
  function readOutputConfig(command) {
    const wideScreenId = selectedOutputScreen("wide-screen-select")?.id ?? null;
    const compactScreenId =
      selectedOutputScreen("compact-screen-select")?.id ?? null;
    const mode = $("output-mode").value;
    if (
      !(mode === "compact" ? compactScreenId !== null : wideScreenId !== null)
    )
      throw Error("Выберите экран для текущего режима.");
    if (
      command === "toggle" &&
      (wideScreenId === null ||
        compactScreenId === null ||
        wideScreenId === compactScreenId)
    )
      throw Error("Для переключения выберите два разных экрана.");
    const playerEnabled =
      output?.features?.playerControl === true && $("player-enabled").checked;
    const player = output?.players?.find(
      (candidate) => String(candidate.id) === $("player-select").value,
    );
    if (playerEnabled && !player) throw Error("Выберите доступный плеер.");
    return {
      wideScreenId,
      compactScreenId,
      mode,
      autoStart: $("auto-start").checked,
      playerEnabled,
      playerId: player?.id ?? null,
    };
  }
  async function commandOutput(command) {
    if (outputBusy || !ready || !outputBound) return;
    outputBusy = true;
    outputCommandGeneration += 1;
    const revision = outputRevision;
    updateOutputControls();
    $("output-error").hidden = true;
    try {
      let config;
      try {
        config = readOutputConfig(command);
      } catch (error) {
        if (command !== "hide") throw error;
      }
      const data = await api("output", "PUT", {
        command,
        ...(config ? { config } : {}),
      });
      renderOutput(data, revision === outputRevision);
      if (typeof data?.status?.active !== "boolean")
        throw Error(
          "GMIB не подтвердил состояние вывода. Обновите состояние и повторите попытку.",
        );
      if (command !== "hide" && !data.status.active)
        throw Error(
          data.status.message || data.message || "GMIB не запустил вывод.",
        );
      if (command === "hide" && data.status.active)
        throw Error(
          data.status.message || data.message || "GMIB не скрыл вывод.",
        );
      const mode = data.config?.mode === "compact" ? "компактный" : "широкий";
      const message = data.status.active
        ? `Показан ${mode} режим.`
        : "Вывод скрыт.";
      show(message);
      toast(message);
    } catch (e) {
      $("output-error").textContent = e.message;
      $("output-error").hidden = false;
      show(e.message, true);
      toast(e.message, true);
    } finally {
      outputBusy = false;
      updateOutputControls();
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
        (!Array.isArray(data?.source?.keys) ||
          !data.source.page ||
          ["enabled", "intervalMinutes", "url"].some(
            (key) => data.source.page[key] !== body.weatherSource.page[key],
          ) ||
          ["lat", "lon", "useLastResponse"].some(
            (key) => data.source[key] !== body.weatherSource[key],
          ) ||
          data.source.keys.length !== body.weatherSource.keys.length ||
          body.weatherSource.keys.some((submitted) => {
            const saved = data.source.keys.find(
              (key) => key.id === submitted.id,
            );
            return (
              !saved ||
              ["name", "type", "dailyLimit"].some(
                (field) => saved[field] !== submitted[field],
              ) ||
              (Boolean(submitted.apiKey) && !saved.hasApiKey)
            );
          }))
      )
        throw Error(
          "Backend не сохранил источник погоды. Перезапустите GMIB и обновите страницу.",
        );
      if (data?.settings) {
        updateSnapshot(data, path !== "settings");
        if (path === "settings") bindSource();
      } else await loadOutput();
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
  $("page-resume").addEventListener("click", async () => {
    $("page-resume").disabled = true;
    try {
      await action(
        "weather/page/resume",
        "POST",
        {},
        "Обновление страницы возобновлено",
      );
      toast("Обновление страницы возобновлено");
    } catch (e) {
      toast(e.message, true);
    } finally {
      $("page-resume").disabled = false;
    }
  });
  $("add-weather-key").addEventListener("click", () => {
    addKeyRow()?.name.focus();
  });
  for (const id of ["page-enabled", "page-url", "page-interval"]) {
    $(id).addEventListener("input", () => {
      updatePageValidation();
      updateSourceGuard();
      preview();
    });
  }
  $("use-last-response").addEventListener("change", () => {
    updateSourceGuard();
    preview();
  });
  for (const id of [
    "wide-screen-select",
    "compact-screen-select",
    "output-mode",
    "auto-start",
    "player-enabled",
    "player-select",
  ]) {
    $(id).addEventListener("change", () => {
      outputRevision += 1;
      updateOutputControls();
    });
  }
  $("start-output").addEventListener("click", () => commandOutput("show"));
  $("stop-output").addEventListener("click", () => commandOutput("hide"));
  $("toggle-output").addEventListener("click", () => commandOutput("toggle"));
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
