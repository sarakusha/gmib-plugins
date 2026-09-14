const layouts = new Set(["groups", "digits"]);

export function clockLayout(search = "") {
  const selected = new URLSearchParams(search).get("clockLayout");
  return layouts.has(selected) ? selected : "groups";
}

export function clockParts(value) {
  const [whole, fractions = ""] = value.split(".");
  const separator = whole.lastIndexOf(":");
  return {
    minutes: separator < 0 ? "" : whole.slice(0, separator),
    seconds: separator < 0 ? whole : whole.slice(separator + 1),
    fractions,
    whole,
  };
}

const configuredLayout = clockLayout(
  typeof location === "undefined" ? "" : location.search,
);

// Group anchors are compact: minutes end at the colon and seconds start after it.
// The previous per-digit layout remains available through ?clockLayout=digits.
export function renderClock(root, value, running, layout = configuredLayout) {
  if (root.dataset.clockLayout !== layout) {
    root.dataset.clockLayout = layout;
    root.innerHTML =
      layout === "digits"
        ? '<span class="clock-face" aria-hidden="true"><span class="clock-digits"><span></span><span></span><span>:</span><span></span><span></span></span><small class="clock-fractions"></small></span>'
        : '<span class="clock-face" aria-hidden="true"><span class="clock-groups"><span class="clock-minutes"></span><span class="clock-colon">:</span><span class="clock-seconds"></span></span><small class="clock-fractions"></small></span>';
  }
  const parts = clockParts(value);
  if (layout === "digits") {
    const digits = root.querySelector(".clock-digits").children;
    for (let index = 0; index < digits.length; index++) {
      const text = parts.whole[index] || "";
      if (digits[index].textContent !== text) digits[index].textContent = text;
    }
  } else {
    const minutes = root.querySelector(".clock-minutes");
    const seconds = root.querySelector(".clock-seconds");
    if (minutes.textContent !== parts.minutes)
      minutes.textContent = parts.minutes;
    if (seconds.textContent !== parts.seconds)
      seconds.textContent = parts.seconds;
  }
  const fractionNode = root.querySelector(".clock-fractions");
  const fractionText = parts.fractions ? `.${parts.fractions}` : "";
  if (fractionNode.textContent !== fractionText)
    fractionNode.textContent = fractionText;
  root.dataset.running = String(running);
  root.setAttribute(
    "aria-label",
    `${value} · ${running ? "Часы идут" : "Часы остановлены"}`,
  );
}
