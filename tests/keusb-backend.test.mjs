import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const protocol = require("../plugins/keusb-24r/lib/protocol.cjs");
const { activate } = require("../plugins/keusb-24r/dist/main.cjs");

test("protocol validates acknowledgements and reads four outputs", async () => {
  const calls = [];
  const connection = {
    request: async (command) => {
      calls.push(command);
      return command === "$KE,RDR,ALL" ? "#RDR,ALL,0,1,0,1" : "#REL,OK";
    },
  };
  assert.deepEqual(await protocol.read(connection), [false, true, false, true]);
  await protocol.set(connection, 2, false);
  assert.deepEqual(calls, ["$KE,RDR,ALL", "$KE,REL,2,0"]);
  await assert.rejects(protocol.set(connection, 5, true));
  await assert.rejects(protocol.read({ request: async () => "#RDR,ALL,0,1" }));
  await assert.rejects(
    protocol.set({ request: async () => "#REL,ERR" }, 1, true),
  );
});

test("backend identifies without switching, manual verifies state, persistence and cleanup", async () => {
  let outputs = [false, false, false, false],
    closed = 0,
    dispose,
    stored;
  const writes = [],
    routes = new Map();
  const connection = {
    close: async () => {
      closed++;
    },
    request: async (command) => {
      if (command === "$KE,SER") return "#SER,abc123";
      if (command === "$KE,FW") return "#FW,2.0";
      if (command === "$KE,RDR,ALL")
        return `#RDR,ALL,${outputs.map(Number).join(",")}`;
      writes.push(command);
      const [, , channel, value] = command.split(",");
      outputs[Number(channel) - 1] = value === "1";
      return "#REL,OK";
    },
  };
  const context = {
    serial: {
      list: async () => [{ path: "COM7", vendorId: "04d8", productId: "000a" }],
      open: async () => connection,
    },
    environment: {
      snapshot: async () => ({ timeZone: "UTC", solar: {}, sensors: [] }),
    },
    storage: {
      get: async () => ({}),
      set: async (key, value) => {
        stored = structuredClone(value);
      },
    },
    lifecycle: {
      onDispose: (fn) => {
        dispose = fn;
      },
    },
    logger: { warn() {} },
    http: { response: (status, body) => ({ status, body }) },
  };
  for (const method of ["get", "post", "put", "delete"])
    context.http[method] = (path, handler, options) =>
      routes.set(`${method}:${path}:${options.access}`, handler);
  await activate(context);
  try {
    const request = (method, path, body = {}) =>
      routes.get(`${method}:${path}:local`)({ body });
    let state = (await request("get", "/state")).body;
    assert.equal(state.devices[0].id, "abc123");
    assert.deepEqual(writes, []);
    assert.equal(
      (
        await request("post", "/outputs", {
          target: "abc123",
          outputs: { 2: true },
        })
      ).status,
      200,
    );
    assert.deepEqual(writes, ["$KE,REL,2,1"]);
    state = (await request("get", "/state")).body;
    assert.deepEqual(state.devices[0].outputs, [false, true, false, false]);
    assert.equal(
      stored.logs.filter((item) => item.source === "manual").length,
      1,
    );
    assert.equal(
      (
        await request("post", "/outputs", {
          target: "missing",
          outputs: { 1: true },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await request("post", "/outputs", {
          target: "all",
          outputs: { 5: true },
        })
      ).status,
      400,
    );
    assert.deepEqual(writes, ["$KE,REL,2,1"]);
  } finally {
    await dispose();
  }
  assert.equal(closed, 1);
});
