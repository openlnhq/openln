/**
 * App-integrated card writer E2E: drives the openLN merchant app (Cards tab)
 * in a headless Chromium against a running openLN server + the local bridge
 * (simulator). Flow: register -> issue card -> Write to card -> Verify tap ->
 * Wipe card -> assert chip + server state. Screenshots land in SHOT_DIR.
 *
 * Usage:
 *   APP_BASE=http://127.0.0.1:3181 node tests/ui/app-write.e2e.mjs
 *
 * Note: page.evaluate() below is Puppeteer's API for running small functions
 * inside the browser page (standard test automation); it is not JS eval.
 */

import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHELL = process.env.CHROMIUM || "/usr/lib64/chromium-browser/headless_shell";
const APP = process.env.APP_BASE || "http://127.0.0.1:3181";
const BRIDGE = process.env.BRIDGE_BASE || "http://127.0.0.1:17777";
const OUT = process.env.SHOT_DIR || fileURLToPath(new URL("./shots", import.meta.url));
const HANDLE = process.env.APP_HANDLE || "uitest";
const PASSWORD = process.env.APP_PASSWORD || "uitest-pass-1234";
mkdirSync(OUT, { recursive: true });

const BRIDGE_PY = fileURLToPath(new URL("../../bridge/openln-cardbridge.py", import.meta.url));

async function bridgeUp() {
  try {
    const r = await fetch(BRIDGE + "/api/status");
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureBridge() {
  if (await bridgeUp()) return null;
  const child = spawn("python3", [BRIDGE_PY, "--http", "--sim"], { stdio: ["ignore", "ignore", "pipe"] });
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await bridgeUp()) return child;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("bridge did not start");
}

const waitText = async (page, sel, text, timeout = 30000) => {
  await page.waitForFunction(
    (s, t) => {
      const el = document.querySelector(s);
      return el && el.textContent.includes(t);
    },
    { timeout },
    sel,
    text,
  );
};

const setVal = (page, sel, v) =>
  page.$eval(
    sel,
    (el, value) => {
      el.value = value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
    },
    v,
  );

const spawned = await ensureBridge();
const browser = await puppeteer.launch({
  executablePath: SHELL,
  // DISABLE_LNA=1 relaxes Chrome's local network access check for http://127.0.0.1
  // when testing against a remote https origin (the browser would normally prompt).
  args: ["--no-sandbox", "--disable-gpu", ...(process.env.DISABLE_LNA ? ["--disable-features=LocalNetworkAccessChecks"] : [])],
  defaultViewport: { width: 1400, height: 1050 },
});

try {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    // Resource-load failures are tracked below with their URLs.
    if (t.includes("favicon") || t.startsWith("Failed to load resource")) return;
    problems.push("console: " + t);
  });
  page.on("pageerror", (e) => problems.push("exception: " + e.message));
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (u.includes("/api/auth/register") && r.status() === 400) return; // handle already exists on re-runs
    if (u.includes("/api/admin/payments/treasury") && r.status() === 403) return; // the app's own non-admin probe
    problems.push("http " + r.status() + " " + u.slice(0, 140));
  });

  await fetch(BRIDGE + "/api/sim/reset", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });

  // ── auth: register on first run, login afterwards ──
  await page.goto(APP + "/app", { waitUntil: "domcontentloaded" });
  const auth = await page.evaluate(
    async ({ h, p }) => {
      const post = async (url, body) => {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json().catch(() => ({})) };
      };
      let r = await post("/api/auth/register", { handle: h, password: p });
      if (r.status !== 201) r = await post("/api/auth/login", { handle: h, password: p });
      return r;
    },
    { h: HANDLE, p: PASSWORD },
  );
  assert.ok(auth.body && auth.body.token, "auth token expected, got " + JSON.stringify(auth));
  await page.evaluate((t) => localStorage.setItem("openln_token", t), auth.body.token);
  console.log("✓ authenticated as", HANDLE);

  // ── cards view (fresh document load: /app -> /app#cards is only a hash change) ──
  await page.goto(APP + "/app#cards", { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#issueCardTile", { timeout: 20000 });
  console.log("✓ cards view rendered");

  // ── issue a card ──
  const before = await page.evaluate(async () => {
    const me = await api("/api/me");
    return (await api("/api/accounts/" + me.account.id + "/cards")).map((c) => c.id);
  });
  await page.click("#issueCardTile");
  await setVal(page, '#cardIssue input[name="name"]', "Sim card");
  await setVal(page, '#cardIssue input[name="pin"]', "1234");
  await page.click("#cardIssue button");
  await page.waitForSelector("#cwGo", { timeout: 25000 });
  console.log("✓ issue modal opened and the reader helper was detected");
  await page.screenshot({ path: OUT + "/app-1-issue.png" });

  // ── write from inside the app ──
  await page.click("#cwGo");
  await page.waitForSelector("#cwDone", { timeout: 40000 });
  const writeLog = await page.$eval("#cwLog", (el) => el.textContent);
  assert.ok(writeLog.includes("Card written"), "write log: " + writeLog);
  console.log("✓ card written from the app");
  await page.screenshot({ path: OUT + "/app-2-written.png" });

  const card = await page.evaluate(async (ids) => {
    const me = await api("/api/me");
    const cards = await api("/api/accounts/" + me.account.id + "/cards");
    return cards.find((c) => !ids.includes(c.id));
  }, before);
  assert.ok(card, "the newly issued card must appear in the list");
  const keys = await page.evaluate(async (id) => api("/api/cards/" + id + "/keys", { method: "POST", body: "{}" }), card.id);
  let state = await (await fetch(BRIDGE + "/api/sim/state")).json();
  assert.equal(state.state.sdm, true, "SDM must be enabled on the chip");
  assert.equal(state.state.keys[0], keys.k0, "chip k0 must match the card record");
  assert.equal(state.state.keys[1], keys.k1, "chip k1 must match the card record");
  assert.equal(state.state.keys[2], keys.k2, "chip k2 must match the card record");
  console.log("✓ sim chip holds the card record keys (k0/k1/k2), SDM on");

  // ── tap verification from the app ──
  await page.click("#cwVerify");
  await waitText(page, "#cwLog", "Tap check OK", 30000);
  console.log("✓ tap check passed in the app");
  await page.screenshot({ path: OUT + "/app-3-verified.png" });

  // ── done: list shows the card as written ──
  await page.click("#cwDone");
  await page.waitForSelector("#issueCardTile", { timeout: 15000 });
  await waitText(page, ".cardsgrid", "Active", 15000);
  console.log("✓ card list shows Active after the write");

  // ── wipe from inside the app ──
  await page.click('.cardsgrid .cardtile[data-card-id="' + card.id + '"]');
  await page.waitForSelector("#wipeCard", { timeout: 15000 });
  await page.click("#wipeCard");
  await page.waitForSelector("#wipeHere", { timeout: 25000 });
  await page.screenshot({ path: OUT + "/app-4-wipe-dialog.png" });
  await page.click("#wipeHere");
  await page.waitForFunction(() => !document.querySelector("#wipeHere"), { timeout: 40000 });
  await page.waitForSelector("#issueCardTile", { timeout: 15000 });
  await waitText(page, ".cardsgrid", "Cancelled", 15000);
  console.log("✓ card wiped and cancelled from the app");
  await page.screenshot({ path: OUT + "/app-5-wiped.png" });

  state = await (await fetch(BRIDGE + "/api/sim/state")).json();
  assert.equal(state.state.keys[0], "0".repeat(32), "chip k0 must be back to factory");
  assert.equal(state.state.ndef, "0005d101015500", "chip NDEF must be cleared");
  console.log("✓ sim chip verified: factory keys, empty NDEF");

  const finalCard = await page.evaluate(async (id) => {
    const me = await api("/api/me");
    const cards = await api("/api/accounts/" + me.account.id + "/cards");
    return cards.find((c) => c.id === id);
  }, card.id);
  assert.equal(finalCard.status, "cancelled", "card record must be cancelled");
  assert.ok(finalCard.lastUsedAt, "mark-written should have set lastUsedAt");
  console.log("✓ server state: cancelled, write recorded");

  if (problems.length) {
    console.log("page problems:", problems);
    throw new Error("page reported errors");
  }
  console.log("\nAPP WRITE E2E: all good (screenshots in " + OUT + ")");
} finally {
  await browser.close();
  if (spawned) spawned.kill();
}
