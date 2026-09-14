"use strict";
const { randomUUID } = require("node:crypto");
const {
  createMatch,
  materialize,
  applyCommand,
  fail,
  text,
} = require("./engine.cjs");
const migrations = [
  {
    version: 1,
    sql: `
CREATE TABLE matches(id TEXT PRIMARY KEY, state TEXT NOT NULL, updatedAt TEXT NOT NULL);
CREATE TABLE current_match(slot INTEGER PRIMARY KEY CHECK(slot=1), matchId TEXT REFERENCES matches(id));
CREATE TABLE commands(id TEXT PRIMARY KEY, matchId TEXT NOT NULL REFERENCES matches(id), beforeState TEXT NOT NULL, result TEXT NOT NULL);
`,
  },
];
exports.activate = async (context) => {
  const { http, clock, events } = context;
  const db = await context.database.open("matches", migrations);
  const sessionId = randomUUID();
  let roster;
  try {
    roster = context.services.require("sports-roster", "sports.rosters", "^1");
  } catch {
    /* Standalone mode is fully functional. */
  }
  let state;
  let queue = Promise.resolve();
  let lease;
  let closing = false;
  let persistenceError = null;
  let nibusConfig = await context.storage.get("nibus", {
    enabled: false,
    connectionId: "",
    target: "FF:FF:FF:FF:FF:FF",
  });
  let nibusOutput;
  let nibusStatus = nibusConfig.enabled
    ? "Ожидание соединения"
    : "NiBUS выключен";
  const configureNibus = async (config) => {
    if (
      config.enabled &&
      (!config.connectionId || typeof config.target !== "string")
    )
      fail("Выберите соединение и адрес NiBUS");
    await nibusOutput?.release();
    nibusOutput = undefined;
    if (config.enabled)
      nibusOutput = await context.nibus.acquireOutput({
        connectionId: config.connectionId,
        target: config.target,
        profile: "matchpad",
      });
    nibusConfig = config;
  };
  if (nibusConfig.enabled) {
    try {
      await configureNibus(nibusConfig);
    } catch {
      nibusStatus = "Не удалось подключить NiBUS. Проверьте настройки.";
    }
  }
  const sendNibus = async (current) => {
    if (!nibusOutput || !current) return;
    try {
      const penalties = (side) =>
        current.penalties
          .filter((p) => p.side === side && !p.queued)
          .slice(0, 2)
          .map((p) => ({
            number: p.number,
            remainingMs: Math.round(p.remainingMs),
          }));
      await nibusOutput.sendTimer({
        valueMs: Math.round(current.clock.remainingMs),
        running: current.clock.running,
        mode: current.clock.mode,
      });
      await nibusOutput.sendScoreboard({
        home: current.home.score,
        away: current.away.score,
        period: current.period,
      });
      await nibusOutput.sendTeams({
        home: current.home.shortName || current.home.name,
        away: current.away.shortName || current.away.name,
      });
      try {
        await nibusOutput.sendPenalties({
          home: penalties("home"),
          away: penalties("away"),
        });
      } catch (error) {
        await nibusOutput.sendPenalties({ home: [], away: [] });
        throw error;
      }
      const connected = (await context.nibus.listConnections()).some(
        (connection) => connection.id === nibusConfig.connectionId,
      );
      nibusStatus = connected
        ? "Состояние поставлено в очередь NiBUS"
        : "NiBUS: соединение недоступно";
    } catch (error) {
      nibusStatus = error.message;
    }
  };
  const serial = (work) => {
    const next = queue.then(work);
    queue = next.catch(() => undefined);
    return next;
  };
  const current = await db.get(
    "SELECT state FROM matches JOIN current_match ON matches.id=current_match.matchId WHERE slot=1",
  );
  if (current) {
    state = materialize(JSON.parse(current.state), clock.now());
    state.clock.running = false;
    state.secondaryClock = null;
    state.clock.anchorMs = clock.now();
    state.recovery = "Проверьте время после перезапуска";
    state.revision += 1;
  }
  const persist = async (next, tx = db) => {
    next.savedAt = new Date().toISOString();
    await tx.run(
      "INSERT INTO matches VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET state=excluded.state,updatedAt=excluded.updatedAt",
      [next.id, JSON.stringify(next), next.savedAt],
    );
  };
  if (state) await persist(state);
  const snapshot = () => ({
    sessionId,
    serverTime: clock.now(),
    state: state ? materialize(state, clock.now()) : null,
    rosterAvailable: Boolean(roster),
    controlBusy: Boolean(lease && lease.expires > clock.now()),
    persistenceError,
    nibusStatus,
    nibusEnabled: Boolean(nibusConfig.enabled),
  });
  const publish = () => events.publish("state", snapshot());
  const control = (request) => {
    const token = request.body?.controlToken;
    if (!lease || token !== lease.token || lease.expires <= clock.now()) {
      const e = new Error("Возьмите управление пультом");
      e.status = 423;
      throw e;
    }
    lease.expires = clock.now() + 15000;
  };
  const route =
    (work, mutate = false) =>
    async (request) => {
      try {
        if (closing)
          return http.response(503, { error: "gmib завершает работу" });
        const result = await (mutate
          ? serial(() => work(request))
          : work(request));
        return http.response(200, result);
      } catch (error) {
        if (!error.status)
          context.logger.error(
            "Hockey operation failed",
            error.code ?? error.name,
          );
        return http.response(error.status ?? 500, {
          error: error.status
            ? error.message
            : "Не удалось сохранить изменение",
          revision: state?.revision,
        });
      }
    };
  const checkRevision = (request) => {
    if (
      !state ||
      request.body?.matchId !== state.id ||
      request.body?.expectedRevision !== state.revision
    ) {
      const e = new Error("Состояние матча изменилось. Повторите действие.");
      e.status = 409;
      throw e;
    }
  };
  http.get("/state", route(snapshot));
  http.get(
    "/integration",
    route(async () => {
      const output = await context.output.getStatus();
      return {
        screens: await context.output.listScreens(),
        output: {
          ...output.profile,
          active: output.active,
          message: output.message,
        },
        connections: await context.nibus.listConnections(),
        nibus: nibusConfig,
        nibusStatus,
      };
    }),
  );
  http.post(
    "/output",
    route(async (request) => {
      control(request);
      if (request.body?.stop) await context.output.stop();
      else
        await context.output.start({
          screenId: request.body?.screenId,
          autoStart: Boolean(request.body?.autoStart),
          pageId: "screen",
        });
      return context.output.getStatus();
    }, true),
  );
  http.post(
    "/nibus",
    route(async (request) => {
      control(request);
      const b = request.body ?? {};
      const config = {
        enabled: Boolean(b.enabled),
        connectionId: b.connectionId || "",
        target: b.target || "FF:FF:FF:FF:FF:FF",
      };
      await configureNibus(config);
      await context.storage.set("nibus", config);
      if (!config.enabled) nibusStatus = "NiBUS выключен";
      else await sendNibus(state);
      return { configured: true };
    }, true),
  );
  http.post(
    "/control",
    route((request) => {
      const b = request.body ?? {};
      if (b.action === "release") {
        if (lease?.token === b.controlToken) lease = undefined;
        return { released: true };
      }
      if (
        lease &&
        lease.expires > clock.now() &&
        lease.token !== b.controlToken
      ) {
        const e = new Error("Пульт занят другим окном");
        e.status = 423;
        throw e;
      }
      lease = {
        token:
          lease && lease.token === b.controlToken ? lease.token : randomUUID(),
        expires: clock.now() + 15000,
      };
      return { controlToken: lease.token };
    }, true),
  );
  http.get(
    "/teams",
    route(() => (roster ? roster.listTeams("icehockey") : [])),
  );
  http.get(
    "/members",
    route((request) =>
      roster ? roster.listMembers(request.query.teamId) : [],
    ),
  );
  http.get(
    "/matches",
    route(async () =>
      (
        await db.all(
          "SELECT state FROM matches ORDER BY updatedAt DESC LIMIT 100",
        )
      ).map((row) => {
        const match = JSON.parse(row.state);
        return {
          id: match.id,
          home: match.home.name,
          away: match.away.name,
          score: `${match.home.score}:${match.away.score}`,
          status: match.status,
          savedAt: match.savedAt,
        };
      }),
    ),
  );
  http.post(
    "/matches",
    route(async (request) => {
      control(request);
      const b = request.body ?? {};
      const commandId = text(b.commandId, 100, "идентификатор команды");
      const duplicate = await db.get("SELECT result FROM commands WHERE id=?", [
        commandId,
      ]);
      if (duplicate) return snapshot();
      if (state && state.status !== "finished")
        fail("Завершите текущий матч перед созданием нового");
      const next = createMatch(b, clock.now());
      for (const side of ["home", "away"])
        if (b[`${side}TeamId`]) {
          if (!roster) fail("Справочник составов недоступен");
          const team = await roster.createRosterSnapshot(
            b[`${side}TeamId`],
            b[`${side}Players`],
          );
          if (team.sportId !== "icehockey") fail("Выберите хоккейную команду");
          next[side] = { ...team, score: 0, timeoutsUsed: 0 };
        }
      if (b.homeTeamId && b.homeTeamId === b.awayTeamId)
        fail("Выберите разные команды");
      await db.transaction(async (tx) => {
        await persist(next, tx);
        await tx.run(
          "INSERT INTO current_match VALUES (1,?) ON CONFLICT(slot) DO UPDATE SET matchId=excluded.matchId",
          [next.id],
        );
        await tx.run("INSERT INTO commands VALUES (?,?,?,?)", [
          commandId,
          next.id,
          "null",
          JSON.stringify(next),
        ]);
      });
      state = next;
      publish();
      return snapshot();
    }, true),
  );
  http.post(
    "/resume",
    route(async (request) => {
      control(request);
      if (state && state.status !== "finished") fail("Завершите текущий матч");
      const row = await db.get("SELECT state FROM matches WHERE id=?", [
        text(request.body?.id, 100, "матч"),
      ]);
      if (!row) fail("Матч не найден");
      const next = materialize(JSON.parse(row.state), clock.now());
      next.clock.running = false;
      next.secondaryClock = null;
      next.clock.anchorMs = clock.now();
      next.revision += 1;
      next.recovery = "Проверьте время перед продолжением";
      await db.transaction(async (tx) => {
        await persist(next, tx);
        await tx.run(
          "INSERT INTO current_match VALUES (1,?) ON CONFLICT(slot) DO UPDATE SET matchId=excluded.matchId",
          [next.id],
        );
      });
      state = next;
      publish();
      return snapshot();
    }, true),
  );
  http.post(
    "/commands",
    route(async (request) => {
      control(request);
      const b = request.body ?? {};
      const commandId = text(b.commandId, 100, "идентификатор команды");
      const duplicate = await db.get(
        "SELECT matchId FROM commands WHERE id=?",
        [commandId],
      );
      if (duplicate) {
        if (duplicate.matchId !== state?.id)
          fail("Команда относится к другому матчу");
        return snapshot();
      }
      checkRevision(request);
      const before = materialize(state, clock.now());
      let next;
      if (b.command?.type === "undo") {
        const last = await db.get(
          "SELECT beforeState FROM commands WHERE matchId=? ORDER BY rowid DESC LIMIT 1",
          [state.id],
        );
        next = last && JSON.parse(last.beforeState);
        if (!next) fail("Нет действия для отмены");
        next.clock.running = false;
        next.secondaryClock = null;
        next.clock.anchorMs = clock.now();
        next.revision = state.revision + 1;
        next.recovery =
          "Отмена вернула снимок перед действием. Проверьте время.";
      } else next = applyCommand(state, b.command, clock.now());
      await db.transaction(async (tx) => {
        await persist(next, tx);
        await tx.run("INSERT INTO commands VALUES (?,?,?,?)", [
          commandId,
          next.id,
          JSON.stringify(before),
          JSON.stringify(next),
        ]);
      });
      state = next;
      persistenceError = null;
      publish();
      return snapshot();
    }, true),
  );
  let lastSave = clock.now();
  let ticking = false;
  const tick = () => {
    if (!state || closing || ticking) return;
    ticking = true;
    void serial(async () => {
      const next = materialize(state, clock.now());
      const boundary =
        next.penalties.length !== state.penalties.length ||
        next.clock.running !== state.clock.running ||
        Boolean(next.secondaryClock) !== Boolean(state.secondaryClock);
      if (boundary) next.revision += 1;
      if (
        boundary ||
        ((state.clock.running || state.secondaryClock?.running) &&
          clock.now() - lastSave >= 1000)
      ) {
        try {
          await persist(next);
          lastSave = clock.now();
          persistenceError = null;
        } catch (error) {
          next.clock.running = false;
          next.revision += 1;
          next.savedAt = state.savedAt;
          persistenceError =
            "Ошибка сохранения. Часы остановлены; проверьте диск и время.";
          context.logger.error(
            "Hockey checkpoint failed",
            error.code ?? error.name,
          );
        }
      }
      state = next;
      await sendNibus(next);
      if (boundary || persistenceError) publish();
      else
        events.publish("tick", {
          sessionId,
          serverTime: clock.now(),
          nibusEnabled: Boolean(nibusConfig.enabled),
          matchId: next.id,
          revision: next.revision,
          clock: next.clock,
          secondaryClock: next.secondaryClock,
          penalties: next.penalties,
          savedAt: next.savedAt,
          nibusStatus,
        });
    })
      .catch((error) => {
        context.logger.error("Hockey tick failed", error.code ?? error.name);
      })
      .finally(() => {
        ticking = false;
      });
  };
  const interval = setInterval(tick, 100);
  interval.unref?.();
  const pauseAndSave = (reason, at = clock.now()) =>
    serial(async () => {
      if (!state) return;
      state = materialize(state, at);
      state.clock.running = false;
      state.secondaryClock = null;
      state.revision += 1;
      state.recovery = reason;
      await persist(state);
      publish();
    });
  context.clock.onSuspend(() => {
    void pauseAndSave("Компьютер переходил в сон. Проверьте время.").catch(
      () => {
        persistenceError = "Не удалось сохранить состояние перед сном";
      },
    );
  });
  context.clock.onResume(() => {
    void pauseAndSave(
      "Проверьте время после сна",
      state?.clock.anchorMs ?? clock.now(),
    ).catch(() => {
      persistenceError = "Не удалось сохранить состояние";
    });
  });
  context.lifecycle.onDispose(async () => {
    closing = true;
    clearInterval(interval);
    lease = undefined;
    await pauseAndSave("Проверьте время после перезапуска");
    await nibusOutput?.release();
  });
};
