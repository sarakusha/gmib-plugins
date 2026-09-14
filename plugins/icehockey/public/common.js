export const $ = (selector) => document.querySelector(selector);
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
export const uid = () => crypto.randomUUID();
export const notify = (message, error = false) => {
  const node = $("#notice");
  if (node) {
    node.textContent = message;
    node.className = `notice${error ? " error" : ""}`;
    node.hidden = !message;
  }
  const dialog = document.querySelector("dialog[open]");
  if (dialog) {
    let alert = dialog.querySelector(".dialog-notice");
    if (!alert) {
      alert = document.createElement("div");
      alert.className = "notice error dialog-notice";
      alert.setAttribute("role", "alert");
      dialog.prepend(alert);
    }
    alert.textContent = message;
    alert.hidden = !message;
  }
};
export async function api(path, body, method) {
  const response = await fetch(`api/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    cache: "no-store",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response
    .json()
    .catch(() => ({ error: `Ошибка сервера: HTTP ${response.status}` }));
  if (!response.ok) {
    const error = new Error(result.error || "Ошибка запроса");
    error.status = response.status;
    throw error;
  }
  return result;
}
export function realtime(handler, connection) {
  let disposed = false,
    timer,
    socket;
  const connect = () => {
    socket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}`,
    );
    socket.addEventListener("open", () => connection?.(true));
    socket.addEventListener("message", (event) => {
      try {
        handler(JSON.parse(event.data));
      } catch {}
    });
    socket.addEventListener("close", () => {
      connection?.(false);
      if (!disposed) timer = setTimeout(connect, 1500);
    });
    socket.addEventListener("error", () => socket.close());
  };
  connect();
  addEventListener("pagehide", () => {
    disposed = true;
    clearTimeout(timer);
    socket.close();
  });
}
export const time = (ms) => {
  const sec = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(sec / 60)
    .toString()
    .padStart(2, "0")}:${(sec % 60).toString().padStart(2, "0")}`;
};
if ("serviceWorker" in navigator)
  navigator.serviceWorker.register("sw.js").catch(() => {});
