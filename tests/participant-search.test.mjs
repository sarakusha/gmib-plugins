import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  availablePeople,
  searchPeople,
} from "../plugins/sports-roster/public/participant-search.js";

test("Russian directory ordering and search across a large result set", () => {
  const people = Array.from({ length: 120 }, (_, i) => ({
    id: `p${i}`,
    lastName: `Иванов${i}`,
    firstName: "Алексей",
  }));
  people.push(
    { id: "yo", lastName: "Фёдоров", firstName: "Семён" },
    { id: "a", lastName: "абрамов", firstName: "Яков" },
    { id: "b", lastName: "Абрамов", firstName: "Антон" },
  );
  const directory = availablePeople(people, [{ participantId: "p0" }]);
  assert.deepEqual(
    directory.slice(0, 2).map((p) => p.id),
    ["b", "a"],
  );
  assert.equal(searchPeople(directory, "").items.length, 50);
  assert.equal(searchPeople(directory, "").total, 122);
  assert.deepEqual(
    searchPeople(directory, " СЕМЕН   фед ").items.map((p) => p.id),
    ["yo"],
  );
  assert.deepEqual(
    searchPeople(directory, "алекс 119").items.map((p) => p.id),
    ["p119"],
  );
  assert.equal(searchPeople(directory, "несуществующий").total, 0);
  assert.equal(
    directory.some((p) => p.id === "p0"),
    false,
  );
  assert.equal(people[0].id, "p0");
});

test("member name editors cannot trigger Safari form autofill", async () => {
  const html = await readFile(
    new URL("../plugins/sports-roster/public/control.html", import.meta.url),
    "utf8",
  );
  const memberForm = html.match(/<form id="member-form"[\s\S]*?<\/form>/)?.[0];
  assert.ok(memberForm);
  assert.doesNotMatch(memberForm, /name="(?:firstName|lastName)"/);
  assert.doesNotMatch(memberForm, /autocomplete="new-password"/);
  for (const id of ["member-last-name", "member-first-name"]) {
    const editor = memberForm.match(
      new RegExp(`<div(?=[^>]*id="${id}")[^>]*>`),
    )?.[0];
    assert.ok(editor);
    assert.match(editor, /contenteditable="plaintext-only"/);
  }
});
