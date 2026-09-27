/**
 * openLN card writer — front-end for the local card bridge.
 *
 * Drives NTAG424 DNA programming (write / wipe / info) through whichever
 * bridge channel is present:
 *   1. the Chrome extension (window.openlnBridge), or
 *   2. the bridge's local HTTP API (same origin, or http://127.0.0.1:17777).
 *
 * All card cryptography runs here, in your browser, in the engine modules
 * under /engine. The bridge is only a wire to the reader.
 */

import { writeBoltCard, wipeBoltCard, tapSelfTest, readCardInfo, generateKeys } from "./engine/boltcard.js";

const $ = (sel) => document.querySelector(sel);

const state = {
  bridge: null,          // { kind, request(payload) }
  status: null,          // last /api/status payload
  serverBase: localStorage.getItem("openln.server") || "https://openln.com",
  token: localStorage.getItem("openln.token") || "",
  pending: null,         // normalized write data
  pendingWipe: null,     // normalized wipe data
  busy: false,
};

// ── small helpers ───────────────────────────────────────────────────────────

const short = (h, n = 12) => (h && h.length > n ? `${h.slice(0, n)}…` : h || "");
const isHex = (s, len) => new RegExp(`^[0-9a-fA-F]{${len}}$`).test(s || "");
const errText = (e) => (e && e.message ? e.message : String(e));
// All dynamic values interpolated into innerHTML go through this.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function logTo(el, text, cls = "") {
  el.hidden = false;
  const line = document.createElement("div");
  if (cls) line.className = cls;
  line.textContent = text;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}
function clearLog(el) { el.textContent = ""; el.hidden = true; }

function showResult(el, html, cls = "ok") {
  el.hidden = false;
  el.className = `result ${cls}`;
  el.innerHTML = html;
}

// ── bridge detection + request plumbing ─────────────────────────────────────

function httpRequest(base) {
  const post = async (path, body) => {
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body || {}),
    });
    return res.json();
  };
  return async (payload) => {
    const cmd = payload.cmd;
    if (cmd === "status") return fetch(base + "/api/status", { cache: "no-store" }).then((r) => r.json());
    if (cmd === "transceive") return post("/api/transceive", { apdu: payload.apdu });
    if (cmd === "uid") return post("/api/uid", {});
    if (cmd === "sim_reset") return post("/api/sim/reset", { uid: payload.uid, keys: payload.keys });
    if (cmd === "sim_state") return fetch(base + "/api/sim/state", { cache: "no-store" }).then((r) => r.json());
    if (cmd === "openln_api") return post("/api/openln", payload);
    return { ok: false, error: `unsupported command ${cmd}` };
  };
}

async function detectBridge() {
  if (window.openlnBridge && typeof window.openlnBridge.request === "function") {
    return { kind: "extension", request: (p) => window.openlnBridge.request(p) };
  }
  const candidates = [];
  if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(location.origin)) candidates.push(location.origin);
  const saved = localStorage.getItem("openln.cb.url");
  if (saved) candidates.push(saved.replace(/\/+$/, ""));
  const dflt = "http://127.0.0.1:17777";
  if (!candidates.includes(dflt)) candidates.push(dflt);
  for (const base of candidates) {
    try {
      const res = await fetch(base + "/api/status", { cache: "no-store" });
      if (!res.ok) continue;
      const body = await res.json();
      if (body && body.ok) return { kind: "http", base, request: httpRequest(base) };
    } catch { /* try next */ }
  }
  return null;
}

async function bridgeRequest(payload) {
  if (!state.bridge) throw new Error("card bridge not found. Start it or install the extension (see Setup).");
  const res = await state.bridge.request(payload);
  if (!res || !res.ok) throw new Error((res && res.error) || "bridge error");
  return res;
}

const transport = () => ({
  transceive: async (apdu) => {
    const hex = [...apdu].map((b) => b.toString(16).padStart(2, "0")).join("");
    const res = await bridgeRequest({ cmd: "transceive", apdu: hex });
    const out = new Uint8Array(res.response.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(res.response.substr(i * 2, 2), 16);
    return out;
  },
});

// ── openLN API (routed through the bridge: no CORS, token stays local) ─────

async function apiGet(path, token) {
  const url = `${state.serverBase.replace(/\/+$/, "")}${path}`;
  const res = await bridgeRequest({ cmd: "openln_api", url, method: "GET", token });
  if (res.status >= 400) {
    const msg = (res.json && (res.json.error || res.json.message)) || res.text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json;
}

async function apiPost(path, token) {
  const url = `${state.serverBase.replace(/\/+$/, "")}${path}`;
  const res = await bridgeRequest({ cmd: "openln_api", url, method: "POST", token });
  if (res.status >= 400) {
    const msg = (res.json && (res.json.error || res.json.message)) || res.text || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return res.json;
}

// ── data normalization ──────────────────────────────────────────────────────

function normalizeProvision(raw) {
  const d = raw && raw.card && typeof raw.card === "object" ? raw.card : raw || {};
  const keys = { k0: d.k0, k1: d.k1, k2: d.k2, k3: d.k3, k4: d.k4 };
  for (const k of ["k0", "k1", "k2", "k3", "k4"]) {
    if (!isHex(keys[k], 32)) throw new Error(`card data is missing a valid ${k} key`);
    keys[k] = keys[k].toLowerCase();
  }
  let base = d.lnurlwBase || d.lnurlw_base || d.lnurlw || "";
  if (!base && typeof d.lnurlwTemplate === "string") base = d.lnurlwTemplate.split("?")[0];
  return {
    cardId: d.cardId || d.id || null,
    name: d.name || d.card_name || null,
    lnurlwBase: base || null,
    keys,
    ndefFileHex: /^[0-9a-f]+$/i.test(d.ndefFile || "") ? d.ndefFile.toLowerCase() : null,
    sdmSettingsHex: /^[0-9a-f]+$/i.test(d.sdmSettings || "") ? d.sdmSettings.toLowerCase() : null,
    uidPrivacy: String(d.uid_privacy ?? d.uidPrivacy ?? "N").toUpperCase() === "Y",
    raw,
  };
}

function normalizeWipeKeys(raw) {
  const d = (raw && raw.wipeKeys) || raw || {};
  const keys = { k0: d.k0, k1: d.k1, k2: d.k2, k3: d.k3, k4: d.k4 };
  for (const k of ["k0", "k1", "k2", "k3", "k4"]) {
    if (!isHex(keys[k], 32)) throw new Error(`wipe keys are missing a valid ${k}`);
    keys[k] = keys[k].toLowerCase();
  }
  const factory = /^[0-9a-f]+$/i.test(d.factorySettings || "") ? d.factorySettings.toLowerCase() : null;
  return {
    cardId: d.cardId || (raw && raw.cardId) || null,
    keys,
    factorySettingsHex: factory,
    raw,
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

function renderWriteSummary() {
  const el = $("#write-summary");
  const p = state.pending;
  if (!p) {
    el.innerHTML = `<div class="empty-note">No card data loaded yet.</div>`;
    $("#btn-write").disabled = true;
    return;
  }
  const ndefInfo = p.ndefFileHex ? "server bytes" : (p.lnurlwBase ? "built from lnurlw base" : "missing");
  el.innerHTML = `
    <dt>Card</dt><dd>${p.name ? `${esc(p.name)} · ` : ""}${esc(p.cardId) || "manual entry"}</dd>
    <dt>lnurlw</dt><dd>${esc(p.lnurlwBase) || "missing"}</dd>
    <dt>Keys</dt><dd>${["k0", "k1", "k2", "k3", "k4"].map((k) => `${k} ${esc(short(p.keys[k], 8))}`).join("<br/>")}</dd>
    <dt>NDEF</dt><dd>${ndefInfo}</dd>
    <dt>Random UID</dt><dd>${p.uidPrivacy ? "requested by server" : "off"}</dd>`;
  $("#btn-write").disabled = !p.lnurlwBase || state.busy;
}

function renderWipeSummary() {
  const el = $("#wipe-summary");
  const w = state.pendingWipe;
  if (!w) {
    el.innerHTML = `<div class="empty-note">No keys loaded yet.</div>`;
    $("#btn-wipe").disabled = true;
    return;
  }
  el.innerHTML = `
    <dt>Card</dt><dd>${esc(w.cardId) || "manual entry"}</dd>
    <dt>Keys</dt><dd>${["k0", "k1", "k2", "k3", "k4"].map((k) => `${k} ${esc(short(w.keys[k], 8))}`).join("<br/>")}</dd>
    <dt>Factory settings</dt><dd>${esc(w.factorySettingsHex) || "default 40e0ee01ffff"}</dd>`;
  $("#btn-wipe").disabled = state.busy;
}

function renderBridgeStatus() {
  const dot = $("#bridge-dot");
  const label = $("#bridge-label");
  const st = state.status;
  if (!state.bridge || !st) {
    dot.className = "dot bad";
    label.textContent = "no bridge found";
    $("#footer-bridge").textContent = "";
    return;
  }
  if (st.sim) {
    dot.className = "dot sim";
    label.textContent = "simulator";
  } else {
    dot.className = "dot ok";
    label.textContent = st.reader ? short(st.reader, 42) : "reader ready";
  }
  $("#footer-bridge").textContent = `bridge v${st.bridge} · ${st.kind || state.bridge.kind} · ${st.mode}`;

  const el = $("#setup-status");
  el.innerHTML = `
    <dt>Channel</dt><dd>${esc(state.bridge.kind)}</dd>
    <dt>Transport</dt><dd>${esc(st.mode)}${st.sim ? " (simulation)" : ""}</dd>
    <dt>Reader</dt><dd>${esc(st.reader) || "none"}</dd>
    <dt>Readers found</dt><dd>${(st.readers || []).length}</dd>
    ${st.note ? `<dt>Note</dt><dd>${esc(st.note)}</dd>` : ""}`;
  $("#sim-box").hidden = !st.sim;
}

// ── guard for concurrent operations ─────────────────────────────────────────

function setBusy(v) {
  state.busy = v;
  renderWriteSummary();
  renderWipeSummary();
  for (const id of ["#btn-next", "#btn-parse", "#btn-manual", "#btn-wipe-fetch", "#btn-wipe-manual", "#btn-info", "#btn-sim-reset"]) {
    $(id).disabled = v;
  }
  const w = $("#btn-write");
  w.textContent = v && !w.hidden ? "Working…" : "Write card";
}

// ── write tab ───────────────────────────────────────────────────────────────

async function loadNextProvision() {
  const token = $("#device-token").value.trim();
  if (!isHex(token, 64)) return showResult($("#write-result"), "Device token must be exactly 64 hex characters.", "err");
  state.token = token;
  localStorage.setItem("openln.token", token);
  $("#write-result").hidden = true;
  clearLog($("#write-log"));
  logTo($("#write-log"), `fetching next card from ${state.serverBase} …`);
  try {
    const json = await apiGet("/api/pos/next-provision", token);
    state.pending = normalizeProvision(json);
    $("#opt-rid").checked = false;
    logTo($("#write-log"), `card received: ${state.pending.cardId}`, "ok");
    renderWriteSummary();
  } catch (e) {
    logTo($("#write-log"), `fetch failed: ${errText(e)}`, "err");
    showResult($("#write-result"), `Could not fetch a card. ${esc(errText(e))}`, "err");
  }
}

async function loadProvisionInput() {
  const raw = $("#provision-input").value.trim();
  if (!raw) return;
  $("#write-result").hidden = true;
  clearLog($("#write-log"));
  try {
    let data;
    if (raw.startsWith("{")) {
      data = JSON.parse(raw);
    } else if (/^https?:\/\//.test(raw)) {
      logTo($("#write-log"), "fetching provision data …");
      data = await apiGet(new URL(raw).pathname + new URL(raw).search, null);
    } else {
      throw new Error("paste a provision link or a JSON payload");
    }
    state.pending = normalizeProvision(data);
    $("#opt-rid").checked = state.pending.uidPrivacy;
    logTo($("#write-log"), "card data loaded", "ok");
    renderWriteSummary();
  } catch (e) {
    logTo($("#write-log"), `load failed: ${errText(e)}`, "err");
    showResult($("#write-result"), `Could not load that. ${esc(errText(e))}`, "err");
  }
}

function loadManualKeys() {
  $("#write-result").hidden = true;
  try {
    const keys = {};
    for (const k of ["k0", "k1", "k2", "k3", "k4"]) {
      const v = $(`#manual-${k}`).value.trim().toLowerCase();
      if (!isHex(v, 32)) throw new Error(`${k} must be 32 hex characters`);
      keys[k] = v;
    }
    const base = $("#manual-base").value.trim();
    if (base && !/^lnurlw:\/\//.test(base)) throw new Error("lnurlw base should start with lnurlw://");
    state.pending = { cardId: null, name: "manual", lnurlwBase: base || null, keys, ndefFileHex: null, sdmSettingsHex: null, uidPrivacy: $("#opt-rid").checked, raw: null };
    renderWriteSummary();
    clearLog($("#write-log"));
    logTo($("#write-log"), "manual card data loaded", "ok");
  } catch (e) {
    showResult($("#write-result"), esc(errText(e)), "err");
  }
}

async function doWrite() {
  const p = state.pending;
  if (!p) return;
  setBusy(true);
  $("#write-result").hidden = true;
  clearLog($("#write-log"));
  logTo($("#write-log"), `writing ${p.cardId || "manual card"} …`);
  try {
    const res = await writeBoltCard({
      transport: transport(),
      lnurlwBase: p.lnurlwBase,
      keys: p.keys,
      ndefFileHex: p.ndefFileHex,
      sdmSettingsHex: p.sdmSettingsHex,
      randomUid: $("#opt-rid").checked,
      onProgress: (s) => logTo($("#write-log"), `· ${s}`),
    });
    logTo($("#write-log"), "card written and keys verified against the chip", "ok");
    const actions = [`<button id="btn-verify" class="ghost">Verify (tap check)</button>`];
    if (p.cardId && state.token) actions.push(`<button id="btn-mark-written" class="ghost">Mark written in openLN</button>`);
    actions.push(`<button id="btn-write-again" class="ghost">Write another</button>`);
    showResult($("#write-result"), `<strong>Card written.</strong><br/>UID <code>${esc(res.uid)}</code><div class="actions">${actions.join("")}</div>`);
    if ($("#btn-verify")) $("#btn-verify").onclick = () => verifyTap(p);
    if ($("#btn-mark-written")) $("#btn-mark-written").onclick = () => markWritten(p);
    if ($("#btn-write-again")) $("#btn-write-again").onclick = () => { state.pending = null; renderWriteSummary(); $("#write-result").hidden = true; clearLog($("#write-log")); };
  } catch (e) {
    logTo($("#write-log"), `write failed: ${errText(e)}`, "err");
    showResult($("#write-result"), `Write failed. ${esc(errText(e))}`, "err");
  } finally {
    setBusy(false);
  }
}

async function verifyTap(p) {
  clearLog($("#write-log"));
  logTo($("#write-log"), "reading the card the way a phone would (SDM tap check) …");
  try {
    const t = await tapSelfTest({ transport: transport(), keys: p.keys });
    if (t.ok) {
      logTo($("#write-log"), `p= decrypts with k1, c= verifies with k2`, "ok");
      logTo($("#write-log"), `uid ${t.uid} · counter ${t.counter}`);
      logTo($("#write-log"), `url ${t.uri || ""}`);
    } else {
      logTo($("#write-log"), `verification failed: ${t.reason}`, "err");
    }
  } catch (e) {
    logTo($("#write-log"), `tap check error: ${errText(e)}`, "err");
  }
}

async function markWritten(p) {
  clearLog($("#write-log"));
  try {
    await apiPost(`/api/pos/mark-written/${p.cardId}`, state.token);
    logTo($("#write-log"), "marked written on the server", "ok");
  } catch (e) {
    logTo($("#write-log"), `mark-written failed: ${errText(e)}`, "err");
  }
}

// ── wipe tab ────────────────────────────────────────────────────────────────

async function fetchWipeKeys() {
  const cardId = $("#wipe-card-id").value.trim();
  const token = $("#wipe-token").value.trim() || state.token;
  $("#wipe-result").hidden = true;
  clearLog($("#wipe-log"));
  try {
    if (!cardId) throw new Error("enter the card id first");
    if (!isHex(token, 64)) throw new Error("need a 64 character device token to fetch keys");
    logTo($("#wipe-log"), `fetching wipe keys for ${cardId} …`);
    const json = await apiGet(`/api/pos/wipe-keys/${cardId}`, token);
    state.pendingWipe = normalizeWipeKeys(json);
    logTo($("#wipe-log"), "keys received", "ok");
    renderWipeSummary();
  } catch (e) {
    logTo($("#wipe-log"), `fetch failed: ${errText(e)}`, "err");
    showResult($("#wipe-result"), `Could not fetch wipe keys. ${esc(errText(e))}`, "err");
  }
}

function useManualWipeKeys() {
  $("#wipe-result").hidden = true;
  try {
    const keys = {};
    for (const k of ["k0", "k1", "k2", "k3", "k4"]) {
      const v = $(`#wipe-${k}`).value.trim().toLowerCase();
      if (!isHex(v, 32)) throw new Error(`${k} must be 32 hex characters`);
      keys[k] = v;
    }
    state.pendingWipe = { cardId: $("#wipe-card-id").value.trim() || null, keys, factorySettingsHex: null, raw: null };
    renderWipeSummary();
    clearLog($("#wipe-log"));
    logTo($("#wipe-log"), "manual wipe keys loaded", "ok");
  } catch (e) {
    showResult($("#wipe-result"), esc(errText(e)), "err");
  }
}

async function doWipe() {
  const w = state.pendingWipe;
  if (!w) return;
  setBusy(true);
  $("#wipe-result").hidden = true;
  clearLog($("#wipe-log"));
  logTo($("#wipe-log"), "wiping card …");
  try {
    await wipeBoltCard({
      transport: transport(),
      keys: w.keys,
      factorySettingsHex: w.factorySettingsHex,
      onProgress: (s) => logTo($("#wipe-log"), `· ${s}`),
    });
    logTo($("#wipe-log"), "chip reset to factory keys, NDEF cleared", "ok");
    const actions = [];
    if (w.cardId && (state.token || $("#wipe-token").value.trim())) actions.push(`<button id="btn-mark-wiped" class="ghost">Mark wiped in openLN</button>`);
    actions.push(`<button id="btn-wipe-again" class="ghost">Wipe another</button>`);
    showResult($("#wipe-result"), `<strong>Card wiped.</strong> The chip can be programmed again.<div class="actions">${actions.join("")}</div>`);
    if ($("#btn-mark-wiped")) $("#btn-mark-wiped").onclick = async () => {
      clearLog($("#wipe-log"));
      try {
        await apiPost(`/api/pos/mark-wiped/${w.cardId}`, $("#wipe-token").value.trim() || state.token);
        logTo($("#wipe-log"), "marked wiped on the server (card set to cancelled)", "ok");
      } catch (e) {
        logTo($("#wipe-log"), `mark-wiped failed: ${errText(e)}`, "err");
      }
    };
    if ($("#btn-wipe-again")) $("#btn-wipe-again").onclick = () => { state.pendingWipe = null; renderWipeSummary(); $("#wipe-result").hidden = true; clearLog($("#wipe-log")); };
  } catch (e) {
    logTo($("#wipe-log"), `wipe failed: ${errText(e)}`, "err");
    showResult($("#wipe-result"), `Wipe failed. ${esc(errText(e))}`, "err");
  } finally {
    setBusy(false);
  }
}

// ── info tab ────────────────────────────────────────────────────────────────

async function readInfo() {
  clearLog($("#info-log"));
  $("#info-result").hidden = true;
  const k0 = $("#info-k0").value.trim().toLowerCase();
  try {
    if (k0 && !isHex(k0, 32)) throw new Error("k0 must be 32 hex characters");
    logTo($("#info-log"), "reading card …");
    const keys = k0 ? { k0 } : null;
    const info = await readCardInfo({ transport: transport(), keys });
    logTo($("#info-log"), info.authed ? "master key verified" : "no key check (k0 not provided)", info.authed ? "ok" : "");
    const rows = [
      ["UID", info.uid || "· (needs k0)"],
      ["URI", info.uri || "· none"],
      ["Version", JSON.stringify(info.version)],
      ["Key versions", JSON.stringify(info.keyVersions)],
    ];
    showResult($("#info-result"), rows.map(([k, v]) => `<strong>${k}</strong> <code>${esc(v)}</code>`).join("<br/>"));
    if (info.errors && info.errors.length) for (const e of info.errors) logTo($("#info-log"), e);
  } catch (e) {
    logTo($("#info-log"), `read failed: ${errText(e)}`, "err");
  }
}

// ── setup + init ────────────────────────────────────────────────────────────

function saveSetup() {
  state.serverBase = $("#setup-server").value.trim() || "https://openln.com";
  localStorage.setItem("openln.server", state.serverBase);
  const tok = $("#setup-token").value.trim();
  if (tok) {
    state.token = tok;
    localStorage.setItem("openln.token", tok);
    $("#device-token").value = tok;
    $("#wipe-token").value = tok;
  }
  clearLog($("#write-log"));
  logTo($("#write-log"), "settings saved", "ok");
}

async function resetSim() {
  try {
    await bridgeRequest({ cmd: "sim_reset" });
    logTo($("#write-log"), "simulated card reset to factory state", "ok");
  } catch (e) {
    alert2(e);
  }
}
function alert2(e) { /* place errors visibly */ showResult($("#write-result"), esc(errText(e)), "err"); }

function initTabs() {
  for (const btn of document.querySelectorAll("#tabs button")) {
    btn.onclick = () => {
      for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("active", b === btn);
      for (const s of document.querySelectorAll(".tab")) s.hidden = s.id !== `tab-${btn.dataset.tab}`;
    };
  }
}

function initSources() {
  for (const radio of document.querySelectorAll('input[name="src"]')) {
    radio.onchange = () => {
      for (const pane of document.querySelectorAll(".src-pane")) pane.hidden = true;
      $(`#src-${radio.value}`).hidden = false;
    };
  }
  $("#btn-next").onclick = loadNextProvision;
  $("#btn-parse").onclick = loadProvisionInput;
  $("#btn-manual").onclick = loadManualKeys;
  $("#btn-write").onclick = doWrite;
  $("#btn-wipe-fetch").onclick = fetchWipeKeys;
  $("#btn-wipe-manual").onclick = useManualWipeKeys;
  $("#btn-wipe").onclick = doWipe;
  $("#btn-info").onclick = readInfo;
  $("#btn-save-setup").onclick = saveSetup;
  $("#btn-sim-reset").onclick = resetSim;
  $("#device-token").value = state.token;
  $("#wipe-token").value = state.token;
  $("#setup-server").value = state.serverBase;
  $("#setup-token").value = state.token;
  $("#device-token").oninput = (e) => { /* keep until user commits */ void e; };
}

async function init() {
  initTabs();
  initSources();
  state.bridge = await detectBridge();
  if (state.bridge) {
    try { state.status = await bridgeRequest({ cmd: "status" }); } catch { state.status = null; }
  }
  renderBridgeStatus();
  renderWriteSummary();
  renderWipeSummary();
}

init();
