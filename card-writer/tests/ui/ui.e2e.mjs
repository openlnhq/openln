/**
 * UI end-to-end: drive the real card writer page in a headless Chromium
 * against the live bridge + simulator. Captures screenshots along the way.
 *
 * Usage:
 *   node tests/ui/ui.e2e.mjs
 * with CHROMIUM / UI_BASE / SHOT_DIR env overrides. Starts its own bridge
 * (--http --sim) if none is running at UI_BASE.
 */

import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SHELL = process.env.CHROMIUM || "/usr/lib64/chromium-browser/headless_shell";
const BASE = process.env.UI_BASE || "http://127.0.0.1:17777";
const OUT = process.env.SHOT_DIR || fileURLToPath(new URL("./shots", import.meta.url));
const BRIDGE = new URL("../../bridge/openln-cardbridge.py", import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const KEYS = {
  k0: "000102030405060708090a0b0c0d0e0f",
  k1: "101112131415161718191a1b1c1d1e1f",
  k2: "202122232425262728292a2b2c2d2e2f",
  k3: "303132333435363738393a3b3c3d3e3f",
  k4: "404142434445464748494a4b4c4d4e4f",
};

async function bridgeUp() {
  try {
    const r = await fetch(BASE + "/api/status");
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureBridge() {
  if (await bridgeUp()) return null;
  const child = spawn("python3", [BRIDGE, "--http", "--sim"], { stdio: ["ignore", "ignore", "pipe"] });
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

// set an input's value and fire the input event (puppeteer has no page.fill)
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
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1400, height: 1000 },
});

try {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", (m) => {
    if (m.type() === "error") problems.push("console: " + m.text());
  });
  page.on("pageerror", (e) => problems.push("exception: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "networkidle0" });
  await waitText(page, "#bridge-label", "simulator");
  console.log("✓ bridge detected: simulator");
  await page.screenshot({ path: OUT + "/ui-1-landing.png" });

  // ── write via manual keys ──
  await page.click('input[name="src"][value="manual"]');
  await setVal(page, "#manual-base", "lnurlw://openln.com/card/demo-1234");
  for (const k of ["k0", "k1", "k2", "k3", "k4"]) await setVal(page, `#manual-${k}`, KEYS[k]);
  await page.click("#btn-manual");
  await waitText(page, "#write-summary", "demo-1234");
  console.log("✓ manual card data loaded into summary");

  await page.click("#btn-write");
  await waitText(page, "#write-result", "Card written.");
  const uid = await page.$eval("#write-result code", (el) => el.textContent);
  console.log("✓ card written via UI, uid:", uid);
  await page.screenshot({ path: OUT + "/ui-2-written.png" });

  const state1 = await (await fetch(BASE + "/api/sim/state")).json();
  assert.equal(state1.state.keys[0], KEYS.k0, "sim chip must hold the written k0");
  assert.equal(state1.state.sdm, true, "SDM must be enabled");

  await page.click("#btn-verify");
  await waitText(page, "#write-log", "verifies with k2");
  console.log("✓ tap check passed in UI (p= and c= verify)");
  await page.screenshot({ path: OUT + "/ui-3-verified.png" });

  // ── wipe via manual keys ──
  await page.click('#tabs button[data-tab="wipe"]');
  await page.type("#wipe-card-id", "demo-1234");
  await page.click("details.manual summary");
  for (const k of ["k0", "k1", "k2", "k3", "k4"]) await setVal(page, `#wipe-${k}`, KEYS[k]);
  await page.click("#btn-wipe-manual");
  await waitText(page, "#wipe-summary", "demo-1234");
  await page.click("#btn-wipe");
  await waitText(page, "#wipe-result", "Card wiped.");
  console.log("✓ card wiped via UI");
  await page.screenshot({ path: OUT + "/ui-4-wiped.png" });

  const state2 = await (await fetch(BASE + "/api/sim/state")).json();
  assert.equal(state2.state.keys[0], "0".repeat(32), "chip must be back to factory keys");
  assert.equal(state2.state.ndef, "0005d101015500", "chip NDEF must be cleared");
  console.log("✓ sim chip verified: factory keys, empty NDEF");

  if (problems.length) {
    console.log("page problems:", problems);
    throw new Error("page reported errors");
  }
  console.log("\nUI E2E: all good (screenshots in " + OUT + ")");
} finally {
  await browser.close();
  if (spawned) spawned.kill();
}
