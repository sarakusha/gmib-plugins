import { $, esc, api, notify, realtime, time, uid } from "./common.js";
import { penaltyTime, renderClock } from "./clock-view.js";
import {
  projectedClockMs,
  timeoutCanStart,
  timeoutCount,
  timeoutLabel,
} from "./sports-timeouts.js";
import { controlViewKey, setText, setFlag } from "./control-view.js";
let data,
  renderedViewKey,
  received = performance.now(),
  online = false,
  token = sessionStorage.getItem("hockey-control"),
  busy = false,
  teams = [];
const guard = (work) => async (event) => {
  if (event?.type === "submit") event.preventDefault();
  try {
    await work(event);
  } catch (error) {
    notify(error.message, true);
    if (error.status === 423) {
      token = null;
      sessionStorage.removeItem("hockey-control");
      updateAccess();
    }
  }
};
function updateAccess() {
  const locked = !online || !token || busy;
  document
    .querySelectorAll("[data-control]")
    .forEach((button) => setFlag(button, "disabled", locked));
  const state = data?.state;
  if (!locked && state) {
    const secondaryActive = Boolean(state.secondaryClock);
    for (const selector of ["#clock", "#correct-time", "#next-period", "#rest"])
      setFlag($(selector), "disabled", secondaryActive);
    document.querySelectorAll("[data-timeout-start]").forEach((button) => {
      const side = button.dataset.timeoutStart;
      setFlag(
        button,
        "disabled",
        !timeoutCanStart(state, side),
      );
    });
    document
      .querySelectorAll("[data-timeouts-edit]")
      .forEach((button) => setFlag(button, "disabled", secondaryActive));
    setFlag($("#stop-timeout"), "disabled", !state.secondaryClock);
  }
  setFlag($("#claim"), "hidden", token);
  setFlag($("#claim"), "disabled", !online || data?.controlBusy);
  setFlag($("#release"), "hidden", !token);
  setText(
    $("#control-status"),
    token
      ? "Вы управляете"
      : data?.controlBusy
        ? "Пульт занят · просмотр"
        : "Режим просмотра",
  );
}
function accept(next) {
  if (
    data?.sessionId === next.sessionId &&
    next.state?.id === data.state?.id &&
    next.state?.revision < data.state?.revision
  )
    return;
  data = next;
  received = performance.now();
  online = true;
  setText($("#connection"), "Локальное подключение · gmib");
  updateAccess();
  const key = controlViewKey(next);
  if (renderedViewKey === key) return;
  renderedViewKey = key;
  $("#roster-link").hidden = !next.rosterAvailable;
  $("#empty").hidden = Boolean(next.state);
  $("#match").hidden = !next.state;
  updateAccess();
  if (!next.state) return;
  const state = next.state;
  for (const side of ["home", "away"]) {
    $(`#${side}-name`).textContent = state[side].name;
    $(`#${side}-score`).textContent = state[side].score;
    $(`#penalty-${side}-name`).textContent = state[side].name;
    setText(
      document.querySelector(`[data-timeouts-edit="${side}"]`),
      timeoutCount(state, side),
    );
  }
  $("#period").textContent =
    `${state.period > 3 ? "Овертайм · " : ""}Период ${state.period}${state.clock.mode === "rest" ? " / Перерыв" : ""}`;
  setText($("#clock"), state.clock.running ? "Пауза" : "Старт");
  $("#timer").dataset.running = String(state.clock.running);
  $("#return").hidden = state.clock.mode === "game";
  $("#secondary-panel").dataset.active = String(Boolean(state.secondaryClock));
  if (state.secondaryClock)
    setText(
      $("#secondary-label"),
      timeoutLabel(state),
    );
  $("#view").textContent =
    state.view === "rosters" ? "Показать счёт" : "Показать составы";
  $("#finish").textContent =
    state.status === "finished" ? "Возобновить" : "Завершить";
  $("#integration-status").textContent = next.nibusEnabled
    ? next.nibusStatus
    : "";
  $("#save-status").textContent =
    state.status === "finished"
      ? "Матч завершён"
      : state.secondaryClock
        ? "Идёт тайм-аут"
      : state.clock.running
        ? "Часы идут"
        : state.recovery || "Часы остановлены";
  if (next.persistenceError) notify(next.persistenceError, true);
  renderPenalties();
}
async function refresh() {
  accept(await api("state"));
}
async function command(value) {
  if (!token || !online || busy) return;
  busy = true;
  updateAccess();
  const commandId = uid();
  const matchId = data.state.id;
  const send = () =>
    api("commands", {
      commandId,
      controlToken: token,
      matchId,
      expectedRevision: data.state.revision,
      command: value,
    });
  try {
    try {
      accept(await send());
    } catch (error) {
      if (error.status !== 409) throw error;
      await refresh();
      if (data.state?.id !== matchId) throw error;
      accept(await send());
    }
    notify("");
  } catch (error) {
    await refresh().catch(() => {});
    throw error;
  } finally {
    busy = false;
    updateAccess();
  }
}
function renderPenalties() {
  if (!data?.state) return;
  const state = data.state;
  for (const side of ["home", "away"]) {
    const list = state.penalties.filter((item) => item.side === side);
    const root = $(`#penalties-${side}`);
    const signature = list.map((p) => `${p.id}:${p.queued}`).join("|");
    if (root.dataset.signature !== signature) {
      root.dataset.signature = signature;
      root.innerHTML = list.length
        ? list
            .map(
              (p) =>
                `<div class="penalty"><div class="penalty-reading"><span class="penalty-number">${esc(p.number)}</span><strong class="number" data-time="${esc(p.id)}"></strong><small>${p.queued ? "ожидает" : ""}</small></div><div class="row"><button data-penalty-edit="${esc(p.id)}" data-control aria-label="Исправить время штрафа">Время</button><button data-penalty-queue="${esc(p.id)}" data-control>${p.queued ? "Запустить" : "Отложить"}</button><button data-penalty-remove="${esc(p.id)}" class="danger" data-control aria-label="Снять штраф">×</button></div></div>`,
            )
            .join("")
        : '<p class="muted">Нет штрафов</p>';
    }
  }
  updateAccess();
}
setInterval(() => {
  if (!data?.state) return;
  const age = performance.now() - received;
  const state = data.state;
  const elapsed = state.clock.running
    ? Math.min(age, 2000, state.clock.remainingMs)
    : 0;
  renderClock(
    $("#timer"),
    time(state.clock.remainingMs - elapsed),
    state.clock.running,
  );
  const secondary = state.secondaryClock;
  if (secondary) {
    renderClock(
      $("#secondary-timer"),
      time(projectedClockMs(secondary, age)),
      secondary.running,
    );
  }
  const displayDelay =
    ((state.clock.displayDelayMs ?? 0) +
      (state.clock.running && state.clock.mode === "game" ? elapsed : 0)) %
    1000;
  for (const penalty of state.penalties) {
    const node = document.querySelector(
      `[data-time="${CSS.escape(penalty.id)}"]`,
    );
    if (node)
      node.textContent = penaltyTime(
        penalty.remainingMs -
          (!penalty.queued &&
          state.clock.running &&
          state.clock.mode === "game"
            ? elapsed
            : 0),
        displayDelay,
      );
  }
}, 100);
$("#claim").onclick = guard(async () => {
  const result = await api("control", { controlToken: token });
  token = result.controlToken;
  sessionStorage.setItem("hockey-control", token);
  await refresh();
});
$("#release").onclick = guard(async () => {
  await api("control", { controlToken: token, action: "release" });
  token = null;
  sessionStorage.removeItem("hockey-control");
  await refresh();
});
setInterval(() => {
  if (token)
    void api("control", { controlToken: token })
      .then((result) => {
        token = result.controlToken;
        sessionStorage.setItem("hockey-control", token);
      })
      .catch(() => {
        token = null;
        sessionStorage.removeItem("hockey-control");
        updateAccess();
      });
}, 5000);
$("#clock").onclick = guard(() =>
  command({ type: data.state.clock.running ? "pause" : "start" }),
);
$("#correct-time").onclick = guard(() => {
  if (data.state.clock.running) throw new Error("Сначала остановите часы");
  const value = prompt(
    "Оставшееся время — ММ:СС",
    time(data.state.clock.remainingMs),
  );
  if (value === null) return;
  if (!/^\d{1,2}:[0-5]\d$/.test(value))
    throw new Error("Введите время в формате ММ:СС");
  const [min, sec] = value.split(":").map(Number);
  return command({ type: "time", valueMs: (min * 60 + sec) * 1000 });
});
$("#next-period").onclick = guard(() => {
  const period = prompt(
    "Номер периода (4 и далее — овертайм)",
    String(data.state.period + 1),
  );
  if (period === null) return;
  const minutes = prompt("Длительность, минут", period === "4" ? "5" : "20");
  if (minutes === null) return;
  return command({
    type: "period",
    period: Number(period),
    durationMs: Number(minutes) * 60000,
  });
});
$("#rest").onclick = guard(() => {
  const minutes = prompt("Длительность перерыва, минут", "15");
  if (minutes !== null)
    return command({
      type: "interval",
      mode: "rest",
      durationMs: Number(minutes) * 60000,
    });
});
$("#stop-timeout").onclick = guard(() => command({ type: "timeout.stop" }));
$("#return").onclick = guard(() => command({ type: "return" }));
$("#view").onclick = guard(() =>
  command({
    type: "view",
    view: data.state.view === "rosters" ? "scoreboard" : "rosters",
  }),
);
$("#undo").onclick = guard(() => {
  if (
    confirm(
      "Вернуть состояние перед последним действием и остановить часы? После отмены проверьте время.",
    )
  )
    return command({ type: "undo" });
});
$("#finish").onclick = guard(() => {
  if (data.state.status === "finished") return command({ type: "reopen" });
  if (confirm("Завершить текущий матч?")) return command({ type: "finish" });
});
$("main").addEventListener(
  "click",
  guard((event) => {
    const score = event.target.closest("[data-score]")?.dataset.score;
    if (score) {
      const [side, delta] = score.split(":");
      return command({ type: "score", side, delta: Number(delta) });
    }
    const timeoutSide = event.target.closest("[data-timeout-start]")?.dataset
      .timeoutStart;
    if (timeoutSide)
      return command({
        type: "timeout.start",
        side: timeoutSide,
        durationMs: 30000,
      });
    const timeoutsSide = event.target.closest("[data-timeouts-edit]")?.dataset
      .timeoutsEdit;
    if (timeoutsSide) {
      const value = prompt(
        "Использовано тайм-аутов",
        String(data.state[timeoutsSide].timeoutsUsed ?? 0),
      );
      if (value !== null)
        return command({ type: "timeouts", side: timeoutsSide, value: Number(value) });
    }
    const remove = event.target.closest("[data-penalty-remove]")?.dataset
      .penaltyRemove;
    if (remove) return command({ type: "penalty.remove", id: remove });
    const queue = event.target.closest("[data-penalty-queue]")?.dataset
      .penaltyQueue;
    if (queue)
      return command({
        type: "penalty.edit",
        id: queue,
        queued: !data.state.penalties.find((p) => p.id === queue).queued,
      });
    const edit = event.target.closest("[data-penalty-edit]")?.dataset
      .penaltyEdit;
    if (edit) {
      const p = data.state.penalties.find((p) => p.id === edit);
      const seconds = prompt(
        "Остаток штрафа, секунд",
        String(Math.ceil(p.remainingMs / 1000)),
      );
      if (seconds !== null)
        return command({
          type: "penalty.edit",
          id: edit,
          remainingMs: Number(seconds) * 1000,
        });
    }
  }),
);
$("#new").onclick = guard(async () => {
  if (data?.state && data.state.status !== "finished")
    throw new Error("Сначала завершите текущий матч");
  $("#new-form").reset();
  $("#roster-picker").hidden = !data.rosterAvailable;
  $("#home-players").innerHTML = $("#away-players").innerHTML = "";
  if (data.rosterAvailable) {
    teams = await api("teams");
    for (const side of ["home", "away"])
      $(`#${side}-team`).innerHTML =
        '<option value="">Вручную</option>' +
        teams
          .map(
            (team) =>
              `<option value="${esc(team.id)}">${esc(team.name)}</option>`,
          )
          .join("");
  }
  $("#new-dialog").showModal();
});
for (const side of ["home", "away"])
  $(`#${side}-team`).onchange = guard(async () => {
    const team = teams.find((item) => item.id === $(`#${side}-team`).value);
    $(`#${side}-players`).innerHTML = "";
    if (!team) return;
    $("#new-form").elements.namedItem(side).value = team.name;
    const members = await api(`members?teamId=${encodeURIComponent(team.id)}`);
    $(`#${side}-players`).innerHTML = members
      .filter((p) => p.active)
      .map(
        (p) =>
          `<label class="row" style="padding:6px 0"><input type="checkbox" name="${side}Players" value="${esc(p.participantId)}" checked> № ${esc(p.number || "—")} ${esc(p.lastName)}</label>`,
      )
      .join("");
  });
$("#new-form").onsubmit = guard(async () => {
  const form = new FormData($("#new-form"));
  const b = Object.fromEntries(form);
  accept(
    await api("matches", {
      ...b,
      durationMs: Number(b.minutes) * 60000,
      timeoutLimit: Number(b.timeoutLimit),
      homePlayers: form.getAll("homePlayers"),
      awayPlayers: form.getAll("awayPlayers"),
      commandId: uid(),
      controlToken: token,
    }),
  );
  $("#new-dialog").close();
  notify("");
});
const numberOptions = () => {
  $("#player-numbers").innerHTML = data.state[
    $("#penalty-form").elements.side.value
  ].members
    .map(
      (p) =>
        `<option value="${esc(p.number || "")}">${esc(p.lastName)}</option>`,
    )
    .join("");
};
$("#add-penalty").onclick = () => {
  $("#penalty-form").reset();
  numberOptions();
  $("#penalty-dialog").showModal();
};
$("#penalty-form").elements.side.onchange = numberOptions;
$("#penalty-form").onsubmit = guard(async () => {
  const b = Object.fromEntries(new FormData($("#penalty-form")));
  await command({
    type: "penalty",
    ...b,
    durationMs:
      (b.minutes === "custom" ? Number(b.seconds) : Number(b.minutes) * 60) *
      1000,
    queued: Boolean(b.queued),
  });
  $("#penalty-dialog").close();
});
$("#history").onclick = guard(async () => {
  const games = await api("matches");
  $("#games").innerHTML = games.length
    ? games
        .map(
          (game) =>
            `<div class="row spread"><div>${esc(game.home)} — ${esc(game.away)} <strong>${esc(game.score)}</strong><br><small>${esc(game.savedAt?.slice(0, 16).replace("T", " "))}</small></div><button data-resume="${esc(game.id)}" ${token ? "" : "disabled"}>Открыть</button></div>`,
        )
        .join("")
    : '<p class="muted">Сохранённых игр нет</p>';
  $("#history-dialog").showModal();
});
$("#games").onclick = guard(async (event) => {
  const id = event.target.closest("[data-resume]")?.dataset.resume;
  if (id) {
    accept(await api("resume", { id, controlToken: token }));
    $("#history-dialog").close();
  }
});
$("#settings").onclick = guard(async () => {
  const config = await api("integration");
  $("#output-screen").innerHTML = config.screens
    .map(
      (screen) =>
        `<option value="${screen.id}">${esc(screen.name)} · ${screen.width || 0}×${screen.height || 0}</option>`,
    )
    .join("");
  if (config.output?.screenId)
    $("#output-screen").value = config.output.screenId;
  $("#output-form").elements.autoStart.checked = Boolean(
    config.output?.autoStart,
  );
  $("#output-status").textContent =
    config.output?.message ||
    "Сначала настройте экран и его геометрию в gmib → Вывод.";
  $("#nibus-connection").innerHTML =
    '<option value="">Не выбрано</option>' +
    config.connections
      .map(
        (connection) =>
          `<option value="${esc(connection.id)}">${esc(connection.name)}</option>`,
      )
      .join("");
  $("#nibus-connection").value = config.nibus?.connectionId || "";
  $("#nibus-form").elements.enabled.checked = Boolean(config.nibus?.enabled);
  $("#nibus-form").elements.target.value =
    config.nibus?.target || "FF:FF:FF:FF:FF:FF";
  $("#nibus-status").textContent = config.nibusStatus || "";
  $("#settings-dialog").showModal();
});
$("#output-form").onsubmit = guard(async () => {
  const b = Object.fromEntries(new FormData($("#output-form")));
  const result = await api("output", {
    screenId: Number(b.screenId),
    autoStart: Boolean(b.autoStart),
    controlToken: token,
  });
  $("#output-status").textContent = result.message;
});
$("#stop-output").onclick = guard(async () => {
  await api("output", { stop: true, controlToken: token });
  $("#output-status").textContent = "Вывод выключен";
});
$("#nibus-form").onsubmit = guard(async () => {
  const b = Object.fromEntries(new FormData($("#nibus-form")));
  await api("nibus", {
    ...b,
    enabled: Boolean(b.enabled),
    controlToken: token,
  });
  $("#nibus-status").textContent = "Настройки сохранены";
});
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog").close()),
  );
realtime(
  (message) => {
    if (message.event === "plugin:icehockey:state") accept(message.data[0]);
    else if (message.event === "plugin:icehockey:tick") {
      const tick = message.data[0];
      if (
        data?.sessionId === tick.sessionId &&
        data?.state?.id === tick.matchId
      )
        accept({
          ...data,
          ...tick,
          state: {
            ...data.state,
            revision: tick.revision,
            clock: tick.clock,
            secondaryClock: tick.secondaryClock,
            penalties: tick.penalties,
            savedAt: tick.savedAt,
          },
        });
    }
  },
  (connected) => {
    online = connected;
    updateAccess();
    if (connected) void refresh().catch((error) => notify(error.message, true));
    else $("#connection").textContent = "Нет связи с gmib";
  },
);
await refresh().catch((error) => notify(error.message, true));

for (const side of ["home", "away"])
  $(`#${side}-score`).onclick = guard(() => {
    const value = prompt("Счёт команды", String(data.state[side].score));
    if (value !== null)
      return command({ type: "score", side, value: Number(value) });
  });
