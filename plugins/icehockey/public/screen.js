import { $, esc, api, realtime, time } from "./common.js";
let data,
  received = 0,
  online = false,
  rosterSignature = "";
const forceRoster = location.pathname.endsWith("/rosters.html");
const accept = (next) => {
  if (
    data?.sessionId === next.sessionId &&
    next.state?.id === data.state?.id &&
    next.state?.revision < data.state?.revision
  )
    return;
  data = next;
  received = performance.now();
  online = true;
  const state = next.state;
  $("#waiting").hidden = Boolean(state);
  if (!state) return;
  $("#board").style.setProperty(
    "--digits",
    Math.max(String(state.home.score).length, String(state.away.score).length),
  );
  const roster = forceRoster || state.view === "rosters";
  $("#rosters").hidden = !roster;
  $("#scoreboard").hidden = roster;
  for (const side of ["home", "away"]) {
    $(`#${side}-name`).style.setProperty(
      "--name-scale",
      Math.max(
        0.35,
        Math.min(1, 20 / (state[side].shortName || state[side].name).length),
      ),
    );
    $(`#${side}-name`).textContent = state[side].shortName || state[side].name;
    $(`#${side}-score`).textContent = state[side].score;
    $(`#${side}-title`).textContent = state[side].name;
  }
  $("#period").textContent =
    state.period > 3 ? `ОТ ${state.period - 3}` : `ПЕРИОД ${state.period}`;
  $("#mode").textContent =
    state.status === "finished"
      ? "МАТЧ ЗАВЕРШЁН"
      : state.clock.mode === "rest"
        ? "ПЕРЕРЫВ"
        : state.clock.mode === "timeout"
          ? "ТАЙМ-АУТ"
          : state.clock.running
            ? ""
            : "ПАУЗА";
  const signature = `${state.id}:${JSON.stringify([state.home.members, state.away.members])}`;
  if (signature !== rosterSignature) {
    rosterSignature = signature;
    for (const side of ["home", "away"]) {
      const members = state[side].members || [];
      $(`#${side}-roster`).innerHTML = members.length
        ? members
            .map(
              (p) =>
                `<div class="player"><b>${esc(p.number || "—")}</b><span>${esc(p.lastName)} ${esc(p.firstName || "")}${p.captain ? " · К" : ""}</span></div>`,
            )
            .join("")
        : '<div class="player">Состав не указан</div>';
      $("#rosters").style.setProperty(
        "--row-size",
        `${Math.min(6, 76 / Math.max(1, state.home.members.length, state.away.members.length))}cqh`,
      );
    }
  }
};
function frame() {
  const state = data?.state;
  const age = performance.now() - received;
  $("#connection").textContent =
    !online || age > 3000
      ? "НЕТ СВЯЗИ С GMIB"
      : data?.persistenceError
        ? "ОШИБКА СОХРАНЕНИЯ"
        : "";
  if (state) {
    const elapsed = state.clock.running
      ? Math.min(age, 2000, state.clock.remainingMs)
      : 0;
    $("#time").textContent = time(state.clock.remainingMs - elapsed);
    for (const side of ["home", "away"]) {
      const penalties = state.penalties
        .filter((p) => p.side === side && !p.queued)
        .slice(0, 2);
      $(`#${side}-penalties`).innerHTML = penalties
        .map(
          (p) =>
            `<span>№ ${esc(p.number)}<br>${time(p.remainingMs - (state.clock.mode === "game" ? elapsed : 0))}</span>`,
        )
        .join("");
    }
  }
  requestAnimationFrame(frame);
}
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
            penalties: tick.penalties,
            savedAt: tick.savedAt,
          },
        });
    }
  },
  (connected) => {
    online = connected;
    if (connected)
      void api("state")
        .then(accept)
        .catch(() => {
          online = false;
        });
  },
);
void api("state")
  .then(accept)
  .catch(() => {
    online = false;
  });
frame();
