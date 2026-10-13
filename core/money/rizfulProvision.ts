// @ts-nocheck
/**
 * Rizful one-click provisioning. Creates a Rizful account from scratch for an
 * openLN merchant and returns a ready NWC connection, with no manual steps:
 *
 *   1. a fresh temp mailbox (mail.tm) receives the signup verification email
 *   2. Chromium (the shared provisioning browser, driven over CDP) fills and
 *      submits the signup form, passes the Turnstile widget, and clicks the
 *      verification link from the email
 *   3. the one-time code from /nostr_onboarding_auth_token/get_token is
 *      exchanged for { nwc_uri, lightning_address } via post_for_secrets
 *
 * Verified end to end against the live service on 2026-10-13: account created,
 * email verified, code exchanged, NWC probed with get_balance.
 *
 * Every external piece is injectable (deps) so tests run the whole flow
 * against fakes; pace=0 removes the human-like waits for fast tests.
 */
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { CdpConnection, CdpPage } from "./cdpBrowser.js";
import * as defaultMail from "./tempMail.js";
import { generateKeypair as defaultGenerateKeypair } from "./nostrKeys.js";

const CREATE_ACCOUNT_URL = "https://rizful.com/create-account";
const GET_TOKEN_URL = "https://rizful.com/nostr_onboarding_auth_token/get_token";
const EXCHANGE_URL = "https://rizful.com/nostr_onboarding_auth_token/post_for_secrets";

export interface RizfulResult {
  mailbox: { address: string; password: string; token: string };
  rizfulEmail: string;
  rizfulPassword: string;
  lightningAddress: string;
  nwcUri: string;
  nostrPubkeyHex: string;
}

export interface RizfulFlowOptions {
  cdpUrl?: string;
  mailboxPrefix?: string;
  onStep?: (step: string) => void;
  log?: (message: string) => void;
  debugDir?: string;
  pace?: number;
  deps?: {
    createMailbox?: (prefix?: string) => Promise<{ address: string; password: string; token: string }>;
    waitForMessage?: (token: string, match: (m: { id: string; from: string; subject: string }) => boolean, timeoutMs?: number, intervalMs?: number) => Promise<{ id: string; from: string; subject: string }>;
    readMessage?: (token: string, id: string) => Promise<string>;
    openBrowser?: (cdpUrl: string) => Promise<{ page: any; close: () => Promise<void> }>;
    exchange?: (code: string, pubkeyHex: string) => Promise<{ nwc_uri?: string; lightning_address?: string }>;
    generateKeypair?: () => Promise<{ pubKeyHex: string }>;
  };
}

/** A memorable login password: fixed prefix + unambiguous random characters. */
export function makePassword(): string {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let s = "";
  for (const b of randomBytes(14)) s += abc[b % abc.length];
  return "oLn-" + s;
}

export function parseVerifyLink(text: string): string | null {
  const m = String(text || "").replace(/&amp;/g, "&").match(/https:\/\/rizful\.com\/verify-account\?key=[A-Za-z0-9_-]+/);
  return m ? m[0] : null;
}

export function parseOneTimeCode(text: string): string | null {
  const t = String(text || "");
  const m = t.match(/One-Time Code[\s\S]{0,160}?([A-Z0-9]{6}-[A-Z0-9]{6})/) || t.match(/\b([A-Z0-9]{6}-[A-Z0-9]{6})\b/);
  return m ? m[1] : null;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The real exchange endpoint: trims the pubkey (an untrimmed key is refused). */
export async function exchangeCodeForSecrets(code: string, pubkeyHex: string): Promise<any> {
  const res = await fetch(EXCHANGE_URL, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://rizful.com" },
    body: JSON.stringify({ secret_code: String(code).trim(), nostr_public_key: String(pubkeyHex || "").trim() }),
    signal: AbortSignal.timeout(20000),
  });
  const data: any = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data?.["hydra:description"] || data?.detail || data?.error || `HTTP ${res.status}`;
    throw new Error(`Rizful refused the code exchange: ${typeof msg === "string" ? msg : `HTTP ${res.status}`}`);
  }
  return data;
}

const defaultOpenBrowser = async (endpoint: string) => {
  const conn = await CdpConnection.connect(endpoint);
  try {
    const page = await CdpPage.open(conn, "about:blank");
    return { page, close: async () => { try { await page.close(); } finally { conn.close(); } } };
  } catch (err) {
    conn.close();
    throw err;
  }
};

export async function runRizfulFlow(opts: RizfulFlowOptions = {}): Promise<RizfulResult> {
  const cdpUrl = opts.cdpUrl || process.env.RIZFUL_CDP_URL || "http://127.0.0.1:9223";
  const pace = opts.pace === 0 ? 0 : 1;
  const onStep = opts.onStep || (() => {});
  const log = opts.log || (() => {});
  const deps = opts.deps || {};
  const createMailbox = deps.createMailbox || defaultMail.createMailbox;
  const waitForMessage = deps.waitForMessage || defaultMail.waitForMessage;
  const readMessage = deps.readMessage || defaultMail.readMessage;
  const openBrowser = deps.openBrowser || defaultOpenBrowser;
  const exchange = deps.exchange || exchangeCodeForSecrets;
  const generateKeypair = deps.generateKeypair || defaultGenerateKeypair;

  const debugDir = opts.debugDir || path.join(process.cwd(), "var", "rizful-provision");
  await mkdir(debugDir, { recursive: true }).catch(() => {});
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const debugPath = (name: string) => path.join(debugDir, `${name}-${stamp}.png`);

  // 1. The burner inbox that receives the Rizful verification email.
  onStep("Creating a temporary inbox");
  const mailbox = await createMailbox(opts.mailboxPrefix || "openln");
  const rizfulEmail = mailbox.address;
  const rizfulPassword = makePassword();
  const keypair = await generateKeypair();
  const pubkeyHex = String(keypair.pubKeyHex || "").trim();

  const browser = await openBrowser(cdpUrl);
  const page = browser.page;
  try {
    // 2. Signup: fill, pass Turnstile, submit, wait for the confirmation flash.
    onStep("Opening the Rizful signup");
    await page.navigate(CREATE_ACCOUNT_URL, 1800, pace);
    log("signup page loaded");
    const filled = await page.eval(`(() => {
      const set = (el, v) => { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; d.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); };
      const inputs = [...document.querySelectorAll('input')];
      const emailEl = document.querySelector('input[type=email]') || inputs.find((i) => /email/i.test(i.name || '') || /e-?mail/i.test(i.placeholder || ''));
      const pws = inputs.filter((i) => i.type === 'password');
      if (!emailEl || pws.length < 1) return false;
      set(emailEl, ${JSON.stringify(rizfulEmail)});
      set(pws[0], ${JSON.stringify(rizfulPassword)});
      if (pws[1]) set(pws[1], ${JSON.stringify(rizfulPassword)});
      const terms = inputs.find((i) => i.type === 'checkbox' && /terms/i.test((i.name || '') + (i.id || ''))) || inputs.find((i) => i.type === 'checkbox');
      if (terms && !terms.checked) terms.click();
      return true;
    })()`);
    if (!filled) throw new Error("the Rizful signup form could not be filled (layout changed?)");

    onStep("Passing the bot check");
    const tokenExpr = "(() => { const t = document.querySelector('input[name=cf-turnstile-response]'); return t && t.value.length > 0; })()";
    let solved = await page.waitFor(tokenExpr, 8000, true, pace);
    for (let i = 0; i < 8 && !solved; i++) {
      const rectRaw = await page.eval(`(() => { const w = document.querySelector('.cf-turnstile'); if (!w) return ''; const r = w.getBoundingClientRect(); return JSON.stringify({ x: r.x, y: r.y, w: r.width, h: r.height }); })()`);
      if (rectRaw) {
        try {
          const r = JSON.parse(String(rectRaw));
          const dx = [14, 26, 38][i % 3];
          const dy = i % 2 === 0 ? Math.round(r.h / 2) : Math.round(r.h / 2) - 8;
          await page.click(Math.round(r.x + dx), Math.round(r.y + dy));
        } catch { /* bad rect; retry */ }
      }
      solved = await page.waitFor(tokenExpr, 6000, true, pace);
    }
    if (!solved) {
      await page.screenshot(debugPath("turnstile"));
      throw new Error("the Rizful bot check did not pass");
    }
    log("bot check passed");

    onStep("Creating your Rizful account");
    await page.eval(`(() => { const f = [...document.querySelectorAll('form')].find((x) => x.querySelector('input[type=email]')) || document.querySelector('form'); f.requestSubmit(); return true; })()`);
    const okExpr = "(() => { const b = document.body.innerText || ''; return b.includes('verification link') || b.includes('verify your account') || b.includes('been sent to you'); })()";
    const submitted = await page.waitFor(okExpr, 45000, true, pace);
    if (!submitted) {
      await page.screenshot(debugPath("signup"));
      const body = await page.bodyText();
      if (/already|taken|valid email|at least 8|captcha/i.test(body)) {
        throw new Error("Rizful rejected the signup: " + body.split("\n").filter(Boolean).slice(0, 3).join(" / "));
      }
      throw new Error("the Rizful signup did not go through");
    }
    log("account created; verification email on its way");

    // 3. The verification email.
    onStep("Waiting for the verification email");
    const message = await waitForMessage(mailbox.token, (m) => /rizful/i.test(m.from) || /verify/i.test(m.subject), 180000, 4000);
    const raw = await readMessage(mailbox.token, message.id);
    const link = parseVerifyLink(raw);
    if (!link) throw new Error("the verification email carried no verify link");

    // 4. Verify.
    onStep("Verifying the email");
    await page.navigate(link, 1800, pace);
    const verifyClicked = await page.eval(`(() => { const b = [...document.querySelectorAll('button, input[type=submit]')].find((x) => /verify/i.test((x.textContent || x.value || ''))); if (!b) return false; b.click(); return true; })()`);
    if (!verifyClicked) {
      const t = await page.bodyText();
      if (!/has been verified/i.test(t)) {
        await page.screenshot(debugPath("verify"));
        throw new Error("the Rizful verify page had no verify control");
      }
    }
    const verifiedExpr = "(() => { const b = document.body.innerText || ''; return b.includes('has been verified') || (b.includes('My Account') && !b.includes('Please verify')); })()";
    const verified = await page.waitFor(verifiedExpr, 40000, true, pace);
    if (!verified) {
      await page.screenshot(debugPath("verify"));
      throw new Error("email verification did not complete on Rizful");
    }
    log("email verified");

    // 5. One-time code, exchanged for the wallet. A failed exchange (most
    //    likely an expired code) gets one fresh code before giving up.
    let result: any = null;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2 && !result; attempt++) {
      onStep("Fetching the one-time code");
      await page.navigate(GET_TOKEN_URL, 1800, pace);
      const here = await page.url();
      if (/\/login/.test(here)) throw new Error("the Rizful session was lost before the code could be read; the account exists but its wallet was not linked");
      const codeVisible = await page.waitFor(`/[A-Z0-9]{6}-[A-Z0-9]{6}/.test(document.body.innerText || '')`, 25000, true, pace);
      if (!codeVisible) {
        await page.screenshot(debugPath("code"));
        throw new Error("the one-time code did not appear on the Rizful page");
      }
      const code = parseOneTimeCode(await page.bodyText());
      if (!code) throw new Error("could not read the one-time code from the Rizful page");
      onStep("Linking the wallet (NWC)");
      try {
        const response = await exchange(code, pubkeyHex);
        if (response?.nwc_uri && response?.lightning_address) result = response;
        else throw new Error("the code exchange returned no wallet");
      } catch (err) {
        lastError = err;
        if (attempt === 0) log("exchange failed; retrying with a fresh code");
      }
    }
    if (!result) throw lastError instanceof Error ? lastError : new Error("the code exchange failed");

    onStep("Finishing up");
    return {
      mailbox,
      rizfulEmail,
      rizfulPassword,
      lightningAddress: result.lightning_address,
      nwcUri: result.nwc_uri,
      nostrPubkeyHex: pubkeyHex,
    };
  } catch (err) {
    await page.screenshot(debugPath("error"));
    throw err;
  } finally {
    await browser.close().catch(() => {});
    await sleep(pace === 0 ? 0 : 300);
  }
}
