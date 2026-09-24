import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthService } from "./auth/service.js";
import { WalletService } from "./wallet/service.js";
import { createBuiltinRegistry } from "./plugins/builtin.js";
import { db, entitiesTable, accountsTable, pendingInvoicesTable, transactionsTable } from "./db/index.js";
import { and, eq, sql } from "drizzle-orm";
import { makeInvoice } from "./money/nwc.js";
import { captureFiatSnapshot } from "./money/fiatSnapshot.js";
import { createWrappedInvoice, cancelWrap, type WrapRow } from "./money/holdWrap.js";
import { encrypt } from "./money/encrypt.js";
import { resolveWalletSource, merchantFundingFromSource } from "./money/walletSource.js";
import { detectFunding } from "./money/fundingInput.js";
import { recordPaymentEvent } from "./money/paymentLog.js";
import { AmbiguousPaymentError } from "./money/feeEngine.js";
import { reconcileAccountInvoicesBounded, startInvoiceMonitor } from "./money/invoiceMonitor.js";
import { startWrapDriver, kickWrap, OPEN_WRAP_STATES, wrapDriverStats } from "./money/wrapDriver.js";
import { startWrapNotifications, wrapNotificationStats } from "./money/nwcNotifications.js";
import { onAccountEvent } from "./events.js";
import { handleCardsPreview } from "../plugins/cards-preview.js";
import { handleCardsRoute } from "../plugins/cards.js";
import { handleReportsRoute } from "../plugins/reports.js";
import { handleExtensionsRoute } from "../plugins/extensions.js";
import { handlePosboxRoute } from "../plugins/posbox.js";
import { handleShopRoute } from "../plugins/shop.js";
import { handlePartnerRoute } from "../plugins/partner.js";
import { handleAdminPaymentsRoute } from "./admin/adminPayments.js";
import { DOMAIN } from "./domain.js";


// Wire status for a pending_invoices row, DB only. Open wraps nudge the driver.
function wrapStatusView(invoice: typeof pendingInvoicesTable.$inferSelect): { status: string; paymentHash: string } {
  const paymentHash = invoice.paymentHash;
  if (invoice.paidAt || invoice.wrapStatus === "settled") return { status: "paid", paymentHash };
  if (invoice.wrapStatus) {
    if ((OPEN_WRAP_STATES as readonly string[]).includes(invoice.wrapStatus)) {
      // A created hold past its expiry is dead; the driver will confirm and
      // mark it cancelled, but tell the device now so it stops waiting.
      if (invoice.wrapStatus === "created" && invoice.expiresAt < new Date()) { kickWrap(paymentHash); return { status: "expired", paymentHash }; }
      kickWrap(paymentHash);
      return { status: invoice.wrapStatus === "created" ? "pending" : invoice.wrapStatus, paymentHash };
    }
    return { status: invoice.wrapStatus, paymentHash }; // cancelled / needs_reconciliation
  }
  return { status: invoice.expiresAt < new Date() ? "expired" : "pending", paymentHash };
}

const auth = new AuthService(); const wallet = new WalletService(); const registry = createBuiltinRegistry();
const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ""; for await (const c of req) raw += c;
  if (!raw) return {};
  if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) return Object.fromEntries(new URLSearchParams(raw));
  return JSON.parse(raw);
}
async function accountForHandle(handle: string) {
  const [entity] = await db.select({ id: entitiesTable.id }).from(entitiesTable).where(eq(entitiesTable.handle, handle.toLowerCase()));
  if (!entity) return null;
  const [account] = await db.select({ id: accountsTable.id }).from(accountsTable).where(eq(accountsTable.entityId, entity.id));
  return account ?? null;
}
const server = createServer(async (req, res) => {
  try {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && u.pathname === "/health") return json(res, 200, { status: "ok", service: "openln-core", plugins: registry.list().map(p => p.id), wraps: wrapDriverStats(), notifications: wrapNotificationStats() });
    // RIC/CYD firmware connectivity check — calls `${serverUrl}/healthz` where serverUrl is `${origin}/api` (see BitposClient.cpp beginAuthRequest). No auth: pure reachability probe before the device attempts authenticated calls.
    if (req.method === "GET" && u.pathname === "/api/healthz") return json(res, 200, { status: "ok" });
    const cardToken = (req.headers.authorization ?? "").startsWith("Bearer ") ? (req.headers.authorization ?? "").slice(7) : (u.searchParams.get("token") ?? String(req.headers.cookie ?? "").match(/openln_session=([^;]+)/)?.[1]);
    const currentAccount = cardToken ? await auth.authenticate(cardToken) : undefined;
    // A RIC token is not a browser session. Limit it to the firmware protocol;
    // otherwise it can overwrite the merchant Send PIN or call wallet/pay.
    if(currentAccount && /^[0-9a-f]{64}$/.test(cardToken ?? "")) {
      const deviceAllowed = (req.method === "GET" && (/^\/api\/pos\/(config|invoice\/[^/]+\/status|withdraw\/[^/]+\/status|next-provision|wipe-keys\/[^/]+)$/.test(u.pathname) || u.pathname === "/api/price" || /^\/api\/firmware\//.test(u.pathname))) ||
        (req.method === "POST" && (/^\/api\/pos\/(invoice|invoice\/[^/]+\/cancel|withdraw|send-to-card|mark-written\/[^/]+|mark-wiped\/[^/]+)$/.test(u.pathname) || ["/api/ric/hello","/api/ric/status"].includes(u.pathname)));
      if(!deviceAllowed)return json(res,403,{error:"Device credential cannot access account settings or browser wallet operations"});
    }
    if(await handleCardsPreview(req,res,u))return;
    // RIC/CYD device boot handshake — GET /pos/config (device fetches merchant currency + rate modifiers) and GET /price (BTC/fiat rate). Ported verbatim from bitPOS routes/pos.ts + routes/price.ts.
    if (req.method === "GET" && u.pathname === "/api/pos/config") {
      if (!currentAccount) return json(res, 401, { error: "Authentication required" });
      const [account] = await db.select({ currency: accountsTable.currency, rateSource: accountsTable.rateSource, rateModifier: accountsTable.rateModifier, sendRateModifier: accountsTable.sendRateModifier }).from(accountsTable).where(eq(accountsTable.id, currentAccount.id));
      if (!account) return json(res, 404, { error: "Account not found" });
      return json(res, 200, { currency: account.currency, rateSource: account.rateSource ?? "coingecko", rateModifier: account.rateModifier ?? "", sendRateModifier: account.sendRateModifier ?? "" });
    }
    if (req.method === "GET" && u.pathname === "/api/price") {
      const { getBtcPrice, getBtcPriceFor, applyRateModifier } = await import("./money/price.js");
      const vs = u.searchParams.get("vs_currency");
      const [priceSettings]=currentAccount ? await db.select({rateSource:accountsTable.rateSource}).from(accountsTable).where(eq(accountsTable.id,currentAccount.id)) : [];
      const requestedSource=u.searchParams.get("source")?.toLowerCase();
      if(requestedSource && !["binance","coingecko"].includes(requestedSource))return json(res,400,{error:"Invalid price source"});
      const source=requestedSource || priceSettings?.rateSource || "coingecko";
      const modifier = u.searchParams.get("modifier") ?? undefined;
      if (vs && vs.trim()) {
        const currency = vs.trim().toLowerCase();
        let price = await getBtcPriceFor(currency, source as "coingecko" | "binance");
        if (modifier) price = applyRateModifier(price, modifier);
        if (!Number.isFinite(price) || price <= 0) return json(res,503,{error:"Exchange rate unavailable; do not use a stale or zero conversion",currency,source});
        return json(res, 200, { currency, price, source, modified: !!modifier });
      }
      const price = await getBtcPrice();
      return json(res, 200, price);
    }
    if (await handlePartnerRoute(req,res,u)) return;
    if (await handlePosboxRoute(req,res,u,currentAccount ? {...currentAccount,authType:/^[0-9a-f]{64}$/.test(cardToken ?? "") ? "device" : "session"} : undefined)) return;
    if (handleShopRoute(req,res,u)) return;
    if (await handleExtensionsRoute(req,res,u,currentAccount)) return;
    if (await handleReportsRoute(req,res,u,currentAccount)) return;
    const cardsHandled = await handleCardsRoute(req, res, u, currentAccount); if (cardsHandled) return;
    if (req.method === "GET" && u.pathname.startsWith("/icons/")) {
      const name = u.pathname.slice(7).replace(/[^a-zA-Z0-9._-]/g, "");
      try {
        const data = await (await import("node:fs/promises")).readFile(new URL("../../artifacts/web/icons/" + name, import.meta.url));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        return res.end(data);
      } catch { return json(res, 404, { error: "Not found" }); }
    }
    if (req.method === "GET" && u.pathname.startsWith("/media/")) {
      const name = u.pathname.slice(7).replace(/[^a-zA-Z0-9._-]/g, "");
      try {
        const data = await (await import("node:fs/promises")).readFile(new URL("../../artifacts/web/media/" + name, import.meta.url));
        const type = name.endsWith(".mjs") ? "text/javascript; charset=utf-8" : name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : name.endsWith(".webp") ? "image/webp" : "application/octet-stream";
        res.writeHead(200, { "content-type": type, "cache-control": "public, max-age=86400" });
        return res.end(data);
      } catch { return json(res, 404, { error: "Not found" }); }
    }
    if (req.method === "GET" && u.pathname === "/") {
      try { return res.end(await (await import("node:fs/promises")).readFile(new URL("../../artifacts/web/landing.html", import.meta.url), "utf8")); }
      catch { return res.end("<!doctype html><title>openLN</title><h1>openLN</h1><a href='/app'>Open wallet</a>"); }
    }
    if (req.method === "GET" && (u.pathname === "/app" || u.pathname === "/app/" || u.pathname === "/partner" || u.pathname === "/partner/")) { try { const html = await readFile(join(process.cwd(), "artifacts/web/index.html"), "utf8"); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); } catch { return json(res, 500, { error: "Web application unavailable" }); } }
    if (req.method === "GET" && u.pathname === "/api/plugins") return json(res, 200, registry.list());
    if (req.method === "POST" && u.pathname === "/api/auth/register") { const v = await body(req); try { return json(res, 201, await auth.register(String(v.handle ?? ""), String(v.password ?? ""))); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "Invalid request" }); } }
    if (req.method === "POST" && u.pathname === "/api/auth/login") { const v = await body(req); try { return json(res, 200, await auth.login(String(v.handle ?? ""), String(v.password ?? ""))); } catch (e) { return json(res, 401, { error: e instanceof Error ? e.message : "Invalid credentials" }); } }
    if (req.method === "POST" && u.pathname === "/api/auth/access-state") { const v = await body(req); try { return json(res, 200, await auth.accessState(String(v.handle ?? ""))); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "Invalid request" }); } }
    if (req.method === "POST" && u.pathname === "/api/auth/migrate-password") { const v = await body(req); try { return json(res, 200, await auth.migratePassword(String(v.handle ?? ""), String(v.pin ?? ""), String(v.password ?? ""))); } catch (e) { return json(res, 401, { error: e instanceof Error ? e.message : "Invalid credentials" }); } }
    const sessionAccount = async () => { const h = req.headers.authorization ?? ""; const token = h.startsWith("Bearer ") ? h.slice(7) : (u.searchParams.get("token") ?? String(req.headers.cookie ?? "").match(/openln_session=([^;]+)/)?.[1]); return token ? auth.authenticate(token) : undefined; };
    // Cross-subdomain handoff to cards.openln.com (still maekob's app), exact
    // same mechanism bitpos.app already uses in production for its "Business"
    // tab iframe: sign a short-lived (8 min) HMAC token with the shared secret
    // maekob already trusts, hand the frontend an embed URL; maekob's own
    // /auth/embed verifies it and mints maekob's own session. No shared cookie,
    // no new trust surface beyond adding "openln" as a second accepted issuer
    // on maekob's existing verifier (bitpos's iss stays valid too).
    if (req.method === "POST" && u.pathname === "/api/auth/embed-token") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const secret = process.env.MAEKOB_SHARED_SECRET;
      if (!secret) return json(res, 503, { error: "Card shop is not configured (missing MAEKOB_SHARED_SECRET)" });
      const embedUrlBase = process.env.MAEKOB_EMBED_URL ?? "https://cards.openln.com/embed";
      // Prefer the account's real linked lightning address (set for legacy
      // bitpos/maekob migrated users) so maekob's lookup-by-lightningAddress
      // resolves to the SAME pre-existing account instead of auto-creating a
      // new "handle_XXXX" one. Only synthesize handle@openln.com when the
      // account genuinely has none on file (brand-new openln-native users).
      const [acctRow] = await db.select({ lightningAddress: accountsTable.lightningAddress }).from(accountsTable).where(eq(accountsTable.id, account.id));
      const lightningAddress = acctRow?.lightningAddress || `${account.handle}@openln.com`;
      const now = Math.floor(Date.now() / 1000);
      const payloadObj = { iss: "openln", sub: account.id, handle: account.handle, lightningAddress, iat: now, exp: now + 8 * 60 };
      const headerB64 = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
      const payloadB64 = Buffer.from(JSON.stringify(payloadObj)).toString("base64url");
      const sig = createHmac("sha256", secret).update(`${headerB64}.${payloadB64}`).digest("base64url");
      const embedToken = `${headerB64}.${payloadB64}.${sig}`;
      return json(res, 200, { embedToken, embedUrl: `${embedUrlBase}?token=${encodeURIComponent(embedToken)}` });
    }
    // Admin payments ops console (treasury dashboard, payment list/detail, advance/lookup/remediate).
    // Ported verbatim from bitPOS's routes/adminPayments.ts — single hook point, auth handled inside.
    if (u.pathname.startsWith("/api/admin/payments")) {
      const account = await sessionAccount();
      if (await handleAdminPaymentsRoute(req, res, u, account)) return;
    }
    // ---- Account settings (currency, rate, wallet prefs) ----
    if (req.method === "GET" && u.pathname === "/api/me") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const [acctRow] = await db.select({ lightningAddress: accountsTable.lightningAddress }).from(accountsTable).where(eq(accountsTable.id, account.id));
      return json(res, 200, { account: { id: account.id, handle: account.handle, lightningAddress: acctRow?.lightningAddress || `${account.handle}@openln.com` } });
    }
    if (req.method === "GET" && u.pathname === "/api/account/settings") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const [row] = await db.select({ currency: accountsTable.currency, rateSource: accountsTable.rateSource, rateModifier: accountsTable.rateModifier, sendRateModifier: accountsTable.sendRateModifier, walletMode: accountsTable.walletMode, lightningAddress: accountsTable.lightningAddress }).from(accountsTable).where(eq(accountsTable.id, account.id));
      return json(res, 200, row ?? { currency: "usd", rateSource: "coingecko" });
    }
    if (req.method === "PUT" && u.pathname === "/api/account/settings") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req);
      const updates: Record<string, string | null> = {};
      if (v.currency !== undefined) {
        if(typeof v.currency !== "string" || !/^(?:[a-z]{3}|sats)$/i.test(v.currency)) return json(res,400,{error:"Choose a valid currency"});
        updates.currency=v.currency.toLowerCase();
      }
      if(v.rateSource !== undefined) {
        if(typeof v.rateSource !== "string" || !["coingecko","binance"].includes(v.rateSource)) return json(res,400,{error:"Choose a valid price source"});
        updates.rateSource=v.rateSource;
      }
      for(const field of ["rateModifier","sendRateModifier"]) {
        if(v[field] === undefined) continue;
        if(typeof v[field] !== "string") return json(res,400,{error:"Rate adjustment must be text"});
        const value=String(v[field]).replace(/\s/g,"");
        if(value && (value.length>80 || !/^[a-z]{3,5}(?:\*\d+(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)*|[+-]\d+(?:\.\d+)?(?:[+-]\d+(?:\.\d+)?)*)$/i.test(value) || /\*0(?:\.0+)?(?:$|[+-])/.test(value))) return json(res,400,{error:"Use a positive rate adjustment such as ZAR*1.02, or leave blank for market rate"});
        updates[field]=value || null;
      }
      if (Object.keys(updates).length === 0) return json(res, 400, { error: "Nothing to update" });
      await db.update(accountsTable).set(updates).where(eq(accountsTable.id, account.id));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/account/password") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req);
      const currentPassword = String(v.currentPassword ?? "");
      const newPassword = String(v.newPassword ?? "");
      if (newPassword.length < 12) return json(res, 400, { error: "Password must be at least 12 characters" });
      const [acc] = await db.select({ entityId: accountsTable.entityId }).from(accountsTable).where(eq(accountsTable.id, account.id));
      if (!acc) return json(res, 404, { error: "Account not found" });
      const [entity] = await db.select({ id: entitiesTable.id, passwordHash: entitiesTable.passwordHash }).from(entitiesTable).where(eq(entitiesTable.id, acc.entityId));
      if (!entity) return json(res, 404, { error: "Account not found" });
      const { verify, digest } = await import("./auth/password.js");
      if (!entity.passwordHash || !verify(currentPassword, entity.passwordHash)) return json(res, 401, { error: "Current password is incorrect" });
      const { randomBytes } = await import("node:crypto");
      await db.update(entitiesTable).set({ passwordHash: digest(newPassword, randomBytes(16)) }).where(eq(entitiesTable.id, entity.id));
      return json(res, 200, { ok: true });
    }
    // Merchant SEND PIN (6 digits): authorizes sats leaving via the RIC device
    // (POST /api/pos/withdraw, /api/pos/send-to-card). NOT the 4-digit Bolt
    // Card spending PIN (cards.pin_hash, core/auth/card-pin.ts) — different
    // secret, different table, different holder. Stored bcrypt in
    // entities.pin_hash, verified bitPOS-verbatim on the device send path.
    // register() seeds the literal "password-login" placeholder: no PIN set.
    const entityForAccount = async (accountId: string) => {
      const [acc] = await db.select({ entityId: accountsTable.entityId }).from(accountsTable).where(eq(accountsTable.id, accountId));
      if (!acc) return null;
      const [entity] = await db.select({ id: entitiesTable.id, pinHash: entitiesTable.pinHash }).from(entitiesTable).where(eq(entitiesTable.id, acc.entityId));
      return entity ?? null;
    };
    if (req.method === "GET" && u.pathname === "/api/account/send-pin") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const entity = await entityForAccount(account.id); if (!entity) return json(res, 404, { error: "Account not found" });
      return json(res, 200, { set: !!entity.pinHash && entity.pinHash !== "password-login" });
    }
    if (req.method === "POST" && u.pathname === "/api/account/send-pin") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req);
      const newPin = String(v.newPin ?? "");
      const { validSendPinFormat, verifySendPin, hashSendPin, SEND_PIN_UNSET } = await import("./auth/send-pin.js");
      if (!validSendPinFormat(newPin)) return json(res, 400, { error: "Send PIN must be exactly 6 digits" });
      const entity = await entityForAccount(account.id); if (!entity) return json(res, 404, { error: "Account not found" });
      const alreadySet = !!entity.pinHash && entity.pinHash !== SEND_PIN_UNSET;
      if (alreadySet) {
        const currentPin = String(v.currentPin ?? "");
        if (!currentPin) return json(res, 400, { error: "Current send PIN is required" });
        if (!await verifySendPin(currentPin, entity.pinHash)) return json(res, 401, { error: "Current send PIN is incorrect" });
      }
      await db.update(entitiesTable).set({ pinHash: await hashSendPin(newPin) }).where(eq(entitiesTable.id, entity.id));
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && u.pathname === "/api/wallet/connect") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const connection = String(v.connection ?? v.nwcUrl ?? "").trim();
      const detected = detectFunding(connection);
      if (!detected) return json(res, 400, { error: "Paste a Nostr Wallet Connect connection, a Lightning Address (name@provider.com), or a Blink API key" });

      if (detected.kind === "nwc") {
        try {
          const parsed=new URL(connection);
          if(parsed.protocol!=="nostr+walletconnect:" || !/^[0-9a-f]{64}$/i.test(parsed.hostname) || !/^[0-9a-f]{64}$/i.test(parsed.searchParams.get("secret")||"")) throw Error();
          const relays=parsed.searchParams.getAll("relay");
          if(!relays.length || relays.some(relay=>{const u=new URL(relay);return !["ws:","wss:"].includes(u.protocol)}))throw Error();
        } catch { return json(res,400,{error:"Paste the complete NWC connection, including relay and secret"}); }
        const {getBalance}=await import("./money/nwc.js");
        try{await getBalance(connection)}catch{return json(res,422,{error:"Could not read this wallet. Check its NWC permissions and connection; your previous wallet is unchanged."});}
        await db.update(accountsTable).set({ walletMode: "custom", customNwcUrl: encrypt(connection), blinkApiKeyEncrypted: null, blinkWalletId: null, blinkWalletCurrency: null }).where(eq(accountsTable.id, account.id));
        return json(res, 200, { ok: true, walletMode: "custom", connected: true, relays: (connection.match(/relay=/g) ?? []).length });
      }

      if (detected.kind === "lnaddress") {
        // Receive-only lane, generic across wallets (Blink, Wallet of Satoshi,
        // and any provider whose Lightning Address supports LUD-21 verify).
        // The address is public - there is no secret to store or leak. It is
        // also the address shown in the app, so people can pay it directly.
        const { validateLightningAddressForWallet } = await import("./money/lnAddress.js");
        try { await validateLightningAddressForWallet(detected.address); }
        catch (err) { return json(res, 422, { error: err instanceof Error ? err.message : "This Lightning Address could not be validated" }); }
        await db.update(accountsTable).set({ walletMode: "lnaddress", lightningAddress: detected.address, customNwcUrl: null, blinkApiKeyEncrypted: null, blinkWalletId: null, blinkWalletCurrency: null }).where(eq(accountsTable.id, account.id));
        return json(res, 200, { ok: true, walletMode: "lnaddress", connected: true, receiveOnly: true });
      }

      // Blink API key (custodial accounts). Read + Receive scopes cover
      // receiving and balance; sending still runs through NWC in this
      // release, so a Write scope is not required to connect.
      const { validateBlinkApiKeyForWallet } = await import("./money/blink.js");
      let blinkInfo: { walletId: string; walletCurrency: string; balanceSats: number };
      try { blinkInfo = await validateBlinkApiKeyForWallet(detected.apiKey); }
      catch (err) { return json(res, 422, { error: err instanceof Error ? err.message : "Could not read this Blink account" }); }
      await db.update(accountsTable).set({ walletMode: "blink", blinkApiKeyEncrypted: encrypt(detected.apiKey), blinkWalletId: blinkInfo.walletId, blinkWalletCurrency: blinkInfo.walletCurrency, customNwcUrl: null }).where(eq(accountsTable.id, account.id));
      return json(res, 200, { ok: true, walletMode: "blink", connected: true, balanceSats: blinkInfo.balanceSats });
    }
    if (req.method === "GET" && u.pathname === "/api/events") {
      const account = await sessionAccount();
      if (!account) return json(res, 401, { error: "Authentication required" });
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: ready\ndata: {}\n\n`);
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const unsubscribe = onAccountEvent(account.id, send);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
      req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/wallet/status") { const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" }); const source = await resolveWalletSource(account.id); return json(res, 200, { wallet: "non-custodial", connected: source.kind === "nwc" || source.kind === "blink", receiveOnly: source.kind === "lnaddress", canSend: source.kind === "nwc", walletMode: source.kind === "nwc" ? source.mode : source.kind, plugins: [] }); }
    if (req.method === "GET" && u.pathname === "/api/wallet/balance") { const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" }); await reconcileAccountInvoicesBounded(account.id); const source = await resolveWalletSource(account.id); if (source.kind === "nwc") { const { getBalance } = await import("./money/nwc.js"); const balance = await getBalance(source.nwcUrl); return json(res, 200, { balanceSats: balance.balanceSats, connected: true }); } if (source.kind === "blink") { try { const { blinkGetBalance } = await import("./money/blink.js"); const balance = await blinkGetBalance(source.apiKey, source.walletId); return json(res, 200, { balanceSats: balance.balanceSats, connected: true }); } catch { return json(res, 200, { balanceSats: 0, connected: false, unavailable: true }); } } if (source.kind === "lnaddress") return json(res, 200, { balanceSats: 0, connected: false, receiveOnly: true }); return json(res, 200, { balanceSats: 0, connected: false }); }

    if (req.method === "POST" && u.pathname === "/api/wallet/verify") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const bolt11 = String(v.bolt11 ?? "").trim();
      if (!bolt11 || !/^ln(bc|tb|bcrt)/i.test(bolt11)) return json(res, 400, { error: "Invalid BOLT11 invoice" });
      try { const { parseBolt11AmountSats } = await import("./money/boltcard.js"); const amountSats = parseBolt11AmountSats(bolt11); if (!amountSats) return json(res, 400, { error: "Invoice has no valid amount" }); return json(res, 200, { amountSats, description: "Lightning payment", bolt11 }); } catch { return json(res, 400, { error: "Unable to decode invoice" }); }
    }
    if (req.method === "POST" && u.pathname === "/api/wallet/pay") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const bolt11 = String(v.bolt11 ?? "").trim();
      if (!bolt11 || !/^ln(bc|tb|bcrt)/i.test(bolt11)) return json(res, 400, { error: "Invalid BOLT11 invoice" });
      // Sending is NWC-only in this release. Give receive-only funding
      // sources an honest message instead of a cryptic wallet error.
      const paySource = await resolveWalletSource(account.id);
      if (paySource.kind === "lnaddress") return json(res, 400, { error: "Lightning Address accounts are receive-only - connect an NWC wallet to send" });
      if (paySource.kind === "blink") return json(res, 400, { error: "Sending from Blink is not enabled yet - connect an NWC wallet to send" });
      try { const { parseBolt11AmountSats } = await import("./money/boltcard.js"); const { processExternalPayment, AmbiguousPaymentError } = await import("./money/feeEngine.js"); const amountSats = parseBolt11AmountSats(bolt11); if (!amountSats) return json(res, 400, { error: "Invoice has no valid amount" }); const result = await processExternalPayment(account.id, bolt11, amountSats, undefined, typeof v.memo === "string" ? v.memo.slice(0, 140) : "openLN send", undefined, undefined, "wallet");
        // Books: the sender declared what this payment is (spend / transfer to own wallet / refund). Stored as a user classification on the row.
        const purpose = String(v.purpose ?? ""); if (["spend", "transfer_out", "refund"].includes(purpose) && result.paymentHash) { await db.update(transactionsTable).set({ class: purpose as "spend" | "transfer_out" | "refund", classSource: "user" }).where(and(eq(transactionsTable.accountId, account.id), eq(transactionsTable.paymentHash, result.paymentHash), eq(transactionsTable.direction, "out"))).catch(() => {}); }
        return json(res, 200, { status: "completed", ...result }); } catch (e) { if (e instanceof AmbiguousPaymentError) return json(res, 202, { status: "pending", pendingTxId: e.pendingTxId, error: "Payment outcome is unknown; check Activity before retrying" }); return json(res, 400, { error: e instanceof Error ? e.message : "Payment failed" }); }
    }

    // POS invoice endpoint uses the identical wrapped hold path. The device
    // polls the payment status endpoint below; no direct-success shortcut.

    // POS invoice endpoint uses the identical wrapped hold path. The device
    // polls the payment status endpoint below; no direct-success shortcut.
    if (req.method === "POST" && u.pathname === "/api/pos/invoice") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const amountSats = Number(v.amountSats);
      if (!Number.isSafeInteger(amountSats) || amountSats < 1) return json(res, 400, { error: "amountSats must be a positive integer" });
      const source = await resolveWalletSource(account.id);
      const funding = merchantFundingFromSource(source);
      if (!funding) return json(res, 400, { error: "Wallet not configured" });
      const memo = typeof v.memo === "string" ? v.memo.slice(0, 140) : "POS payment";
      // Books: a POS invoice is a sale. RIC requests carry a device token / deviceId; the browser POS does not.
      const fromRic = typeof v.deviceId === "string" || (req.headers["user-agent"] ?? "").toString().startsWith("openLN-RIC");
      // The wallet's own Receive screen declares purpose "top_up" (owner funding the wallet:
      // not income). Anything else on this route is a sale: RIC, or the browser POS.
      const posOrigin = fromRic ? "ric" : v.purpose === "top_up" ? "wallet" : "web_pos";
      // NOTE: the RIC (hardware) is always a sale; the browser Receive screen defaults to top_up
      // and the user flips it to "sale" when a customer is paying at the counter without a RIC.
      const fiatSnapshot = await captureFiatSnapshot(account.id, amountSats, "receive");
      const wrap = await createWrappedInvoice(amountSats, memo, funding);
      if (wrap) {
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats, memo, nwcUrlEncrypted: funding.kind === "nwc" ? encrypt(funding.nwcUrl) : null, merchantBolt11: wrap.merchantBolt11, merchantPaymentHash: wrap.merchantPaymentHash, holdPreimage: wrap.holdPreimage, posboxDeviceId: typeof v.deviceId === "string" ? v.deviceId : undefined, origin: posOrigin, feeSats: wrap.feeSats, wrapStatus: "created", wrapUpdatedAt: new Date(), expiresAt: wrap.expiresAt, ...(fiatSnapshot ?? {}) });
        recordPaymentEvent({
          paymentId: wrap.paymentHash,
          accountId: account.id,
          kind: "wrap",
          event: "wrap.invoice_persisted",
          status: "info",
          mile: "first_mile",
          message: `POS wrap invoice persisted (${amountSats} sats, fee ${wrap.feeSats})`,
          paymentHash: wrap.paymentHash,
          merchantPaymentHash: wrap.merchantPaymentHash,
          amountSats,
          feeSats: wrap.feeSats,
        });
        return json(res, 201, { bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats, feeSats:wrap.feeSats, merchantAmountSats:amountSats-wrap.feeSats, expiresAt: wrap.expiresAt });
      }
      // Direct (unwrapped) invoice - the fallback when wrapping is not
      // available, so a sale is never blocked. The funding source decides how
      // the invoice is minted and how settlement is observed (NWC lookups,
      // LUD-21 verify polling, or the Blink API).
      if (funding.kind === "nwc") {
        const invoice = await makeInvoice(amountSats, memo, 3600, funding.nwcUrl);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, nwcUrlEncrypted: encrypt(funding.nwcUrl), origin: posOrigin, expiresAt: invoice.expiresAt, ...(fiatSnapshot ?? {}) });
        return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt: invoice.expiresAt });
      }
      if (funding.kind === "lnaddress") {
        const { requestLnurlInvoice } = await import("./money/lnAddress.js");
        const invoice = await requestLnurlInvoice(funding.address, amountSats, memo);
        const expiresAt = new Date(Date.now() + 3600 * 1000);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, lnurlVerifyUrl: invoice.verifyUrl, origin: posOrigin, expiresAt, ...(fiatSnapshot ?? {}) });
        return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt, receiveOnly: true });
      }
      {
        const { blinkMakeInvoice } = await import("./money/blink.js");
        const invoice = await blinkMakeInvoice(funding.apiKey, funding.walletId, amountSats, memo, 60);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, origin: posOrigin, expiresAt: invoice.expiresAt, ...(fiatSnapshot ?? {}) });
        return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt: invoice.expiresAt });
      }
    }
    // Merchant cancelled the sale on the RIC or in the web POS. Closes a
    // wrap that has not been accepted yet; never touches accepted or paid.
    const posCancel = u.pathname.match(/^\/api\/pos\/invoice\/([^/]+)\/cancel$/);
    if (req.method === "POST" && posCancel) {
      if(!currentAccount)return json(res,401,{error:"Authentication required"});
      const paymentHash = decodeURIComponent(posCancel[1]);
      const [invoice] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
      if (!invoice || invoice.accountId!==currentAccount.id) return json(res, 404, { status: "unknown", paymentHash });
      if (invoice.paidAt || invoice.wrapStatus === "settled") return json(res, 200, { status: "paid", paymentHash });
      if (!invoice.wrapStatus) return json(res, 200, { status: invoice.expiresAt < new Date() ? "expired" : "pending", paymentHash, note: "direct invoices expire on their own" });
      const status = await cancelWrap(invoice as unknown as WrapRow, `merchant:${currentAccount.id}`);
      return json(res, 200, { status: status === "settled" ? "paid" : status, paymentHash });
    }
    const posStatus = u.pathname.match(/^\/api\/pos\/invoice\/([^/]+)\/status$/);
    if (req.method === "GET" && posStatus) {
      if(!currentAccount)return json(res,401,{error:"Authentication required"});
      const paymentHash = decodeURIComponent(posStatus[1]);
      const [invoice] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
      if (!invoice || invoice.accountId!==currentAccount.id) return json(res, 404, { status: "unknown", paymentHash });
      // Answer from the DB. The wrap driver owns relay traffic; a poll only
      // nudges it (non-blocking) so a stalled wrap still gets attention.
      return json(res, 200, { ...wrapStatusView(invoice), feeSats: invoice.feeSats ?? 0 });
    }
    // LNURL-pay endpoints are core money-path routes and deliberately root-level.
    const meta = u.pathname.match(/^\/.well-known\/lnurlp\/([^/]+)$/);
    if (req.method === "GET" && meta) {
      const handle = decodeURIComponent(meta[1]).toLowerCase();
      if (!(await accountForHandle(handle))) return json(res, 404, { status: "ERROR", reason: "User not found" });
      return json(res, 200, { tag: "payRequest", callback: `https://openln.com/lnurlp/${handle}/callback`, minSendable: 1000, maxSendable: 100_000_000_000, metadata: JSON.stringify([["text/plain", `Send sats to ${handle}`]]) });
    }
    const callback = u.pathname.match(/^\/lnurlp\/([^/]+)\/callback$/);
    if (req.method === "GET" && callback) {
      const account = await accountForHandle(decodeURIComponent(callback[1]));
      if (!account) return json(res, 404, { status: "ERROR", reason: "User not found" });
      const sats = Math.ceil(Number(u.searchParams.get("amount") ?? 0) / 1000);
      if (!Number.isSafeInteger(sats) || sats < 1) return json(res, 400, { status: "ERROR", reason: "Invalid amount" });
      const source = await resolveWalletSource(account.id);
      const funding = merchantFundingFromSource(source);
      if (!funding) return json(res, 400, { status: "ERROR", reason: "Wallet is not configured for receiving" });
      // Use the same wrapped hold-invoice path as POS: customer pays the
      // platform hold, then status polling forwards merchant sats and settles
      // the hold, recording the 2% fee in the core ledger.
      // Books: a payment to the Lightning address is a sale at today's rate.
      const lnFiat = await captureFiatSnapshot(account.id, sats, "receive");
      const wrap = await createWrappedInvoice(sats, "openLN payment", funding);
      if (wrap) {
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: funding.kind === "nwc" ? encrypt(funding.nwcUrl) : null, merchantBolt11: wrap.merchantBolt11, merchantPaymentHash: wrap.merchantPaymentHash, holdPreimage: wrap.holdPreimage, feeSats: wrap.feeSats, wrapStatus: "created", wrapUpdatedAt: new Date(), origin: "ln_address", expiresAt: wrap.expiresAt, ...(lnFiat ?? {}) });
        return json(res, 200, { pr: wrap.bolt11, routes: [] });
      }
      if (funding.kind === "nwc") {
        const invoice = await makeInvoice(sats, "openLN payment", 3600, funding.nwcUrl);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: encrypt(funding.nwcUrl), origin: "ln_address", expiresAt: invoice.expiresAt, ...(lnFiat ?? {}) });
        return json(res, 200, { pr: invoice.bolt11, routes: [] });
      }
      if (funding.kind === "lnaddress") {
        const { requestLnurlInvoice } = await import("./money/lnAddress.js");
        const invoice = await requestLnurlInvoice(funding.address, sats, "openLN payment");
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", lnurlVerifyUrl: invoice.verifyUrl, origin: "ln_address", expiresAt: new Date(Date.now() + 3600 * 1000), ...(lnFiat ?? {}) });
        return json(res, 200, { pr: invoice.bolt11, routes: [] });
      }
      {
        const { blinkMakeInvoice } = await import("./money/blink.js");
        const invoice = await blinkMakeInvoice(funding.apiKey, funding.walletId, sats, "openLN payment", 60);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", origin: "ln_address", expiresAt: invoice.expiresAt, ...(lnFiat ?? {}) });
        return json(res, 200, { pr: invoice.bolt11, routes: [] });
      }
    }
    // Wrapped invoice status is request-driven: each poll advances the
    // persisted hold -> forward -> settle state machine. This is the HTTP
    // bridge used by LNURL clients and browser-shaped checkout flows.
    // QR code (SVG) for a payment invoice - used by the wallet UI receive flow.
    const paymentQr = u.pathname.match(/^\/api\/payments\/([^/]+)\/qr$/);
    if (req.method === "GET" && paymentQr) {
      const paymentHash = decodeURIComponent(paymentQr[1]);
      const [invoice] = await db.select({ bolt11: pendingInvoicesTable.bolt11 }).from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
      if (!invoice?.bolt11) return json(res, 404, { error: "Invoice not found" });
      const QRCode = (await import("qrcode")).default;
      const svg = await QRCode.toString(`lightning:${invoice.bolt11}`, { type: "svg", margin: 1, width: 320, color: { dark: "#f4f6f5", light: "#0a0f0f" } });
      res.writeHead(200, { "content-type": "image/svg+xml", "cache-control": "no-store" });
      return res.end(svg);
    }
    const paymentStatus = u.pathname.match(/^\/api\/payments\/([^/]+)\/status$/);
    if (req.method === "GET" && paymentStatus) {
      const paymentHash = decodeURIComponent(paymentStatus[1]);
      const [invoice] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
      if (!invoice) return json(res, 404, { status: "unknown" });
      return json(res, 200, { ...wrapStatusView(invoice), feeSats: invoice.feeSats ?? 0 });
    }

    // Core money-path read surfaces. These remain deliberately small until the
    // session/auth layer is wired, but never pretend an unimplemented endpoint
    // is a successful payment operation. All responses come from PostgreSQL.
    if (req.method === "GET" && u.pathname === "/api/treasury") {
      const rows = await db.select({ status: transactionsTable.status, direction: transactionsTable.direction, type: transactionsTable.type, amountSats: transactionsTable.amountSats }).from(transactionsTable);
      const pendingSats = rows.filter(r => r.status === "pending").reduce((n, r) => n + (r.amountSats ?? 0), 0);
      const completedInboundSats = rows.filter(r => r.direction === "in" && r.status === "completed").reduce((n, r) => n + (r.amountSats ?? 0), 0);
      const feeRevenueSats = rows.filter(r => r.type === "fee" && r.status === "completed").reduce((n, r) => n + (r.amountSats ?? 0), 0);
      return json(res, 200, { pendingSats, completedInboundSats, feeRevenueSats, plugins: [] });
    }
    if (req.method === "GET" && u.pathname === "/api/accounts") {
      const handle = u.searchParams.get("handle")?.trim().toLowerCase();
      if (!handle) return json(res, 400, { error: "handle is required" });
      const account = await accountForHandle(handle);
      return account ? json(res, 200, { account }) : json(res, 404, { error: "Account not found" });
    }
    if (["/api/lnurlp", "/api/lnurlw", "/api/pos"].includes(u.pathname)) return json(res, 400, { error: "Use the documented resource endpoint" });
    return json(res, 404, { error: "Not found" });
  } catch (e) { return json(res, 500, { error: e instanceof Error ? e.message : "Internal server error" }); }
});
const port = Number(process.env.PORT ?? 3001);
let stopWrapDriver: (() => void) | undefined;
server.listen({ port, host: "0.0.0.0" }, () => {
  console.log(`openLN core listening on ${port}`);
  if (process.env.WRAP_DRIVER_ENABLED === "0") return;
  // One place advances hold-wraps; HTTP polls never touch the relay.
  stopWrapDriver = startWrapDriver();
  // Pending-send reconciliation + fallback sweep (was defined, never started).
  startInvoiceMonitor();
  // Push path: Alby Hub notifications advance a wrap the moment the customer's
  // HTLC locks. The driver sweep above is the safety net if the relay drops.
  startWrapNotifications().then((stop) => { stopWrapNotifications = stop; }).catch(() => {});
});
let stopWrapNotifications: (() => void) | undefined;
server.on("close", () => { stopWrapDriver?.(); stopWrapNotifications?.(); });
export { auth, wallet, registry };

export const __test = { accountForHandle };
export default server;
export type { IncomingMessage, ServerResponse };

