/**
 * openLN Card Bridge — MAIN-world content script.
 *
 * Defines window.openlnBridge on allow-listed pages so the webapp can drive
 * the local card bridge without any CORS gymnastics. Requests travel via a
 * window.postMessage handshake to content-relay.js (isolated world), which
 * forwards through the service worker to the native host.
 */
(() => {
  if (window.openlnBridge) return;
  const TAG = "__openln_bridge__";
  let seq = 0;
  const pending = new Map();

  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.tag !== TAG || d.dir !== "res") return;
    const entry = pending.get(d.id);
    if (entry) {
      pending.delete(d.id);
      entry(d);
    }
  });

  window.openlnBridge = {
    kind: "extension",
    request(payload) {
      return new Promise((resolve) => {
        const id = ++seq;
        const timer = setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id);
            resolve({ ok: false, error: "timeout talking to the card bridge" });
          }
        }, 32000);
        pending.set(id, (d) => {
          clearTimeout(timer);
          resolve(d.ok ? { ok: true, ...(d.reply || {}) } : { ok: false, error: d.error || "bridge error" });
        });
        window.postMessage({ tag: TAG, dir: "req", id, payload }, "*");
      });
    },
  };
})();
