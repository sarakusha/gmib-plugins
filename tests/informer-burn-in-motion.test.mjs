import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import fs from "node:fs";

const source = fs.readFileSync(
  new URL("../plugins/informer/public/burn-in.js", import.meta.url),
  "utf8",
);
function setup() {
  const context = { getComputedStyle: () => ({ getPropertyValue: () => "1" }) };
  vm.runInNewContext(source, context);
  const rect = (left, top, width, height) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
    toJSON() {
      return { ...this };
    },
  });
  const boxes = {
    ".time-pane": rect(0, 0, 320, 192),
    ".weather-pane": rect(320, 0, 384, 192),
    ".datetime": rect(18, 8, 284, 133),
    "#clock-metrics": rect(18, 141, 284, 43),
    "#weather-slide": rect(327, 19, 360, 166),
    ".source": rect(612, 1, 82, 16),
    ".weather-footer": rect(612, 1, 82, 16),
  };
  const elements = Object.fromEntries(
    Object.entries(boxes).map(([key, box]) => {
      const style = {
        translate: "0px 0px",
        removeProperty() {
          this.translate = "0px 0px";
        },
      };
      return [
        key,
        {
          style,
          getBoundingClientRect() {
            const [x, y] = style.translate.split(" ").map(parseFloat);
            return rect(
              box.left + x,
              box.top + y,
              box.right - box.left,
              box.bottom - box.top,
            );
          },
        },
      ];
    }),
  );
  const classes = new Set();
  const doc = {
    querySelector: (selector) => elements[selector],
    documentElement: { clientWidth: 704 },
    body: {
      className: "",
      classList: { contains: (name) => classes.has(name) },
    },
  };
  return {
    api: context.InformerBurnIn,
    engine: context.InformerBurnIn.create(doc),
    elements,
    boxes,
    classes,
    doc,
  };
}

test("trajectories stay inside asymmetric available room for every distance and phase", () => {
  const { api } = setup();
  for (const distance of api.distances) {
    const bounds = api.limits(
      { left: 3, right: 97, top: 1, bottom: 99 },
      { left: 0, right: 100, top: 0, bottom: 100 },
      distance,
    );
    for (let phase = 0; phase < 100; phase += 0.1)
      for (let index = 0; index < 4; index++) {
        const { x, y } = api.position(phase, index, bounds);
        assert.ok(x >= -3 && x <= 3 && y >= -1 && y <= 1);
      }
  }
  const logo = api.limits(
    { left: 80, right: 99, top: 0, bottom: 10 },
    { left: 0, right: 100, top: 0, bottom: 100 },
    48,
    true,
  );
  assert.equal(logo.left, -48);
  assert.equal(logo.right, 1);
  assert.equal(logo.top, 0);
  assert.equal(logo.bottom, 0);
});

test("repeated snapshots do not reset motion; demo is faster and disabling returns to origin", () => {
  const normal = setup(),
    repeated = setup(),
    demo = setup();
  const settings = { burnInDistance: 5, burnInSpeed: 2 };
  for (let now = 0; now <= 5000; now += 20) {
    normal.engine.tick(now, settings);
    repeated.engine.tick(now, { ...settings });
    demo.engine.tick(now, { ...settings, burnInDemo: true });
  }
  assert.equal(
    normal.elements[".datetime"].style.translate,
    repeated.elements[".datetime"].style.translate,
  );
  assert.ok(
    Math.abs(parseFloat(demo.elements[".datetime"].style.translate)) >
      Math.abs(parseFloat(normal.elements[".datetime"].style.translate)) * 5,
  );
  for (let now = 5020; now <= 40000; now += 20)
    demo.engine.tick(now, { ...settings, burnInProtection: false });
  for (const selector of [
    ".datetime",
    "#clock-metrics",
    "#weather-slide",
    ".source",
  ])
    assert.equal(demo.elements[selector].style.translate, "0.0000px 0.0000px");
  demo.engine.dispose();
  demo.engine.tick(50000, settings);
  assert.equal(demo.elements[".datetime"].style.translate, "0px 0px");
});

test("compact details reserve the source strip during accelerated movement", () => {
  const { engine, boxes, classes, elements, doc } = setup();
  classes.add("compact");
  classes.add("weather-details");
  doc.body.className = "compact weather-details";
  Object.assign(boxes[".time-pane"], { bottom: 141 });
  Object.assign(boxes[".weather-pane"], {
    left: 0,
    right: 320,
    top: 141,
    bottom: 192,
  });
  Object.assign(boxes["#weather-slide"], {
    left: 20,
    right: 303,
    top: 141,
    bottom: 169,
  });
  Object.assign(boxes[".weather-footer"], {
    left: 228,
    right: 310,
    top: 175,
    bottom: 191,
  });
  Object.assign(boxes[".source"], {
    left: 228,
    right: 310,
    top: 175,
    bottom: 191,
  });
  for (let now = 0; now < 120000; now += 40) {
    engine.tick(now, { burnInDistance: 5, burnInSpeed: 5, burnInDemo: true });
    const weather = elements["#weather-slide"].getBoundingClientRect();
    const logo = elements[".source"].getBoundingClientRect();
    assert.ok(weather.bottom <= 174.001);
    assert.ok(logo.left >= 0 && logo.right <= 320);
  }
});

test("startup and enabling stay within the selected slow speed", () => {
  for (const initiallyDisabled of [false, true]) {
    const { engine, elements } = setup();
    let previous = 0;
    // Default logo range: -16..10px; frequency factor for its X axis is 1.213.
    const maxPerStep = ((13 * Math.PI * 2) / (16 * 60)) * 1.213 * 0.02;
    for (let now = 0; now <= 3000; now += 20) {
      engine.tick(now, {
        burnInProtection: !(initiallyDisabled && now < 1000),
      });
      const current = parseFloat(elements[".source"].style.translate);
      assert.ok(
        Math.abs(current - previous) <= maxPerStep + 0.00011,
        `logo moved ${Math.abs(current - previous)}px in 20ms`,
      );
      previous = current;
    }
  }
});
