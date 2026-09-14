// Fixed digit slots keep the clock anchored when values or fractions change.
export function renderClock(root, value, running) {
  if (!root.querySelector(".clock-digits")) {
    root.innerHTML =
      '<span class="clock-face" aria-hidden="true"><span class="clock-digits"><span></span><span></span><span>:</span><span></span><span></span></span><small class="clock-fractions"></small></span>';
  }
  const [whole, fractions = ""] = value.split(".");
  const digits = root.querySelector(".clock-digits").children;
  for (let index = 0; index < digits.length; index++) {
    const text = whole[index] || "";
    if (digits[index].textContent !== text) digits[index].textContent = text;
  }
  const fractionNode = root.querySelector(".clock-fractions");
  const fractionText = fractions ? `.${fractions}` : "";
  if (fractionNode.textContent !== fractionText)
    fractionNode.textContent = fractionText;
  root.dataset.running = String(running);
  root.setAttribute(
    "aria-label",
    `${value} · ${running ? "Часы идут" : "Часы остановлены"}`,
  );
}
