(() => {
  "use strict";
  const button = document.getElementById("install-app");
  let prompt = null;
  addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    prompt = event;
    button.hidden = false;
  });
  button.addEventListener("click", async () => {
    if (!prompt) return;
    const pending = prompt;
    prompt = null;
    button.hidden = true;
    try {
      await pending.prompt();
    } catch {
      /* Browser menu remains available. */
    }
  });
  addEventListener("appinstalled", () => {
    prompt = null;
    button.hidden = true;
  });
  if (isSecureContext && "serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("sw.js", { scope: "./", updateViaCache: "none" })
      .catch(() => {
        /* Ordinary online settings remain usable. */
      });
  }
})();
