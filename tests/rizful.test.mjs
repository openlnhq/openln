/**
 * Unit tests for the Rizful provisioning flow. The whole flow runs against
 * fakes (scripted page, fake mailbox, fake exchange), so these tests are
 * fast and hermetic; the live chain is exercised by
 * scripts/rizful-provision-cli.mjs against the real services.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { makePassword, parseVerifyLink, parseOneTimeCode, runRizfulFlow } from "../dist/core/money/rizfulProvision.js";

test("parseVerifyLink finds the rizful verify link in email text", () => {
  const link = "https://rizful.com/verify-account?key=12067_l9wuXUFWyrVDCt1R__VxFPnh7yvOv7TKr12p4RM5pQc";
  assert.equal(parseVerifyLink(`Click <a href="${link}">here</a> to verify`), link);
  assert.equal(parseVerifyLink(`href="${link.replace("&", "&amp;")}"`), link);
  assert.equal(parseVerifyLink("nothing here"), null);
  assert.equal(parseVerifyLink("https://evil.example/verify-account?key=abc"), null);
});

test("parseOneTimeCode reads the code near its label", () => {
  assert.equal(parseOneTimeCode("Your One-Time Code\nExpires in 2m 56s\nWSEK5V-Z6CGGV\nCopy"), "WSEK5V-Z6CGGV");
  assert.equal(parseOneTimeCode("random ABC123-XYZ789 text"), "ABC123-XYZ789");
  assert.equal(parseOneTimeCode("no code at all"), null);
});

test("makePassword is human-usable and unambiguous", () => {
  const pw = makePassword();
  assert.match(pw, /^oLn-[A-Za-z0-9]{14}$/);
  assert.ok(!/[IlO0]/.test(pw.slice(4)), "no ambiguous characters");
  assert.notEqual(makePassword(), makePassword());
});

const VERIFY_LINK = "https://rizful.com/verify-account?key=abc_DEF-123456789";

function makeFakes(overrides = {}) {
  const state = {
    turnstile: false,
    turnstileSolvable: overrides.turnstile !== false,
    signupOk: true,
    verified: true,
    atLogin: overrides.atLogin === true,
    body: "",
    url: "",
    clicks: [],
    navigations: [],
    pageClosed: false,
    connClosed: false,
    ...overrides.state,
  };
  const page = {
    async navigate(url) { state.navigations.push(url); state.url = url; },
    async url() { return state.atLogin ? "https://rizful.com/login" : state.url; },
    async bodyText() { return state.body; },
    async eval(expr) {
      if (expr.includes("cf-turnstile")) return JSON.stringify({ x: 100, y: 200, w: 300, h: 70 });
      if (expr.includes("requestSubmit")) { state.submitted = true; return true; }
      if (expr.includes("verify")) { state.verifyClicked = true; return true; }
      return true;
    },
    async waitFor(expr) {
      if (expr.includes("cf-turnstile-response")) return state.turnstile;
      if (expr.includes("verification link")) return state.signupOk;
      if (expr.includes("has been verified")) return state.verified;
      if (expr.includes("A-Z0-9")) { state.body = "Your One-Time Code WSEK5V-Z6CGGV"; return true; }
      return true;
    },
    async click(x, y) { state.clicks.push([x, y]); if (state.turnstileSolvable) state.turnstile = true; },
    async screenshot() {},
    async close() { state.pageClosed = true; },
  };
  const browser = { page, async close() { state.pageClosed = true; state.connClosed = true; } };
  const mailbox = {
    async createMailbox() { return { address: "openln-test-abc123@example.com", password: "mpw-secret", token: "mtok" }; },
    async waitForMessage() { return { id: "m1", from: "info@rizful.com", subject: "[Rizful] Please verify your account" }; },
    async readMessage() { return `Please verify your email: ${VERIFY_LINK}`; },
  };
  const exchangeCalls = [];
  const exchange = async (code, pubkey) => {
    exchangeCalls.push({ code, pubkey });
    if (overrides.failFirstExchange && exchangeCalls.length === 1) throw new Error("Rizful refused the code exchange: expired");
    return { nwc_uri: "nostr+walletconnect://" + "a".repeat(64) + "?relay=wss%3A%2F%2Frelay-nwc.rizful.com&secret=" + "b".repeat(64), lightning_address: "brave-koala-75@rizful.com" };
  };
  const keypair = async () => ({ pubKeyHex: "c".repeat(64) + "   " });
  return { state, page, browser, mailbox, exchange, exchangeCalls, keypair };
}

const baseDeps = (f) => ({
  createMailbox: f.mailbox.createMailbox,
  waitForMessage: f.mailbox.waitForMessage,
  readMessage: f.mailbox.readMessage,
  openBrowser: async () => f.browser,
  exchange: f.exchange,
  generateKeypair: f.keypair,
});

test("flow completes against fakes and returns the wallet", async () => {
  const f = makeFakes();
  const steps = [];
  const result = await runRizfulFlow({
    pace: 0,
    onStep: (s) => steps.push(s),
    deps: baseDeps(f),
    debugDir: "/tmp/rizful-test-debug",
  });
  assert.equal(result.rizfulEmail, "openln-test-abc123@example.com");
  assert.match(result.rizfulPassword, /^oLn-/);
  assert.equal(result.lightningAddress, "brave-koala-75@rizful.com");
  assert.match(result.nwcUri, /^nostr\+walletconnect:\/\//);
  // The pubkey handed to the exchange must be trimmed.
  assert.equal(f.exchangeCalls.length, 1);
  assert.equal(f.exchangeCalls[0].pubkey, "c".repeat(64));
  assert.equal(f.exchangeCalls[0].code, "WSEK5V-Z6CGGV");
  // Every stage reported; browser context cleaned up.
  for (const expected of ["Creating a temporary inbox", "Creating your Rizful account", "Waiting for the verification email", "Verifying the email", "Linking the wallet (NWC)"]) {
    assert.ok(steps.includes(expected), `step reported: ${expected}`);
  }
  assert.ok(f.state.pageClosed && f.state.connClosed, "browser closed");
  assert.ok(f.state.clicks.length >= 1, "turnstile clicked");
});

test("flow retries the exchange once with a fresh code", async () => {
  const f = makeFakes({ failFirstExchange: true });
  const result = await runRizfulFlow({ pace: 0, deps: baseDeps(f), debugDir: "/tmp/rizful-test-debug" });
  assert.equal(result.lightningAddress, "brave-koala-75@rizful.com");
  assert.equal(f.exchangeCalls.length, 2, "exchange attempted twice");
});

test("a failing bot check stops the run with a clear error", async () => {
  const f = makeFakes({ turnstile: false });
  await assert.rejects(
    runRizfulFlow({ pace: 0, deps: baseDeps(f), debugDir: "/tmp/rizful-test-debug" }),
    /bot check did not pass/,
  );
  assert.ok(f.state.connClosed, "browser closed even on failure");
});

test("a lost session is reported honestly", async () => {
  const f = makeFakes({ atLogin: true });
  await assert.rejects(
    runRizfulFlow({ pace: 0, deps: baseDeps(f), debugDir: "/tmp/rizful-test-debug" }),
    /session was lost/,
  );
});
