/**
 * openLN Card Bridge — isolated-world relay content script.
 *
 * Bridges page (MAIN world) requests to the extension service worker, which
 * owns the native messaging connection to the bridge process.
 */
(() => {
  const TAG = "__openln_bridge__";
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const d = ev.data;
    if (!d || d.tag !== TAG || d.dir !== "req") return;
    chrome.runtime.sendMessage({ __openlnBridge: true, payload: d.payload }, (res) => {
      const lastErr = chrome.runtime.lastError;
      window.postMessage(
        {
          tag: TAG,
          dir: "res",
          id: d.id,
          ok: !lastErr && !!(res && res.ok),
          reply: res && res.reply,
          error: lastErr ? lastErr.message : res && res.error,
        },
        "*",
      );
    });
  });
})();
