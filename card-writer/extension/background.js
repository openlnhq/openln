/**
 * openLN Card Bridge — extension service worker.
 *
 * Relays requests from allow-listed pages to the native host process
 * (com.openln.cardbridge) over Chrome native messaging. One persistent
 * native port is kept per service-worker lifetime so the bridge can hold
 * the reader connection open between APDUs.
 */

const HOST_NAME = "com.openln.cardbridge";
const TIMEOUT_MS = 30000;

let port = null;
let seq = 0;
const pending = new Map(); // native message id -> {resolve, reject}

function ensurePort() {
  if (port) return port;
  port = chrome.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener((msg) => {
    const entry = msg && pending.get(msg.id);
    if (entry) {
      pending.delete(msg.id);
      entry.resolve(msg);
    }
  });
  port.onDisconnect.addListener(() => {
    const err =
      (chrome.runtime.lastError && chrome.runtime.lastError.message) ||
      "native bridge not available (is the openLN card bridge installed?)";
    for (const entry of pending.values()) entry.reject(new Error(err));
    pending.clear();
    port = null;
  });
  return port;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.__openlnBridge !== true || !msg.payload) return false;
  let p;
  try {
    p = ensurePort();
  } catch (e) {
    sendResponse({ ok: false, error: String((e && e.message) || e) });
    return false;
  }
  const id = ++seq;
  const timer = setTimeout(() => {
    if (pending.has(id)) {
      pending.delete(id);
      sendResponse({ ok: false, error: "bridge timeout" });
    }
  }, TIMEOUT_MS);
  pending.set(id, {
    resolve: (reply) => {
      clearTimeout(timer);
      sendResponse({ ok: true, reply });
    },
    reject: (err) => {
      clearTimeout(timer);
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    },
  });
  p.postMessage({ ...msg.payload, id });
  return true; // async sendResponse
});
