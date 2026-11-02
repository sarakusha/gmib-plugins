(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  let snapshot = null,
    online = false,
    busy = false,
    loading = false,
    disposed = false;
  let editing = null,
    timer = null,
    toastTimer = null;
  const eventNames = {
    time: "Время",
    dawn: "Рассвет",
    sunrise: "Восход",
    sunriseEnd: "Утро",
    goldenHourEnd: "День",
    solarNoon: "Зенит",
    goldenHour: "Вечер",
    sunsetStart: "Закат",
    sunset: "Сумерки",
    dusk: "Ночь",
    nadir: "Надир",
    day: "День",
    night: "Ночь",
  };
  function el(tag, text, className) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  }
  function toast(message, error = false) {
    clearTimeout(toastTimer);
    $("toast").textContent = message;
    $("toast").classList.toggle("error", error);
    $("toast").hidden = false;
    toastTimer = setTimeout(() => {
      $("toast").hidden = true;
    }, 5000);
  }
  async function api(path, method = "GET", body) {
    const response = await fetch(`api/${path}`, {
      method,
      cache: "no-store",
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(12000),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(data.error || `Ошибка запроса (${response.status})`);
    return data;
  }
  function setConnection(value, error) {
    online = value;
    $("connection").textContent = value
      ? busy ? "Выполнение команды…" : "Связь с GMIB"
      : "Нет связи с GMIB";
    $("channels").setAttribute("aria-busy", String(busy));
    $("device-count").textContent = value && snapshot
      ? `Найдено реле: ${snapshot.devices.filter(device => device.connected).length}`
      : "Найдено реле: — (нет связи)";
    $("notice").hidden = value;
    $("notice").textContent =
      error || "Нет связи. Показаны последние данные; управление недоступно.";
    ["mode", "add-job", "add-rule", "save-editor"].forEach((id) => {
      $(id).disabled = !value || busy;
    });
    document.querySelectorAll("[data-write]").forEach((button) => {
      button.disabled = !value || busy || button.dataset.unavailable === "true";
    });
  }
  async function refresh(force = false) {
    if (loading || disposed || (busy && force !== true)) return;
    loading = true;
    try {
      snapshot = await api("state");
      render();
      setConnection(true);
    } catch (error) {
      setConnection(
        false,
        `Нет связи: ${error.message}. Управление заблокировано до обновления.`,
      );
    } finally {
      loading = false;
    }
  }
  async function mutate(path, method, body) {
    if (!online || busy)
      throw new Error("Дождитесь восстановления связи с GMIB");
    busy = true;
    setConnection(online);
    try {
      while (loading) await new Promise((resolve) => setTimeout(resolve, 25));
      await api(path, method, body);
    } finally {
      await refresh(true);
      busy = false;
      setConnection(online);
    }
  }
  /* mutation always re-reads the server, including partial group failures */

  function button(text, handler) {
    const node = el("button", text);
    node.type = "button";
    node.dataset.write = "";
    node.addEventListener("click", () =>
      Promise.resolve()
        .then(handler)
        .catch((error) => toast(error.message, true)),
    );
    node.disabled = !online || busy;
    return node;
  }
  function option(value, text) {
    const node = el("option", text);
    node.value = value;
    return node;
  }
  function deviceName(id) {
    return id === "all"
      ? "Все устройства"
      : snapshot?.devices.find((device) => device.id === id)?.name || id;
  }
  function selectedDevices() {
    return snapshot.devices.filter((device) =>
      snapshot.mode === "group"
        ? device.connected
        : device.id === $("device").value,
    );
  }
  function dateTime(value) {
    if (!value) return "—";
    try {
      return new Intl.DateTimeFormat("ru-RU", {
        timeZone: snapshot?.environment?.timeZone,
        day: "2-digit",
        month: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      }).format(new Date(value));
    } catch {
      return "—";
    }
  }
  function actionsText(outputs) {
    return Object.entries(outputs || {})
      .map(([key, value]) => `${key}: ${value ? "вкл" : "выкл"}`)
      .join(" · ");
  }
  function render() {
    if (!snapshot) return;
    const selected = $("device").value,
      filter = $("log-device").value;
    $("mode").value = snapshot.mode;
    $("device").replaceChildren(
      ...snapshot.devices.map((device) =>
        option(
          device.id,
          `${device.name}${device.connected ? "" : " · не подключено"}`,
        ),
      ),
    );
    if (!snapshot.devices.length)
      $("device").append(option("", "Нет подключённых устройств"));
    if (snapshot.mode === "group") {
      $("device").prepend(option("all", "Все реле"));
      $("device").value = "all";
    }
    if (
      snapshot.mode !== "group" &&
      snapshot.devices.some((device) => device.id === selected)
    )
      $("device").value = selected;
    $("device").disabled =
      snapshot.mode === "group" || !snapshot.devices.length;
    $("log-device").replaceChildren(
      option("", "Все устройства"),
      ...snapshot.devices.map((device) => option(device.id, device.name)),
    );
    if ([...$("log-device").options].some((o) => o.value === filter))
      $("log-device").value = filter;
    const environment = snapshot.environment || {};
    $("environment").textContent =
      `${environment.timeZone || "Часовой пояс GMIB не задан"}${environment.sensors?.length ? ` · ${environment.sensors.length} датч.` : " · Нет датчиков освещённости"}`;
    renderChannels();
    renderAutomation();
    renderLogs();
    $("updated").textContent =
      `Обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
    $("job-count").textContent =
      snapshot.jobs.length + snapshot.rules.length || "";
  }
  function renderChannels() {
    const devices = selectedDevices();
    $("device-summary").textContent =
      snapshot.mode === "group"
        ? `Совместное управление · подключено ${devices.filter((d) => d.connected).length} из ${devices.length}`
        : deviceName($("device").value);
    const root = $("channels");
    root.replaceChildren();
    if (!devices.length) {
      root.append(
        el(
          "div",
          "Подключите KeUSB-24R к компьютеру с GMIB. Устройство появится здесь автоматически.",
          "empty",
        ),
      );
      return;
    }
    for (let i = 0; i < 4; i++) {
      const values = devices.map((d) => (d.connected ? d.outputs[i] : null));
      const known = values.every((value) => typeof value === "boolean");
      const on = known && values.every(Boolean),
        off = known && values.every((value) => !value);
      const state = !known
        ? "Нет данных"
        : on
          ? "Включён"
          : off
            ? "Выключен"
            : "Разные";
      const row = el("div", undefined, "channel");
      row.append(
        el("span", String(i + 1).padStart(2, "0"), "channel-number"),
        el("span", `Выход ${i + 1}`, "channel-title"),
        el("span", state, `channel-state${on ? " on" : ""}`),
      );
      const toggle = button("", async () => {
        await mutate("outputs", "POST", {
          target: snapshot.mode === "group" ? "all" : $("device").value,
          outputs: { [i + 1]: !on },
        });
        toast("Команда выполнена. Состояние обновлено.");
      });
      toggle.className = "toggle";
      toggle.setAttribute("role", "checkbox");
      toggle.setAttribute(
        "aria-checked",
        known ? (on ? "true" : off ? "false" : "mixed") : "false",
      );
      toggle.setAttribute(
        "aria-label",
        `${on ? "Выключить" : "Включить"} выход ${i + 1}`,
      );
      toggle.dataset.unavailable = String(!known);
      toggle.disabled = !known || !online || busy;
      row.append(toggle);
      root.append(row);
    }
  }
  function renderAutomation() {
    for (const [kind, collection] of [
      ["job", snapshot.jobs],
      ["rule", snapshot.rules],
    ]) {
      const root = $(kind === "job" ? "jobs" : "rules");
      root.replaceChildren();
      if (!collection.length)
        root.append(
          el(
            "div",
            kind === "job"
              ? "Заданий пока нет. Добавьте время включения или выключения света."
              : "Условий пока нет. Свет можно включать при снижении освещённости.",
            "empty",
          ),
        );
      for (const item of collection) {
        const row = el(
            "div",
            undefined,
            `item${item.enabled ? "" : " paused"}`,
          ),
          main = el("div", undefined, "item-main");
        main.append(
          el(
            "div",
            `${item.name}${item.enabled ? "" : " · приостановлено"}`,
            "item-title",
          ),
        );
        const condition =
          kind === "job"
            ? `${item.kind === "daily" ? "Ежедневно" : item.date || "Один раз"} · ${item.event === "time" ? item.time : `${eventNames[item.event]} ${item.offsetMinutes >= 0 ? "+" : "−"}${Math.abs(item.offsetMinutes)} мин`}`
            : `${snapshot.environment?.sensors?.find((sensor) => sensor.id === item.sensorId)?.name || item.sensorId} · ${item.operator === "between" ? `${item.min}–${item.max}` : `${item.operator === "lt" ? "<" : ">"} ${item.operator === "lt" ? item.max : item.min}`} лк`;
        main.append(
          el(
            "div",
            `${deviceName(item.target)} · ${condition}\n${actionsText(item.outputs)}`,
            "item-detail",
          ),
        );
        const tools = el("div", undefined, "item-actions");
        tools.append(
          button(item.enabled ? "Пауза" : "Включить", () =>
            mutate(kind === "job" ? "jobs" : "rules", "PUT", {
              [kind]: { ...item, enabled: !item.enabled },
            }),
          ),
          button("Изменить", () => openEditor(kind, item)),
          button("Удалить", async () => {
            if (confirm(`Удалить «${item.name}»?`))
              await mutate(kind === "job" ? "jobs" : "rules", "DELETE", {
                id: item.id,
              });
          }),
        );
        row.append(main, tools);
        root.append(row);
      }
    }
  }
  function renderLogs() {
    const root = $("logs");
    root.replaceChildren();
    const logs = (snapshot?.logs || [])
      .filter(
        (log) =>
          !$("log-device").value || log.deviceId === $("log-device").value,
      )
      .slice()
      .sort((a, b) => new Date(b.at) - new Date(a.at));
    if (!logs.length)
      root.append(el("div", "Изменений за этот период нет.", "empty"));
    for (const log of logs) {
      const row = el("div", undefined, "log"),
        time = el("time", dateTime(log.at));
      time.dateTime = new Date(log.at).toISOString();
      row.append(
        time,
        el(
          "span",
          `${deviceName(log.deviceId)} · ${log.message || actionsText(log.outputs)}${log.source ? ` · ${log.source}` : ""}`,
        ),
      );
      root.append(row);
    }
  }
  function updateEditor() {
    $("date-field").hidden = $("edit-repeat").value !== "once";
    $("edit-date").required =
      editing?.kind === "job" && $("edit-repeat").value === "once";
    $("time-field").hidden = $("edit-event").value !== "time";
    $("edit-time").required =
      editing?.kind === "job" && $("edit-event").value === "time";
    $("offset-field").hidden = $("edit-event").value === "time";
    $("max-field").hidden = $("edit-comparison").value !== "between";
    $("threshold-label").textContent =
      $("edit-comparison").value === "between" ? "От, лк" : "Порог, лк";
  }
  function openEditor(kind, item = {}) {
    editing = { kind, id: item.id };
    $("editor-title").textContent =
      `${item.id ? "Изменить" : "Добавить"} ${kind === "job" ? "задание" : "условие"}`;
    $("edit-name").value = item.name || "";
    $("edit-enabled").checked = item.enabled !== false;
    $("edit-target").replaceChildren(
      option("all", "Все устройства"),
      ...snapshot.devices.map((d) => option(d.id, d.name)),
    );
    if (
      item.target &&
      ![...$("edit-target").options].some((o) => o.value === item.target)
    )
      $("edit-target").append(
        option(item.target, `${item.target} · не подключено`),
      );
    $("edit-target").value =
      item.target ||
      (snapshot.mode === "group" ? "all" : $("device").value || "all");
    $("schedule-fields").hidden = kind !== "job";
    $("lux-fields").hidden = kind !== "rule";
    $("edit-repeat").value = item.kind || "daily";
    $("edit-date").value = item.date || "";
    const solar = snapshot.environment?.solar || {};
    for (const opt of [...$("edit-event").options]) {
      if (opt.dataset.legacy) opt.remove();
      else opt.disabled = opt.value !== "time" && solar[opt.value] === undefined;
    }
    const mappedEvent = ({ day: "goldenHourEnd", night: "dusk" })[item.event];
    if (mappedEvent && solar[mappedEvent] === undefined) {
      const legacy = option(item.event, eventNames[item.event]);
      legacy.dataset.legacy = "true";
      $("edit-event").append(legacy);
    }
    $("edit-event").value = mappedEvent && solar[mappedEvent] !== undefined ? mappedEvent : item.event || "time";
    $("edit-time").value = item.time || "20:00";
    $("edit-offset").value = item.offsetMinutes || 0;
    $("edit-sensor").replaceChildren(
      ...(snapshot.environment?.sensors || []).map((s) =>
        option(s.id, `${s.name} · ${s.lux ?? "—"} лк`),
      ),
    );
    if (!snapshot.environment?.sensors?.length)
      $("edit-sensor").append(option("", "Нет доступных датчиков"));
    if (
      item.sensorId &&
      ![...$("edit-sensor").options].some((o) => o.value === item.sensorId)
    )
      $("edit-sensor").append(
        option(item.sensorId, `${item.sensorId} · нет данных`),
      );
    if (item.sensorId) $("edit-sensor").value = item.sensorId;
    $("edit-comparison").value = item.operator || "lt";
    $("edit-min").value = (item.operator === "lt" ? item.max : item.min) ?? 50;
    $("edit-max").value = item.max ?? 200;
    $("edit-hysteresis").value = item.hysteresis ?? 5;
    $("edit-actions").replaceChildren();
    for (let i = 1; i <= 4; i++) {
      const label = el("label", `Выход ${i}`, "action-field"),
        select = el("select");
      select.dataset.output = i;
      select.append(
        option("", "Не менять"),
        option("on", "Включить"),
        option("off", "Выключить"),
      );
      select.value =
        item.outputs?.[i] === true
          ? "on"
          : item.outputs?.[i] === false
            ? "off"
            : "";
      label.append(select);
      $("edit-actions").append(label);
    }
    $("form-error").hidden = true;
    updateEditor();
    $("editor").showModal();
    $("edit-name").focus();
  }
  $("edit-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const outputs = {};
    document.querySelectorAll("[data-output]").forEach((select) => {
      if (select.value) outputs[select.dataset.output] = select.value === "on";
    });
    try {
      if (!Object.keys(outputs).length)
        throw new Error("Укажите хотя бы один выход");
      const item = {
        ...(editing.id ? { id: editing.id } : {}),
        name: $("edit-name").value.trim(),
        enabled: $("edit-enabled").checked,
        target: $("edit-target").value,
        outputs,
      };
      if (editing.kind === "job")
        Object.assign(item, {
          kind: $("edit-repeat").value,
          date: $("edit-date").value,
          time: $("edit-time").value,
          event: $("edit-event").value,
          offsetMinutes: Number($("edit-offset").value),
        });
      else {
        if (!$("edit-sensor").value)
          throw new Error("Нет доступного датчика освещённости");
        Object.assign(item, {
          sensorId: $("edit-sensor").value,
          operator: $("edit-comparison").value,
          min: Number($("edit-min").value),
          max: Number($("edit-max").value),
          hysteresis: Number($("edit-hysteresis").value),
        });
        if (item.operator === "lt") {
          item.max = item.min;
          item.min = 0;
        }
        if (item.operator === "between" && item.max <= item.min)
          throw new Error("Верхняя граница должна быть больше нижней");
      }
      await mutate(editing.kind === "job" ? "jobs" : "rules", "PUT", {
        [editing.kind]: item,
      });
      $("editor").close();
      toast("Сохранено");
    } catch (error) {
      $("form-error").textContent = error.message;
      $("form-error").hidden = false;
    }
  });
  ["edit-repeat", "edit-event", "edit-comparison"].forEach((id) =>
    $(id).addEventListener("change", updateEditor),
  );
  ["close-editor", "cancel-editor"].forEach((id) =>
    $(id).addEventListener("click", () => $("editor").close()),
  );
  $("add-job").addEventListener("click", () => openEditor("job"));
  $("add-rule").addEventListener("click", () => openEditor("rule"));
  $("mode").addEventListener("change", async () => {
    try {
      await mutate("mode", "POST", { mode: $("mode").value });
    } catch (error) {
      $("mode").value = snapshot.mode;
      toast(error.message, true);
    }
  });
  $("device").addEventListener("change", renderChannels);
  $("log-device").addEventListener("change", renderLogs);
  $("refresh").addEventListener("click", refresh);
  document.querySelectorAll("[data-tab]").forEach((button) =>
    button.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((node) => {
        node.classList.toggle("active", node === button);
        if (node === button) node.setAttribute("aria-current", "page");
        else node.removeAttribute("aria-current");
      });
      document.querySelectorAll(".panel").forEach((panel) => {
        panel.hidden = panel.id !== button.dataset.tab;
      });
    }),
  );
  addEventListener("offline", () => setConnection(false));
  addEventListener("online", refresh);
  addEventListener("pagehide", () => {
    disposed = true;
    clearInterval(timer);
    clearTimeout(toastTimer);
  });
  addEventListener("pageshow", () => {
    disposed = false;
    clearInterval(timer);
    timer = setInterval(refresh, 3000);
    refresh();
  });
  refresh();
})();
