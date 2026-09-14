import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHost } from "./harness.mjs";
const require = createRequire(import.meta.url);
const { activate } = require("../plugins/sports-roster/backend/main.cjs");
const sport = {
  id: "icehockey",
  name: "Хоккей",
  positions: [{ id: "goalie", name: "Вратарь" }],
  ready: true,
  enabled: true,
  installed: true,
  rosterVersion: 1,
};
test("roster CRUD, unique numbers, shared people, snapshot isolation and backup rollback", async () => {
  const host = createHost({ sports: [sport] });
  await activate(host.context);
  try {
    const team = (
      await host.request("PUT", "/teams", { sportId: "icehockey", name: "Дом" })
    ).body;
    assert.ok(team.id);
    const member = (
      await host.request("PUT", "/members", {
        teamId: team.id,
        lastName: "Игрок",
        number: "07",
        position: "goalie",
      })
    ).body;
    assert.equal(
      (
        await host.request("PUT", "/members", {
          teamId: team.id,
          lastName: "Другой",
          number: "07",
        })
      ).status,
      409,
    );
    const service = host.services.get("sports.rosters");
    const snapshot = await service.createRosterSnapshot(team.id);
    await host.request("PUT", "/members", { ...member, lastName: "Изменён" });
    assert.equal(snapshot.members[0].lastName, "Игрок");
    assert.equal((await service.listMembers(team.id))[0].lastName, "Изменён");
    const backup = (await host.request("GET", "/backup")).body;
    const broken = structuredClone(backup);
    broken.members[0].teamId = "missing";
    assert.notEqual(
      (await host.request("POST", "/restore", broken)).status,
      200,
    );
    assert.equal((await service.listMembers(team.id)).length, 1);
    assert.equal((await host.request("POST", "/restore", backup)).status, 200);
    sport.ready = false;
    assert.equal(
      (
        await host.request("PUT", "/teams", {
          sportId: "icehockey",
          name: "Новая",
        })
      ).status,
      422,
    );
    assert.equal(
      (await host.request("GET", "/teams", undefined, { sportId: "icehockey" }))
        .body.length,
      1,
    );
  } finally {
    sport.ready = true;
    await host.close();
  }
});
