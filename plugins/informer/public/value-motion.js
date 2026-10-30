(() => {
  "use strict";
  // The incoming value determines layout immediately; only its paint rotates.
  // Each update replaces both faces, so rapid updates cannot leave stale timers.
  function set(element, value, enabled, previous = element.dataset.value) {
    value = String(value);
    if (element.dataset.value === value && element.childNodes.length) return;
    element.dataset.value = value;
    element.replaceChildren();
    if (!value) return;
    const current = document.createElement("span");
    current.className = "value-motion";
    const incoming = document.createElement("span");
    incoming.className = "value-incoming";
    incoming.textContent = value;
    current.append(incoming);
    if (
      enabled &&
      previous &&
      value &&
      previous !== value &&
      !document.hidden &&
      !matchMedia("(prefers-reduced-motion: reduce)").matches
    ) {
      const outgoing = document.createElement("span");
      outgoing.className = "value-outgoing";
      outgoing.textContent = previous;
      outgoing.setAttribute("aria-hidden", "true");
      current.prepend(outgoing);
      current.classList.add("value-flip");
      const finish = () => {
        outgoing.remove();
        current.classList.remove("value-flip");
      };
      incoming.addEventListener("animationend", finish, { once: true });
      incoming.addEventListener("animationcancel", finish, { once: true });
    }
    element.append(current);
  }
  window.InformerMotion = { set };
})();
