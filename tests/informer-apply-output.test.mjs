import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
const source = await readFile(
  new URL("../plugins/informer/public/control.js", import.meta.url),
  "utf8",
);
const start = source.indexOf(
  '  $("save").addEventListener("click", async () => {',
);
const end = source.indexOf('  $("page-resume")', start);
const handler = source.slice(start, end);

test("Apply saves edited output config, preserves untouched output, and exposes save errors", async () => {
  for (const [dirty, fail] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    let click;
    const calls = [],
      messages = [];
    const nodes = {
      save: {
        addEventListener: (_, fn) => {
          click = fn;
        },
      },
      feedback: { textContent: "" },
    };
    const context = {
      $: (id) => nodes[id],
      saving: false,
      outputBusy: false,
      ready: true,
      settingsSupported: true,
      outputBound: true,
      outputRevision: dirty ? 1 : 0,
      savedOutputRevision: 0,
      outputCommandGeneration: 0,
      readOutputConfig: () => ({ autoStart: false }),
      readDraft() {},
      readSource: () => ({}),
      draft: {},
      action: async () => calls.push("settings"),
      updateOutputControls() {},
      api: async (route, method, body) => {
        calls.push(body);
        if (fail) throw Error("save failed");
        return {};
      },
      renderOutput() {},
      show: (message) => messages.push(message),
      toast: (message) => messages.push(message),
    };
    vm.runInNewContext(handler, context);
    await click();
    assert.equal(calls.length, dirty ? 2 : 1);
    if (dirty) assert.equal(calls[1].config.autoStart, false);
    assert.equal(context.savedOutputRevision, dirty && !fail ? 1 : 0);
    if (fail) assert.ok(messages.includes("save failed"));
    assert.equal(context.outputBusy, false);
  }
});
