/**
 * Extension-channel E2E: load the real MV3 extension in Chromium, open the
 * card writer page, and let it route everything through
 *   page → window.postMessage → content script → service worker
 *        → chrome.runtime.connectNative → bridge (stdio) → simulator.
 *
 * Proves the exact path merchant machines will use with the extension
 * installed, no local HTTP API needed for card I/O.
 */

import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

const BROWSER = process.env.CHROMIUM_FULL || "/usr/lib64/chromium-browser/chromium-browser";
const EXT = process.env.EXT_DIR || fileURLToPath(new URL("../../extension", import.meta.url));
const BASE = process.env.UI_BASE || "http://127.0.0.1:17777";
const OUT = process.env.SHOT_DIR || fileURLToPath(new URL("./shots", import.meta.url));
// Chromium resolves native-messaging host manifests inside the active profile
// when --user-data-dir is set, so the test profile gets its own manifest copy
// (a default-profile install has it in ~/.config/chromium/NativeMessagingHosts).
const PROFILE = process.env.UI_PROFILE || "/tmp/cw-ext-profile";
const HOST_MANIFEST = process.env.UI_HOST_MANIFEST || `${process.env.HOME}/.config/chromium/NativeMessagingHosts/com.openln.cardbridge.json`;

const KEYS = {
  k0: "000102030405060708090a0b0c0d0e0f",
  k1: "101112131415161718191a1b1c1d1e1f",
  k2: "202122232425262728292a2b2c2d2e2f",
  k3: "303132333435363738393a3b3c3d3e3f",
  k4: "404142434445464748494a4b4c4d4e4f",
};

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

rmSync(PROFILE, { recursive: true, force: true });
mkdirSync(`${PROFILE}/NativeMessagingHosts`, { recursive: true });
mkdirSync(OUT, { recursive: true });
if (existsSync(HOST_MANIFEST)) {
  copyFileSync(HOST_MANIFEST, `${PROFILE}/NativeMessagingHosts/com.openln.cardbridge.json`);
} else {
  console.error(`⚠ host manifest ${HOST_MANIFEST} not found — run install.sh first`);
}

const browser = await puppeteer.launch({
  executablePath: BROWSER,
  headless: true,
  userDataDir: PROFILE,
  args: [
    "--no-sandbox",
    "--disable-gpu",
    "--disable-dev-shm-usage",
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
  ],
  defaultViewport: { width: 1400, height: 1000 },
});

try {
  const page = await browser.newPage();
  const problems = [];
  page.on("pageerror", (e) => problems.push("exception: " + e.message));

  await page.goto(BASE + "/", { waitUntil: "networkidle0" });

  // the extension's MAIN-world content script must expose the bridge
  await page.waitForFunction(
    () => window.openlnBridge && window.openlnBridge.kind === "extension",
    { timeout: 20000 },
  );
  console.log("✓ window.openlnBridge present (extension channel)");

  // and it must reach the native host (status flows through native messaging)
  await waitText(page, "#bridge-label", "simulator", 20000);
  console.log("✓ bridge reachable through the extension (native messaging + sim fallback)");

  const channel = await page.$eval("#footer-bridge", (el) => el.textContent);
  assert.ok(channel.includes("extension"), `footer should name the extension channel: ${channel}`);
  await page.screenshot({ path: OUT + "/ui-5-extension.png" });

  // full write through the extension path
  await page.click('input[name="src"][value="manual"]');
  await setVal(page, "#manual-base", "lnurlw://openln.com/card/ext-demo");
  for (const k of ["k0", "k1", "k2", "k3", "k4"]) await setVal(page, `#manual-${k}`, KEYS[k]);
  await page.click("#btn-manual");
  await waitText(page, "#write-summary", "ext-demo");
  await page.click("#btn-write");
  await waitText(page, "#write-result", "Card written.", 30000);
  const uid = await page.$eval("#write-result code", (el) => el.textContent);
  console.log("✓ card written through extension → native messaging → bridge, uid:", uid);

  await page.click("#btn-verify");
  await waitText(page, "#write-log", "verifies with k2", 30000);
  console.log("✓ tap check passed through the extension channel");
  await page.screenshot({ path: OUT + "/ui-6-extension-written.png" });

  if (problems.length) {
    console.log("page problems:", problems);
    throw new Error("page reported errors");
  }
  console.log("\nEXTENSION E2E: all good");
} finally {
  await browser.close();
}
