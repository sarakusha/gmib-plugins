import { $, esc, api, notify, realtime } from "./common.js";
import { availablePeople, searchPeople } from "./participant-search.js";
let sports = [],
  teams = [],
  members = [],
  selected,
  emblem = "",
  people = [],
  editingMember = false,
  suggestedPeople = [],
  activeSuggestion = -1;
const field = (form, name) => form.elements.namedItem(name);
const protect = (work) => async (event) => {
  if (event?.type === "submit") event.preventDefault();
  try {
    await work(event);
  } catch (error) {
    notify(error.message, true);
  }
};
async function loadTeams() {
  const sport = sports.find((item) => item.id === $("#sport").value);
  teams = sport
    ? await api(`teams?sportId=${encodeURIComponent(sport.id)}`)
    : [];
  $("#sport-status").textContent = sport?.ready
    ? "Доступен"
    : sport
      ? "Плагин спорта недоступен. Составы сохранены."
      : "Установите спортивный плагин, например «Хоккей · Light».";
  $("#new-team").disabled = !sport?.ready;
  selected = teams.find((team) => team.id === selected?.id) ?? teams[0];
  $("#teams").innerHTML = teams
    .map(
      (team) =>
        `<button data-team="${esc(team.id)}" class="${team.id === selected?.id ? "active" : ""}">${esc(team.name)}<small>${esc(team.city)}</small></button>`,
    )
    .join("");
  await loadMembers();
}
async function loadMembers() {
  $("#empty").hidden = Boolean(selected);
  $("#team-area").hidden = !selected;
  if (!selected) return;
  $("#team-title").textContent = selected.name;
  const sport = sports.find((item) => item.id === selected.sportId);
  $("#edit-team").disabled = $("#add-member").disabled = !sport?.ready;
  members = await api(`members?teamId=${encodeURIComponent(selected.id)}`);
  $("#members").innerHTML = members
    .map(
      (member) =>
        `<tr><td class="number">${esc(member.number || "—")}</td><td>${esc(member.lastName)} ${esc(member.firstName)} ${member.captain ? '<span class="badge">К</span>' : ""}${!member.active ? " <small>вне заявки</small>" : ""}</td><td>${esc(sport?.positions.find((position) => position.id === member.position)?.name || member.position)}</td><td><button class="ghost" data-member="${esc(member.participantId)}" ${sport?.ready ? "" : "disabled"}>Изменить</button></td></tr>`,
    )
    .join("");
  $("#member-empty").hidden = members.length > 0;
}
async function refresh() {
  const previous = $("#sport").value;
  sports = await api("sports");
  $("#sport").innerHTML = sports
    .map(
      (sport) => `<option value="${esc(sport.id)}">${esc(sport.name)}</option>`,
    )
    .join("");
  if (sports.some((sport) => sport.id === previous))
    $("#sport").value = previous;
  await loadTeams();
}
function editTeam(team) {
  const form = $("#team-form");
  form.reset();
  for (const name of ["id", "name", "shortName", "city", "color"])
    field(form, name).value =
      team?.[name] ?? (name === "color" ? "#40d9ac" : "");
  emblem = team?.logo || "";
  $("#logo-preview").src = emblem;
  $("#logo-preview").hidden = !emblem;
  $("#archive").hidden = !team;
  $("#team-dialog").showModal();
}
async function editMember(member) {
  const form = $("#member-form");
  form.reset();
  $("#position").innerHTML =
    '<option value="">Не указана</option>' +
    sports
      .find((sport) => sport.id === selected.sportId)
      .positions.map(
        (position) =>
          `<option value="${esc(position.id)}">${esc(position.name)}</option>`,
      )
      .join("");
  for (const name of [
    "participantId",
    "lastName",
    "firstName",
    "number",
    "position",
  ])
    field(form, name).value = member?.[name] ?? "";
  field(form, "captain").checked = Boolean(member?.captain);
  field(form, "active").checked = member ? Boolean(member.active) : true;
  editingMember = Boolean(member);
  people = member ? [] : availablePeople(await api("participants"), members);
  closeSuggestions();
  $("#participant-selection").textContent = member
    ? "Редактирование участника"
    : "Новый участник";
  $("#member-dialog").showModal();
}
$("#sport").onchange = protect(loadTeams);
$("#teams").onclick = protect(async (event) => {
  const id = event.target.closest("[data-team]")?.dataset.team;
  if (id) {
    selected = teams.find((team) => team.id === id);
    await loadTeams();
  }
});
$("#members").onclick = protect(async (event) => {
  const id = event.target.closest("[data-member]")?.dataset.member;
  if (id)
    await editMember(members.find((member) => member.participantId === id));
});
$("#new-team").onclick = () => editTeam();
$("#edit-team").onclick = () => editTeam(selected);
$("#add-member").onclick = protect(() => editMember());
const surname = $("#member-last-name");
function closeSuggestions() {
  $("#participant-popup").hidden = true;
  surname.setAttribute("aria-expanded", "false");
  surname.removeAttribute("aria-activedescendant");
  activeSuggestion = -1;
}
function renderPeople() {
  const form = $("#member-form");
  const query = `${surname.value} ${field(form, "firstName").value}`.trim();
  if (editingMember || !surname.value.trim()) return closeSuggestions();
  const { items, total } = searchPeople(people, query, 20);
  suggestedPeople = items;
  activeSuggestion = -1;
  surname.removeAttribute("aria-activedescendant");
  $("#participant-options").innerHTML =
    items
      .map(
        (person, index) =>
          `<div role="option" aria-selected="false" id="person-option-${index}" data-option="${index}">${esc(person.lastName)} ${esc(person.firstName)}</div>`,
      )
      .join("") +
    `<div role="option" aria-selected="false" id="person-option-${items.length}" data-option="${items.length}" class="create-person">Добавить нового: ${esc(query)}</div>`;
  $("#participant-results-status").textContent =
    total > items.length
      ? `Показаны ${items.length} из ${total} — уточните фамилию или имя.`
      : total
        ? `Найдено: ${total}`
        : "Совпадений нет";
  $("#participant-popup").hidden = false;
  surname.setAttribute("aria-expanded", "true");
}
function choosePerson(index) {
  const form = $("#member-form");
  const person = suggestedPeople[index];
  field(form, "participantId").value = person?.id ?? "";
  if (person) {
    for (const name of ["firstName", "lastName"])
      field(form, name).value = person[name];
  }
  $("#participant-selection").textContent = person
    ? `Из справочника: ${person.lastName} ${person.firstName}`
    : "Новый участник";
  closeSuggestions();
  field(form, person ? "number" : "firstName").focus();
}
for (const name of ["lastName", "firstName"]) {
  field($("#member-form"), name).oninput = () => {
    // Changing an offered name creates a new person; editing a team member keeps its identity.
    if (!editingMember) {
      field($("#member-form"), "participantId").value = "";
      $("#participant-selection").textContent = "Новый участник";
    }
    if (document.activeElement === surname) renderPeople();
  };
}
surname.onfocus = renderPeople;
surname.onkeydown = (event) => {
  if (event.isComposing) return;
  if (event.key === "Escape" && !$("#participant-popup").hidden) {
    event.preventDefault();
    event.stopPropagation();
    closeSuggestions();
  } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if ($("#participant-popup").hidden) renderPeople();
    if ($("#participant-popup").hidden) return;
    const count = suggestedPeople.length + 1;
    activeSuggestion =
      activeSuggestion < 0
        ? event.key === "ArrowDown"
          ? 0
          : count - 1
        : (activeSuggestion + (event.key === "ArrowDown" ? 1 : -1) + count) %
          count;
    document
      .querySelectorAll("#participant-options [role=option]")
      .forEach((option, index) =>
        option.setAttribute(
          "aria-selected",
          String(index === activeSuggestion),
        ),
      );
    const option = $(`#person-option-${activeSuggestion}`);
    surname.setAttribute("aria-activedescendant", option.id);
    option.scrollIntoView({ block: "nearest" });
  } else if (event.key === "Enter") {
    // Enter chooses only an explicitly highlighted option, never silently saves the form.
    event.preventDefault();
    if (!$("#participant-popup").hidden && activeSuggestion >= 0)
      choosePerson(activeSuggestion);
    else {
      closeSuggestions();
      field($("#member-form"), "firstName").focus();
    }
  } else if (event.key === "Tab") closeSuggestions();
};
$("#participant-popup").onpointerdown = (event) => event.preventDefault();
$("#participant-options").onclick = (event) => {
  const option = event.target.closest("[data-option]");
  if (option) choosePerson(Number(option.dataset.option));
};
surname.onblur = closeSuggestions;
$("#member-dialog").addEventListener("close", closeSuggestions);
$("#team-form").onsubmit = protect(async () => {
  const b = Object.fromEntries(new FormData($("#team-form")));
  selected = await api(
    "teams",
    { ...b, sportId: $("#sport").value, logo: emblem },
    "PUT",
  );
  $("#team-dialog").close();
  await loadTeams();
  notify("Команда сохранена");
});
$("#member-form").onsubmit = protect(async () => {
  const form = $("#member-form");
  await api(
    "members",
    {
      ...Object.fromEntries(new FormData(form)),
      teamId: selected.id,
      captain: field(form, "captain").checked,
      active: field(form, "active").checked,
    },
    "PUT",
  );
  $("#member-dialog").close();
  await loadMembers();
  notify("Участник сохранён");
});
$("#archive").onclick = protect(async () => {
  if (
    !confirm("Архивировать команду? Сохранённые матчи останутся без изменений.")
  )
    return;
  await api("teams", { ...selected, archived: true }, "PUT");
  $("#team-dialog").close();
  selected = undefined;
  await loadTeams();
});
$("#logo-file").onchange = protect(async () => {
  const file = $("#logo-file").files[0];
  if (!file) return;
  if (file.size > 250000) throw new Error("Эмблема должна быть меньше 250 КБ");
  emblem = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
  $("#logo-preview").src = emblem;
  $("#logo-preview").hidden = false;
});
$("#clear-logo").onclick = () => {
  emblem = "";
  $("#logo-preview").hidden = true;
};
$("#backup").onclick = protect(async () => {
  const data = await api("backup");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
  );
  a.download = `gmib-rosters-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});
$("#restore").onclick = () => $("#backup-file").click();
$("#backup-file").onchange = protect(async () => {
  const file = $("#backup-file").files[0];
  if (!file) return;
  if (file.size > 20000000) throw new Error("Слишком большой файл");
  if (
    !confirm(
      "Заменить справочник данными резервной копии? Сначала сохраните текущую копию.",
    )
  )
    return;
  await api("restore", JSON.parse(await file.text()));
  await refresh();
  notify("Справочник восстановлен");
});
document
  .querySelectorAll("[data-close]")
  .forEach(
    (button) => (button.onclick = () => button.closest("dialog").close()),
  );
realtime(
  (message) => {
    if (
      message.event === "plugin:sports-roster:changed" &&
      !document.querySelector("dialog[open]")
    )
      void refresh().catch((error) => notify(error.message, true));
  },
  (connected) => {
    if (connected) void refresh().catch((error) => notify(error.message, true));
    else notify("Нет связи с gmib. Изменения временно недоступны.", true);
  },
);
await refresh().catch((error) => notify(error.message, true));
