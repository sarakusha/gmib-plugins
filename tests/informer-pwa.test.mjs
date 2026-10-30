import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(
  new URL("../plugins/informer/public/sw.js", import.meta.url),
  "utf8",
);
const scope = "http://localhost:3000/plugins/informer/public/";
const cacheName = "informer-ui-8";

function worker() {
  const listeners = new Map();
  const stores = new Map();
  let network = async () => new Response("online");
  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(urls) {
          for (const url of urls)
            entries.set(url, new Response(`shell:${url}`));
        },
        async match(url) {
          return entries.get(url)?.clone();
        },
        async put(url, response) {
          entries.set(url, response);
        },
      };
    },
    async keys() {
      return [...stores.keys()];
    },
    async delete(name) {
      return stores.delete(name);
    },
  };
  vm.runInNewContext(source, {
    self: {
      registration: { scope },
      addEventListener: (type, handler) => listeners.set(type, handler),
      skipWaiting: () => assert.fail("Updates must wait for existing clients"),
    },
    URL,
    caches,
    fetch: (request) => network(request),
  });
  return {
    stores,
    setNetwork: (handler) => {
      network = handler;
    },
    async lifecycle(type) {
      let pending;
      listeners.get(type)({
        waitUntil: (promise) => {
          pending = promise;
        },
      });
      await pending;
    },
    request(path, method = "GET") {
      let pending;
      listeners.get("fetch")({
        request: new Request(new URL(path, scope), { method }),
        respondWith: (promise) => {
          pending = promise;
        },
      });
      return pending;
    },
  };
}

test("install caches the complete shell under the registered plugin scope", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  const entries = sw.stores.get(cacheName);
  assert.equal(entries.size, 29);
  for (const url of entries.keys()) assert.equal(url.startsWith(scope), true);
  for (const file of [
    "control.html",
    "pwa.js",
    "icon-180.png",
    "screen.js",
    "assets/backgrounds/night-partly.jpg",
    "assets/icons/wind.svg",
  ]) {
    assert.equal(entries.has(scope + file), true);
  }
  assert.equal(
    [...entries.keys()].some((url) => url.includes("/api/")),
    false,
  );
});

test("fetch intercepts only GET requests for this plugin's known static assets", () => {
  const sw = worker();
  for (const path of [
    "../api/state",
    "api/state",
    "defaults.json",
    "../other/control.html",
    "http://example.com/plugins/informer/public/control.html",
  ]) {
    assert.equal(sw.request(path), undefined, path);
  }
  assert.equal(sw.request("control.html", "POST"), undefined);
});

test("network success refreshes the shell and offline reload uses that response", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  sw.setNetwork(async () => new Response("updated shell"));
  assert.equal(
    await (await sw.request("control.html?v=2")).text(),
    "updated shell",
  );
  sw.setNetwork(async () => {
    throw new TypeError("offline");
  });
  assert.equal(
    await (await sw.request("control.html")).text(),
    "updated shell",
  );
  assert.equal(sw.request("../api/state"), undefined);
});

test("HTTP errors stay visible and do not replace cached successful content", async () => {
  const sw = worker();
  await sw.lifecycle("install");
  sw.setNetwork(async () => new Response("removed", { status: 404 }));
  const response = await sw.request("control.html");
  assert.equal(response.status, 404);
  sw.setNetwork(async () => {
    throw new TypeError("offline");
  });
  assert.match(await (await sw.request("control.html")).text(), /^shell:/);
});

test("offline misses fail and cannot use another cache's response", async () => {
  const sw = worker();
  sw.stores.set(
    "other-ui-1",
    new Map([[scope + "control.html", new Response("foreign")]]),
  );
  sw.setNetwork(async () => {
    throw new TypeError("offline");
  });
  await assert.rejects(sw.request("control.html"), /offline/);
});

test("activation removes only old informer UI caches", async () => {
  const sw = worker();
  for (const name of [
    cacheName,
    "informer-ui-0",
    "informer-data",
    "icehockey-ui-1",
  ]) {
    sw.stores.set(name, new Map());
  }
  await sw.lifecycle("activate");
  assert.deepEqual(
    [...sw.stores.keys()],
    [cacheName, "informer-data", "icehockey-ui-1"],
  );
});
