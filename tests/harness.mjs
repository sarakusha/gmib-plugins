import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export function createHost({
  sports = [],
  services = new Map(),
  directory,
  now = 0,
} = {}) {
  const routes = new Map(),
    disposers = [],
    databases = [],
    power = {},
    published = [];
  let time = now;
  const wrap = (db) => {
    const direct = {
      all: async (sql, params = []) => db.prepare(sql).all(...params),
      get: async (sql, params = []) => db.prepare(sql).get(...params),
      run: async (sql, params = []) => {
        const result = db.prepare(sql).run(...params);
        return {
          changes: Number(result.changes),
          lastID: Number(result.lastInsertRowid),
        };
      },
    };
    let queue = Promise.resolve();
    const serial = (work) => {
      const next = queue.then(work);
      queue = next.catch(() => {});
      return next;
    };
    return {
      ...Object.fromEntries(
        Object.entries(direct).map(([key, fn]) => [
          key,
          (...args) => serial(() => fn(...args)),
        ]),
      ),
      transaction: (work) =>
        serial(async () => {
          db.exec("BEGIN");
          try {
            const result = await work(direct);
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        }),
    };
  };
  const context = {
    apiVersion: "1.1.0",
    logger: { error() {}, warn() {}, info() {}, debug() {} },
    http: {
      ...Object.fromEntries(
        ["get", "post", "put", "patch", "delete"].map((method) => [
          method,
          (path, handler) =>
            routes.set(`${method.toUpperCase()} ${path}`, handler),
        ]),
      ),
      response: (status, body, headers) => ({ status, body, headers }),
    },
    database: {
      open: async (name, migrations) => {
        const db = new DatabaseSync(
          directory ? `${directory}/${name}.sqlite3` : ":memory:",
        );
        db.exec(
          "PRAGMA foreign_keys=ON; CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY)",
        );
        for (const item of migrations)
          if (
            !db
              .prepare("SELECT 1 FROM schema_migrations WHERE version=?")
              .get(item.version)
          ) {
            db.exec(item.sql);
            db.prepare("INSERT INTO schema_migrations VALUES(?)").run(
              item.version,
            );
          }
        databases.push(db);
        return wrap(db);
      },
    },
    services: {
      provide: (name, version, value) => services.set(name, value),
      require: (owner, name) => {
        if (!services.has(name)) throw new Error("missing");
        return services.get(name);
      },
    },
    plugins: { listSports: () => sports },
    clock: {
      now: () => time,
      onSuspend: (handler) => {
        power.suspend = handler;
        return () => {};
      },
      onResume: (handler) => {
        power.resume = handler;
        return () => {};
      },
    },
    events: { publish: (event, data) => published.push({ event, data }) },
    lifecycle: { onDispose: (handler) => disposers.push(handler) },
    output: {
      registerPage: async () => {},
      getStatus: async () => ({ active: false, message: "Не выбран" }),
      listScreens: async () => [],
      start: async () => {},
      stop: async () => {},
    },
    nibus: {
      listConnections: async () => [],
      acquireOutput: async () => ({
        sendTimer: async () => {},
        sendTeams: async () => {},
        sendScoreboard: async () => {},
        sendPenalties: async () => {},
        release: async () => {},
      }),
    },
    storage: { get: async (key, fallback) => fallback, set: async () => {} },
  };
  return {
    context,
    published,
    services,
    routes,
    power,
    advance: (ms) => {
      time += ms;
    },
    now: () => time,
    request: async (method, path, body, query = {}) => {
      const handler = routes.get(`${method} ${path}`);
      if (!handler) throw new Error(`Unknown route ${path}`);
      return handler({ method, path, body, query });
    },
    close: async () => {
      for (const dispose of disposers.reverse()) await dispose();
      for (const db of databases) db.close();
    },
  };
}
export const commandBody = (snapshot, controlToken, command) => ({
  commandId: randomUUID(),
  controlToken,
  matchId: snapshot.state.id,
  expectedRevision: snapshot.state.revision,
  command,
});
