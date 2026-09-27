/**
 * Phone (Web NFC) card writer E2E: drives the openLN merchant app on an
 * Android-style flow. Chrome's NFC radio cannot exist in a headless test, so
 * `NDEFReader` is stubbed BEFORE the app loads; the stub records every write
 * the app performs and replays reads for the Check card button. Everything
 * else is real: the app UI, the server, the tap endpoint, the database.
 *
 * Flow: register -> issue -> Write card (phone pane) -> assert the NDEF the
 * app pushed -> tap the card on the server -> Check card -> wipe (phone pane)
 * -> assert empty NDEF write -> cancelled. Screenshots land in SHOT_DIR.
 *
 * Usage:
 *   APP_BASE=http://127.0.0.1:3181 node tests/ui/app-phone.e2e.mjs
 */

import puppeteer from "puppeteer-core";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Note: page.evaluate()/$eval below are Puppeteer's API for running small
// functions inside the browser page (standard test automation); they are not
// JS eval of untrusted input.

const SHELL = process.env.CHROMIUM || "/usr/lib64/chromium-browser/headless_shell";
const APP = process.env.APP_BASE || "http://127.0.0.1:3181";
const OUT = process.env.SHOT_DIR || fileURLToPath(new URL("./shots-phone", import.meta.url));
const HANDLE = process.env.APP_HANDLE || "uitest";
const PASSWORD = process.env.APP_PASSWORD || "uitest-pass-1234";
mkdirSync(OUT, { recursive: true });

const Z = "0".repeat(32), ZC = "0".repeat(16), ZK = "0".repeat(64);

const waitText = async (page, sel, text, timeout = 30000) => {
  await page.waitForFunction(
    (s, t) => { const el = document.querySelector(s); return el && el.textContent.includes(t); },
    { timeout }, sel, text,
  );
};
const setVal = (page, sel, v) =>
  page.$eval(sel, (el, value) => { el.value = value; el.dispatchEvent(new Event("input", { bubbles: true })); }, v);

const browser = await puppeteer.launch({
  executablePath: SHELL,
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 420, height: 900 }, // phone-ish viewport
});

try {
  const page = await browser.newPage();
  const problems = [];
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const t = m.text();
    if (t.includes("favicon") || t.startsWith("Failed to load resource")) return;
    problems.push("console: " + t);
  });
  page.on("pageerror", (e) => problems.push("exception: " + e.message));
  page.on("response", (r) => {
    if (r.status() < 400) return;
    const u = r.url();
    if (u.includes("/api/auth/register") && r.status() === 400) return;
    if (u.includes("/api/admin/payments/treasury") && r.status() === 403) return;
    problems.push("http " + r.status() + " " + u.slice(0, 140));
  });

  // ── stub Chrome's Web NFC radio before any app script runs ──
  await page.evaluateOnNewDocument(() => {
    window.__nfc = { writes: [], lastUrl: null };
    window.__nfcFail = null;
    class FakeNDEFReader {
      write(message) {
        if (window.__nfcFail) return Promise.reject(Object.assign(new Error(window.__nfcFail), { name: "NotAllowedError" }));
        const recs = (message && message.records) || [];
        window.__nfc.writes.push({ records: recs.map((r) => ({ recordType: r.recordType, data: r.data })) });
        const urlRec = recs.find((r) => r.recordType === "url" || r.recordType === "absolute-url");
        window.__nfc.lastUrl = urlRec ? urlRec.data : null;
        return new Promise((res) => setTimeout(res, 80));
      }
      scan() {
        const self = this;
        return new Promise((resolve) => {
          setTimeout(() => {
            resolve();
            setTimeout(() => { if (self.onreading) self.onreading({ message: { records: [{ recordType: "absolute-url", data: window.__nfc.lastUrl }] } }); }, 80);
          }, 40);
        });
      }
    }
    window.NDEFReader = FakeNDEFReader;
  });

  // ── auth ──
  await page.goto(APP + "/app", { waitUntil: "domcontentloaded" });
  const auth = await page.evaluate(async ({ h, p }) => {
    const post = async (url, body) => {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    let r = await post("/api/auth/register", { handle: h, password: p });
    if (r.status !== 201) r = await post("/api/auth/login", { handle: h, password: p });
    return r;
  }, { h: HANDLE, p: PASSWORD });
  assert.ok(auth.body && auth.body.token, "auth token expected, got " + JSON.stringify(auth));
  await page.evaluate((t) => localStorage.setItem("openln_token", t), auth.body.token);
  console.log("✓ authenticated as", HANDLE);

  await page.goto(APP + "/app#cards", { waitUntil: "domcontentloaded" });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector("#issueCardTile", { timeout: 20000 });

  // ── issue a card: the modal must open on the phone pane ──
  const before = await page.evaluate(async () => {
    const me = await api("/api/me");
    return (await api("/api/accounts/" + me.account.id + "/cards")).map((c) => c.id);
  });
  await page.click("#issueCardTile");
  await setVal(page, '#cardIssue input[name="name"]', "Phone card");
  await setVal(page, '#cardIssue input[name="pin"]', "1234");
  await page.click("#cardIssue button");
  await page.waitForSelector("#computerTab", { timeout: 25000 });
  const tabText = await page.$eval("#computerTab", (el) => el.textContent.trim());
  assert.equal(tabText, "This phone", "the writer tab must say This phone when Web NFC exists");
  await page.waitForSelector("#cwNfcGo", { timeout: 25000 });
  assert.ok(!(await page.$("#cwGo")), "the desktop helper button must not be present on the phone flow");
  console.log("✓ issue modal opened on the phone (Web NFC) pane");
  await page.screenshot({ path: OUT + "/app-1-issue.png" });

  // ── write from the phone ──
  await page.click("#cwNfcGo");
  await page.waitForSelector("#cwNfcDone", { timeout: 30000 });
  await waitText(page, "#cwNfcLog", "Card written", 15000);
  console.log("✓ card written from the phone pane");

  const card = await page.evaluate(async (ids) => {
    const me = await api("/api/me");
    const cards = await api("/api/accounts/" + me.account.id + "/cards");
    return cards.find((c) => !ids.includes(c.id));
  }, before);
  assert.ok(card, "the newly issued card must appear in the list");

  const nfc = await page.evaluate(() => window.__nfc);
  assert.equal(nfc.writes.length, 1, "exactly one NDEF write so far");
  assert.equal(nfc.writes[0].records.length, 1, "one record written");
  assert.equal(nfc.writes[0].records[0].recordType, "absolute-url", "written as an absolute-url record");
  const expectedUrl = await page.evaluate(async (id) => (await api("/api/cards/" + id + "/nfc-url", { method: "POST", body: "{}" })).url, card.id);
  assert.match(expectedUrl, new RegExp("^lnurlw://[^/]+/card/" + card.id + "\\?p=" + Z + "&c=" + ZC + "$"), "server link shape");
  assert.equal(nfc.writes[0].records[0].data, expectedUrl, "the NDEF must carry the exact placeholder link");
  console.log("✓ NDEF written to the chip:", expectedUrl.slice(0, 60) + "…");

  // ── the server accepts the phone-written card: tap it ──
  const tap = await (await fetch(APP + "/card/" + card.id + "?p=" + Z + "&c=" + ZC)).json();
  assert.equal(tap.tag, "withdrawRequest", "a web-card tap must return a withdraw request: " + JSON.stringify(tap));
  assert.match(tap.k1, /^[0-9a-f]{32}$/, "a real k1, not the all-zero probe");
  assert.ok(tap.k1 !== ZK, "not the non-payable probe k1");
  console.log("✓ a tap on the phone-written card issues a real k1");

  // ── Check card reads it back through the stub ──
  await page.click("#cwNfcCheck");
  await waitText(page, "#cwNfcLog", "Check OK", 20000);
  console.log("✓ read-back check matched the written link");
  await page.screenshot({ path: OUT + "/app-2-written.png" });

  // ── done: list shows the card active ──
  await page.click("#cwNfcDone");
  await page.waitForSelector("#issueCardTile", { timeout: 15000 });
  await waitText(page, ".cardsgrid", "Active", 15000);
  console.log("✓ card list shows Active after the phone write");

  // ── permission denial maps to friendly copy (second card) ──
  await page.click("#issueCardTile");
  await setVal(page, '#cardIssue input[name="name"]', "Denied card");
  await setVal(page, '#cardIssue input[name="pin"]', "1234");
  await page.click("#cardIssue button");
  await page.waitForSelector("#cwNfcGo", { timeout: 25000 });
  await page.evaluate(() => { window.__nfcFail = "simulated denial"; });
  await page.click("#cwNfcGo");
  await waitText(page, "#cwNfcLog", "NFC permission", 15000);
  console.log("✓ permission denial shows the NFC permission hint");
  await page.screenshot({ path: OUT + "/app-3-denied.png" });
  await page.evaluate(() => {
    window.__nfcFail = null;
    document.querySelectorAll("button.xbtn").forEach((b) => b.click());
  });

  // ── wipe from the phone ──
  await page.waitForSelector("#issueCardTile", { timeout: 15000 });
  await page.click('.cardsgrid .cardtile[data-card-id="' + card.id + '"]');
  await page.waitForSelector("#wipeCard", { timeout: 15000 });
  await page.click("#wipeCard");
  await page.waitForSelector("#wipeNfcGo", { timeout: 25000 });
  await page.screenshot({ path: OUT + "/app-4-wipe-dialog.png" });
  await page.click("#wipeNfcGo");
  await page.waitForFunction(() => !document.querySelector("#wipeNfcGo"), { timeout: 30000 });
  await page.waitForSelector("#issueCardTile", { timeout: 15000 });
  await waitText(page, ".cardsgrid", "Cancelled", 15000);
  console.log("✓ card wiped from the phone and cancelled");

  const nfc2 = await page.evaluate(() => window.__nfc);
  const erase = nfc2.writes.find((w) => w.records.length === 0);
  assert.ok(erase, "an empty NDEF message (erase) must have been written");
  console.log("✓ the wipe pushed an empty NDEF message");

  // ── the server refuses taps after the wipe ──
  const tap2 = await (await fetch(APP + "/card/" + card.id + "?p=" + Z + "&c=" + ZC)).json();
  assert.equal(tap2.status, "ERROR", "taps after a wipe must be refused: " + JSON.stringify(tap2));
  console.log("✓ taps are refused after the wipe");
  await page.screenshot({ path: OUT + "/app-5-wiped.png" });

  if (problems.length) {
    console.log("page problems:", problems);
    throw new Error("page reported errors");
  }
  console.log("\nPHONE WRITE E2E: all good (screenshots in " + OUT + ")");
} finally {
  await browser.close();
}
