import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHmac } from "node:crypto";
import { readFile, appendFile, mkdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { AuthService } from "./auth/service.js";
import { WalletService } from "./wallet/service.js";
import { createBuiltinRegistry } from "./plugins/builtin.js";
import { db, entitiesTable, accountsTable, accountConnectionsTable, pendingInvoicesTable, transactionsTable, deviceTokensTable } from "./db/index.js";
import { and, eq, sql } from "drizzle-orm";
import { makeInvoice, resolveNwcUrl } from "./money/nwc.js";
import { captureFiatSnapshot } from "./money/fiatSnapshot.js";
import { createWrappedInvoice, cancelWrap, mintNofferInvoice, type WrapRow } from "./money/holdWrap.js";
import { encrypt } from "./money/encrypt.js";
import { resolveWalletSource, merchantFundingFromSource, assignDefaultIfUnset, syncLegacyWalletMirror } from "./money/walletSource.js";
import { connectionPublicView, connectionKindLabel, deriveConnectionLabel, uniqueConnectionLabel, connectionCapabilities } from "./money/connections.js";
import { parseClinkPointer, clinkRequestInvoice, generateClinkAppKey, describeClinkError, clinkRequestBudget, clinkAuthorizeFailure } from "./money/clink.js";
import { processClinkWebhook, ensureClinkHook, rotateClinkHook, clinkHookPaths } from "./money/clinkWebhook.js";
import { detectFunding } from "./money/fundingInput.js";
import { recordPaymentEvent } from "./money/paymentLog.js";
import { AmbiguousPaymentError } from "./money/feeEngine.js";
import { reconcileAccountInvoicesBounded, startInvoiceMonitor } from "./money/invoiceMonitor.js";
import { startWrapDriver, kickWrap, OPEN_WRAP_STATES, wrapDriverStats } from "./money/wrapDriver.js";
import { startWrapNotifications, wrapNotificationStats } from "./money/nwcNotifications.js";
import { startPartnerPayoutDriver } from "./money/partnerPayouts.js";
import { onAccountEvent } from "./events.js";
import { handleCardsPreview } from "../plugins/cards-preview.js";
import { handleCardsRoute } from "../plugins/cards.js";
import { handleReportsRoute } from "../plugins/reports.js";
import { handleExtensionsRoute } from "../plugins/extensions.js";
import { handlePosboxRoute } from "../plugins/posbox.js";
import { handlePosItemsRoute } from "../plugins/pos-items.js";
import { handleTelegramLinkRoute } from "../plugins/telegram-link.js";
import { handleShopRoute } from "../plugins/shop.js";
import { handlePartnerRoute } from "../plugins/partner.js";
import { handleAdminPaymentsRoute } from "./admin/adminPayments.js";
import { handleAdminUserbaseRoute } from "./admin/adminUserbase.js";
import { touchAccountActivity, recordActivityTimezone } from "./activity.js";
import { DOMAIN } from "./domain.js";

// A corrupt stored wallet can make the @getalby/sdk reject a DETACHED promise
// (executeNip47Request runs its work in an un-awaited async IIFE), which takes
// the whole payments process down with an unhandled rejection. Contain any
// such stray rejection: log it loudly and keep serving. Uncaught exceptions
// stay fatal on purpose - systemd brings the service back clean.
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  console.error(JSON.stringify({ level: 50, time: Date.now(), msg: "unhandled rejection contained", err: err.message, stack: err.stack }));
});

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
      // 'forwarded' already means the merchant was paid: the forward settled
      // on the platform node with a preimage, which proves delivery. The hold
      // settle that follows is bookkeeping (sub-second in practice), so report
      // success now instead of making the device wait for it.
      if (invoice.wrapStatus === "forwarded") return { status: "paid", paymentHash };
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
    // CLINK offer webhook - Lightning.Pub's paid callback. Authenticated by
    // the per-connection bearer secret, not a browser session; must stay in
    // front of the session-scoped routes. Contract + money-safety rules live
    // in core/money/clinkWebhook.ts.
    const clinkHookMatch = u.pathname.match(/^\/api\/clink\/hook\/([a-f0-9]{24})$/);
    if (req.method === "GET" && clinkHookMatch) {
      const outcome = await processClinkWebhook({ hookId: clinkHookMatch[1], searchParams: u.searchParams, authorization: req.headers.authorization ?? null });
      return json(res, outcome.status, outcome.body);
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
    // Web POS item catalog (session only; device tokens are refused above).
    if (await handlePosItemsRoute(req, res, u, currentAccount)) return;
    if (await handleTelegramLinkRoute(req, res, u, currentAccount)) return;
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
    if ((req.method === "GET" || req.method === "HEAD") && u.pathname.startsWith("/media/")) {
      const name = u.pathname.slice(7).replace(/[^a-zA-Z0-9._/-]/g, "");
      if (!name || name.includes("..") || name.startsWith("/") || name.endsWith("/")) return json(res, 404, { error: "Not found" });
      try {
        const { createReadStream } = await import("node:fs");
        const { stat } = await import("node:fs/promises");
        const file = new URL("../../artifacts/web/media/" + name, import.meta.url);
        const st = await stat(file);
        const type = name.endsWith(".mjs") ? "text/javascript; charset=utf-8" : name.endsWith(".wasm") ? "application/wasm" : name.endsWith(".mp4") ? "video/mp4" : name.endsWith(".png") ? "image/png" : name.endsWith(".jpg") ? "image/jpeg" : name.endsWith(".webp") ? "image/webp" : name.endsWith(".svg") ? "image/svg+xml" : name.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
        const headers: Record<string, string> = { "content-type": type, "cache-control": "public, max-age=86400", "accept-ranges": "bytes", "x-content-type-options": "nosniff" };
        // Range support: large downloads (the card writer APK) must be resumable
        // on flaky phone connections; a partial file reads as "problem parsing
        // the package" at install time.
        const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
        if (m && (m[1] || m[2])) {
          const start = m[1] ? parseInt(m[1], 10) : Math.max(0, st.size - parseInt(m[2], 10));
          let end = m[1] && m[2] ? parseInt(m[2], 10) : st.size - 1;
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= st.size) {
            res.writeHead(416, { ...headers, "content-range": `bytes */${st.size}` });
            return res.end();
          }
          end = Math.min(end, st.size - 1);
          res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${st.size}`, "content-length": String(end - start + 1) });
          if (req.method === "HEAD") return res.end();
          return createReadStream(file, { start, end }).pipe(res);
        }
        res.writeHead(200, { ...headers, "content-length": String(st.size) });
        if (req.method === "HEAD") return res.end();
        return createReadStream(file).pipe(res);
      } catch { return json(res, 404, { error: "Not found" }); }
    }
    // Crawlers: openln.com is indexable; every other host (dev.openln.com, raw IPs) is not.
    if ((req.method === "GET" || req.method === "HEAD") && u.pathname === "/robots.txt") {
      const host = String(req.headers.host ?? "").replace(/:\d+$/, "").toLowerCase();
      const body = host === "openln.com"
        ? "User-agent: *\nAllow: /\nDisallow: /api/\nSitemap: https://openln.com/sitemap.xml\n"
        : "User-agent: *\nDisallow: /\n";
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" });
      return res.end(body);
    }
    if ((req.method === "GET" || req.method === "HEAD") && u.pathname === "/sitemap.xml") {
      res.writeHead(200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" });
      return res.end('<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://openln.com/</loc></url>\n</urlset>\n');
    }
    if ((req.method === "GET" || req.method === "HEAD") && u.pathname === "/favicon.ico") {
      try {
        const data = await readFile(new URL("../../artifacts/web/media/brand/favicon-32.png", import.meta.url));
        res.writeHead(200, { "content-type": "image/png", "cache-control": "public, max-age=86400" });
        return res.end(data);
      } catch { return json(res, 404, { error: "Not found" }); }
    }
    if (req.method === "GET" && u.pathname === "/manifest.webmanifest") {
      try {
        const data = await (await import("node:fs/promises")).readFile(new URL("../../artifacts/web/manifest.webmanifest", import.meta.url), "utf8");
        res.writeHead(200, { "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" });
        return res.end(data);
      } catch { return json(res, 404, { error: "Not found" }); }
    }
    // Digital Asset Links: tells Android this site is related to the openLN
    // Card Writer app (app.bitpos.cardwriter), which enables
    // navigator.getInstalledRelatedApps() in the browser and https app links.
    if (req.method === "GET" && u.pathname === "/.well-known/assetlinks.json") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" });
      return res.end(JSON.stringify([{
        relation: ["delegate_permission/common.handle_all_urls"],
        target: {
          namespace: "android_app",
          package_name: "app.bitpos.cardwriter",
          sha256_cert_fingerprints: ["0F:78:13:08:8E:A8:79:8D:7D:05:E9:AB:5B:81:BB:70:A4:19:47:BE:3A:BB:08:C8:05:AC:B3:75:1B:E5:69:06"],
        },
      }], null, 2));
    }
    if (req.method === "GET" && u.pathname === "/") {
      try { return res.end(await (await import("node:fs/promises")).readFile(new URL("../../artifacts/web/landing.html", import.meta.url), "utf8")); }
      catch { return res.end("<!doctype html><title>openLN</title><h1>openLN</h1><a href='/app'>Open wallet</a>"); }
    }
    if (req.method === "GET" && (u.pathname === "/app" || u.pathname === "/app/" || u.pathname === "/partner" || u.pathname === "/partner/")) { try { const html = await readFile(join(process.cwd(), "artifacts/web/index.html"), "utf8"); res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); return res.end(html); } catch { return json(res, 500, { error: "Web application unavailable" }); } }
    // Card writer (/card-writer/): browser-based NTAG424 write/wipe tool for
    // BoltCards. Static page + engine served straight from the repo; the page
    // talks to a local bridge (Chrome extension or http://127.0.0.1:17777)
    // for the actual APDU transport, so no server-side crypto is involved.
    if (req.method === "GET" && (u.pathname === "/card-writer" || u.pathname === "/card-writer/")) { try { return res.end(await readFile(new URL("../../card-writer/web/index.html", import.meta.url), "utf8")); } catch { return json(res, 404, { error: "Card writer not found" }); } }
    if (req.method === "GET" && u.pathname.startsWith("/card-writer/")) {
      let rel = u.pathname.slice("/card-writer/".length).replace(/[^a-zA-Z0-9._/-]/g, "");
      const top = rel.split("/")[0];
      const rootFiles = ["install.sh", "install-windows.ps1", "README.md"];
      let dir: string;
      if (rootFiles.includes(rel)) dir = "";
      else if (top === "engine" || top === "bridge" || top === "extension") { dir = top + "/"; rel = rel.slice(top.length + 1); }
      else dir = "web/";
      if (!rel || rel.includes("..") || rel.startsWith("/") || rel.includes("//")) return json(res, 404, { error: "Not found" });
      try {
        const data = await readFile(new URL("../../card-writer/" + dir + rel, import.meta.url));
        const type = rel.endsWith(".html") ? "text/html; charset=utf-8" : rel.endsWith(".js") || rel.endsWith(".mjs") ? "text/javascript; charset=utf-8" : rel.endsWith(".css") ? "text/css; charset=utf-8" : rel.endsWith(".json") ? "application/json; charset=utf-8" : rel.endsWith(".svg") ? "image/svg+xml" : "text/plain; charset=utf-8";
        res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
        return res.end(data);
      } catch { return json(res, 404, { error: "Not found" }); }
    }
    if (req.method === "GET" && u.pathname === "/api/plugins") return json(res, 200, registry.list());
    if (req.method === "POST" && u.pathname === "/api/auth/register") { const v = await body(req); try { return json(res, 201, await auth.register(String(v.handle ?? ""), String(v.password ?? ""))); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "Invalid request" }); } }
    if (req.method === "POST" && u.pathname === "/api/auth/login") { const v = await body(req); try { const out = await auth.login(String(v.handle ?? ""), String(v.password ?? "")); if (out?.account?.id) void touchAccountActivity(out.account.id, req); return json(res, 200, out); } catch (e) { return json(res, 401, { error: e instanceof Error ? e.message : "Invalid credentials" }); } }
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
    // Admin userbase console (customer situational awareness: accounts, RIC
    // fleet telemetry, wallets, payments, support links, presence).
    if (u.pathname.startsWith("/api/admin/userbase")) {
      const account = await sessionAccount();
      if (await handleAdminUserbaseRoute(req, res, u, account)) return;
    }
    // ---- Presence telemetry (admin Userbase): app boot posts the browser
    // timezone; the server stamps IP + user agent. Throttled, best-effort. ----
    if (req.method === "POST" && u.pathname === "/api/activity") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      let tz: string | null = null;
      try { const v = await body(req); tz = typeof v?.timezone === "string" ? String(v.timezone) : null; } catch { /* body optional */ }
      await recordActivityTimezone(account.id, tz);
      await touchAccountActivity(account.id, req);
      return json(res, 200, { ok: true });
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
      // Saves a wallet connection on the account. The account can keep
      // several on file and choose what each feature uses in Settings; the
      // first connection becomes the default, later ones leave it unchanged.
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const connection = String(v.connection ?? v.nwcUrl ?? "").trim();
      const detected = detectFunding(connection);
      if (!detected) return json(res, 400, { error: "Paste a Nostr Wallet Connect connection, a Lightning Address (name@provider.com), or a Blink API key" });
      const existing = await db
        .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind, mode: accountConnectionsTable.mode, label: accountConnectionsTable.label, nwcUrlEncrypted: accountConnectionsTable.nwcUrlEncrypted, blinkApiKeyEncrypted: accountConnectionsTable.blinkApiKeyEncrypted, lightningAddress: accountConnectionsTable.lightningAddress, clinkPointer: accountConnectionsTable.clinkPointer })
        .from(accountConnectionsTable)
        .where(eq(accountConnectionsTable.accountId, account.id));

      if (detected.kind === "nwc") {
        try {
          const parsed=new URL(connection);
          if(parsed.protocol!=="nostr+walletconnect:" || !/^[0-9a-f]{64}$/i.test(parsed.hostname) || !/^[0-9a-f]{64}$/i.test(parsed.searchParams.get("secret")||"")) throw Error();
          const relays=parsed.searchParams.getAll("relay");
          if(!relays.length || relays.some(relay=>{const u=new URL(relay);return !["ws:","wss:"].includes(u.protocol)}))throw Error();
        } catch { return json(res,400,{error:"Paste the complete NWC connection, including relay and secret"}); }
        if (existing.some((row) => row.kind === "nwc" && row.mode === "custom" && resolveNwcUrl(row.nwcUrlEncrypted) === connection)) {
          return json(res, 409, { error: "This wallet is already connected." });
        }
        const {getBalance}=await import("./money/nwc.js");
        try{await getBalance(connection)}catch{return json(res,422,{error:"Could not read this wallet. Check its NWC permissions and connection; nothing was changed."});}
        const [created] = await db.insert(accountConnectionsTable).values({ accountId: account.id, kind: "nwc", mode: "custom", label: uniqueConnectionLabel(existing, deriveConnectionLabel("nwc", connection)), nwcUrlEncrypted: encrypt(connection) }).returning();
        const becameDefault = await assignDefaultIfUnset(account.id, created.id);
        return json(res, 200, { ok: true, connection: connectionPublicView(created), becameDefault, relays: (connection.match(/relay=/g) ?? []).length });
      }

      if (detected.kind === "lnaddress") {
        // Receive-only lane, generic across wallets. Providers WITH LUD-21
        // verify (Blink, Coinos, Alby) are confirmed from their side for the
        // rare direct fallback; providers without verify (Wallet of Satoshi)
        // connect as wrapped-only - every sale settles on the platform node
        // through the wrapped hold path, and the direct fallback refuses
        // (policy A) instead of minting an invoice nothing could observe.
        // The address is public - there is no secret to store or leak. It is
        // also the address shown in the app, so people can pay it directly.
        const { validateLightningAddressForWallet } = await import("./money/lnAddress.js");
        let check: { verifySupported: boolean };
        try { check = await validateLightningAddressForWallet(detected.address); }
        catch (err) { return json(res, 422, { error: err instanceof Error ? err.message : "This Lightning Address could not be validated" }); }
        if (existing.some((row) => row.kind === "lnaddress" && (row.lightningAddress ?? "").toLowerCase() === detected.address.toLowerCase())) {
          return json(res, 409, { error: "This wallet is already connected." });
        }
        const [created] = await db.insert(accountConnectionsTable).values({ accountId: account.id, kind: "lnaddress", label: uniqueConnectionLabel(existing, deriveConnectionLabel("lnaddress", detected.address)), lightningAddress: detected.address, lnurlVerifySupported: check.verifySupported }).returning();
        const becameDefault = await assignDefaultIfUnset(account.id, created.id);
        return json(res, 200, { ok: true, connection: connectionPublicView(created), becameDefault, receiveOnly: true, verifySupported: check.verifySupported });
      }

      if (detected.kind === "noffer" || detected.kind === "ndebit") {
        // CLINK pointer from Lightning.Pub / ShockWallet. noffer = receive,
        // proven at connect time with a tiny invoice request (nothing is
        // paid; the probe invoice just expires). ndebit = send - structural
        // check only, a probe would move money. The wallet sees one stable
        // app key per connection it can approve or rate-limit.
        const pointer = parseClinkPointer(detected.pointer);
        if (!pointer) return json(res, 400, { error: "That CLINK code could not be read. Paste the complete noffer1... or ndebit1... string." });
        if (pointer.kind === "ndebit" && pointer.k1) {
          return json(res, 400, { error: "That is a one-time session code. In your wallet open Linked apps and copy your static ndebit." });
        }
        if (existing.some((row) => row.kind === pointer.kind && row.clinkPointer === pointer.raw)) {
          return json(res, 409, { error: "This wallet is already connected." });
        }
        const appKey = generateClinkAppKey();
        if (pointer.kind === "noffer") {
          try {
            await clinkRequestInvoice({ pointer, appKey, amountSats: 21, description: "openLN connection check" });
          } catch (err) {
            return json(res, 422, { error: describeClinkError(err) });
          }
        }
        const [created] = await db.insert(accountConnectionsTable).values({ accountId: account.id, kind: pointer.kind, label: uniqueConnectionLabel(existing, deriveConnectionLabel(pointer.kind, pointer.raw)), clinkPointer: pointer.raw, clinkAppKeyEncrypted: encrypt(appKey) }).returning();
        const becameDefault = await assignDefaultIfUnset(account.id, created.id);
        // Offers get their paid-callback pair (public hook id + bearer secret)
        // immediately, so Settings can show the wallet-paste values without a
        // second write. Debits don't have webhooks - Lightning.Pub notifies
        // send outcomes over Nostr instead.
        const hook = pointer.kind === "noffer" ? await ensureClinkHook(created.id) : null;
        return json(res, 200, { ok: true, connection: connectionPublicView(created), becameDefault, receiveOnly: pointer.kind === "noffer", sendOnly: pointer.kind === "ndebit", ...(hook ? { webhook: { ...clinkHookPaths(hook.hookId), token: hook.token } } : {}) });
      }

      // Blink API key (custodial accounts). Read + Receive scopes cover
      // receiving and balance; sending still runs through NWC in this
      // release, so a Write scope is not required to connect.
      const { validateBlinkApiKeyForWallet } = await import("./money/blink.js");
      let blinkInfo: { walletId: string; walletCurrency: string; balanceSats: number };
      try { blinkInfo = await validateBlinkApiKeyForWallet(detected.apiKey); }
      catch (err) { return json(res, 422, { error: err instanceof Error ? err.message : "Could not read this Blink account" }); }
      if (existing.some((row) => row.kind === "blink" && resolveNwcUrl(row.blinkApiKeyEncrypted) === detected.apiKey)) {
        return json(res, 409, { error: "This wallet is already connected." });
      }
      const [created] = await db.insert(accountConnectionsTable).values({ accountId: account.id, kind: "blink", label: uniqueConnectionLabel(existing, deriveConnectionLabel("blink", null)), blinkApiKeyEncrypted: encrypt(detected.apiKey), blinkWalletId: blinkInfo.walletId, blinkWalletCurrency: blinkInfo.walletCurrency }).returning();
      const becameDefault = await assignDefaultIfUnset(account.id, created.id);
      return json(res, 200, { ok: true, connection: connectionPublicView(created), becameDefault, balanceSats: blinkInfo.balanceSats });
    }
    if (req.method === "GET" && u.pathname === "/api/events") {
      const account = await sessionAccount();
      if (!account) return json(res, 401, { error: "Authentication required" });
      void touchAccountActivity(account.id, req);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: ready\ndata: {}\n\n`);
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      const unsubscribe = onAccountEvent(account.id, send);
      const heartbeat = setInterval(() => res.write(": heartbeat\n\n"), 20_000);
      req.on("close", () => { clearInterval(heartbeat); unsubscribe(); });
      return;
    }
    if (req.method === "GET" && u.pathname === "/api/wallet/status") { const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" }); const source = await resolveWalletSource(account.id); const caps = connectionCapabilities(source.kind); return json(res, 200, { wallet: "non-custodial", connected: source.kind !== "none", receiveOnly: caps.receive && !caps.send, canSend: caps.send, canReceive: caps.receive, walletMode: source.kind === "nwc" ? source.mode : source.kind, lightningAddress: source.kind === "lnaddress" ? source.address : null, verifySupported: source.kind === "lnaddress" ? source.verifySupported : null, plugins: [] }); }
    if (req.method === "GET" && u.pathname === "/api/wallet/balance") { const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" }); await reconcileAccountInvoicesBounded(account.id); const source = await resolveWalletSource(account.id); if (source.kind === "nwc") { try { const { getBalance } = await import("./money/nwc.js"); const balance = await getBalance(source.nwcUrl); return json(res, 200, { balanceSats: balance.balanceSats, connected: true }); } catch { /* a stored wallet that cannot answer must never take the route (or the process) down */ return json(res, 200, { balanceSats: 0, connected: false, unavailable: true }); } } if (source.kind === "blink") { try { const { blinkGetBalance } = await import("./money/blink.js"); const balance = await blinkGetBalance(source.apiKey, source.walletId); return json(res, 200, { balanceSats: balance.balanceSats, connected: true }); } catch { return json(res, 200, { balanceSats: 0, connected: false, unavailable: true }); } } if (source.kind === "lnaddress") return json(res, 200, { balanceSats: 0, connected: false, receiveOnly: true }); return json(res, 200, { balanceSats: 0, connected: false }); }

    // Saved wallet connections: list with capabilities and assignments, set
    // default, remove, and per-feature assignment (RIC / Cards). Session-
    // scoped to the account; responses never carry secrets.
    if (req.method === "GET" && u.pathname === "/api/connections") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const [acc] = await db
        .select({ defaultConnectionId: accountsTable.defaultConnectionId, ricReceiveConnectionId: accountsTable.ricReceiveConnectionId, ricSendConnectionId: accountsTable.ricSendConnectionId, cardsReceiveConnectionId: accountsTable.cardsReceiveConnectionId, cardsSendConnectionId: accountsTable.cardsSendConnectionId })
        .from(accountsTable)
        .where(eq(accountsTable.id, account.id));
      const rows = await db
        .select()
        .from(accountConnectionsTable)
        .where(eq(accountConnectionsTable.accountId, account.id))
        .orderBy(accountConnectionsTable.createdAt, accountConnectionsTable.id);
      // Backfilled connections arrive with generic names ("Nostr Wallet
      // Connect"). Where the stored wallet itself names a provider, adopt
      // that name once so the pickers read like the wallet merchants chose.
      for (const row of rows) {
        const generic = connectionKindLabel(row.kind);
        if (row.label && row.label.trim() && row.label.trim() !== generic) continue;
        if (row.kind === "nwc" && row.mode !== "custom") continue;
        const raw = row.kind === "nwc" ? resolveNwcUrl(row.nwcUrlEncrypted) : row.kind === "lnaddress" ? row.lightningAddress : null;
        if (!raw) continue;
        const derived = deriveConnectionLabel(row.kind, raw);
        if (derived === generic) continue;
        const label = uniqueConnectionLabel(rows.filter((r) => r.id !== row.id), derived);
        await db.update(accountConnectionsTable).set({ label, updatedAt: new Date() }).where(eq(accountConnectionsTable.id, row.id));
        row.label = label;
      }
      const connections = rows.map((row) => {
        const view = connectionPublicView(row);
        const usedBy: string[] = [];
        if (acc?.ricReceiveConnectionId === row.id) usedBy.push("ric_receive");
        if (acc?.ricSendConnectionId === row.id) usedBy.push("ric_send");
        if (acc?.cardsReceiveConnectionId === row.id) usedBy.push("cards_receive");
        if (acc?.cardsSendConnectionId === row.id) usedBy.push("cards_send");
        return { ...view, isDefault: acc?.defaultConnectionId === row.id, usedBy };
      });
      return json(res, 200, { connections, assignments: { ric_receive: acc?.ricReceiveConnectionId ?? null, ric_send: acc?.ricSendConnectionId ?? null, cards_receive: acc?.cardsReceiveConnectionId ?? null, cards_send: acc?.cardsSendConnectionId ?? null }, defaultId: acc?.defaultConnectionId ?? null });
    }
    if (req.method === "POST" && u.pathname === "/api/connections/assign") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req);
      const patch: { ricReceiveConnectionId?: string | null; ricSendConnectionId?: string | null; cardsReceiveConnectionId?: string | null; cardsSendConnectionId?: string | null } = {};
      const slotFields = [
        ["ric_receive", "ricReceiveConnectionId"],
        ["ric_send", "ricSendConnectionId"],
        ["cards_receive", "cardsReceiveConnectionId"],
        ["cards_send", "cardsSendConnectionId"],
      ] as const;
      const slotNeeds: Record<string, "receive" | "send"> = { ric_receive: "receive", ric_send: "send", cards_receive: "receive", cards_send: "send" };
      for (const [key, field] of slotFields) {
        if (!(key in v)) continue;
        const raw = v[key];
        if (raw === null || raw === "") { patch[field] = null; continue; }
        const id = String(raw);
        const [conn] = await db
          .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind })
          .from(accountConnectionsTable)
          .where(and(eq(accountConnectionsTable.id, id), eq(accountConnectionsTable.accountId, account.id)));
        if (!conn) return json(res, 400, { error: "That wallet connection does not exist" });
        const caps = connectionCapabilities(conn.kind);
        if (slotNeeds[key] === "send" && !caps.send) return json(res, 400, { error: `${connectionKindLabel(conn.kind)} can't send - pick a wallet that can send for this slot` });
        if (slotNeeds[key] === "receive" && !caps.receive) return json(res, 400, { error: `${connectionKindLabel(conn.kind)} can't receive - pick a wallet that can receive for this slot` });
        patch[field] = id;
      }
      if (Object.keys(patch).length) await db.update(accountsTable).set(patch).where(eq(accountsTable.id, account.id));
      const [acc] = await db
        .select({ ricReceiveConnectionId: accountsTable.ricReceiveConnectionId, ricSendConnectionId: accountsTable.ricSendConnectionId, cardsReceiveConnectionId: accountsTable.cardsReceiveConnectionId, cardsSendConnectionId: accountsTable.cardsSendConnectionId })
        .from(accountsTable)
        .where(eq(accountsTable.id, account.id));
      return json(res, 200, { ok: true, assignments: { ric_receive: acc?.ricReceiveConnectionId ?? null, ric_send: acc?.ricSendConnectionId ?? null, cards_receive: acc?.cardsReceiveConnectionId ?? null, cards_send: acc?.cardsSendConnectionId ?? null } });
    }
    {
      // CLINK offer webhook values for the Settings copy-paste block. The
      // bearer secret is shown only here (owner-authenticated), never in the
      // connections list. Rotate keeps the URL, swaps the token.
      const connWebhook = u.pathname.match(/^\/api\/connections\/([^/]+)\/webhook$/);
      if (req.method === "GET" && connWebhook) {
        const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
        const id = decodeURIComponent(connWebhook[1]);
        const [conn] = await db
          .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind })
          .from(accountConnectionsTable)
          .where(and(eq(accountConnectionsTable.id, id), eq(accountConnectionsTable.accountId, account.id)));
        if (!conn) return json(res, 404, { error: "Connection not found" });
        if (conn.kind !== "noffer") return json(res, 400, { error: "Webhook callbacks apply to CLINK offers - this wallet is not a receive offer" });
        const hook = await ensureClinkHook(id);
        if (!hook) return json(res, 500, { error: "Could not prepare this webhook" });
        return json(res, 200, { ok: true, ...clinkHookPaths(hook.hookId), token: hook.token });
      }
      const connWebhookRotate = u.pathname.match(/^\/api\/connections\/([^/]+)\/webhook\/rotate$/);
      if (req.method === "POST" && connWebhookRotate) {
        const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
        const id = decodeURIComponent(connWebhookRotate[1]);
        const [conn] = await db
          .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind })
          .from(accountConnectionsTable)
          .where(and(eq(accountConnectionsTable.id, id), eq(accountConnectionsTable.accountId, account.id)));
        if (!conn) return json(res, 404, { error: "Connection not found" });
        if (conn.kind !== "noffer") return json(res, 400, { error: "Webhook callbacks apply to CLINK offers - this wallet is not a receive offer" });
        const hook = await rotateClinkHook(id);
        if (!hook) return json(res, 500, { error: "Could not rotate this webhook" });
        return json(res, 200, { ok: true, ...clinkHookPaths(hook.hookId), token: hook.token });
      }
      const connAuthorize = u.pathname.match(/^\/api\/connections\/([^/]+)\/authorize$/);
      if (req.method === "POST" && connAuthorize) {
        // Ask an ndebit wallet for a spending allowance (CLINK budget
        // request: amount + frequency, no bolt11 - nothing can move). Safe
        // to re-send: an allowance that already exists answers ok instantly,
        // so the same call doubles as a verify.
        const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
        const id = decodeURIComponent(connAuthorize[1]);
        const [conn] = await db
          .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind, clinkPointer: accountConnectionsTable.clinkPointer, clinkAppKeyEncrypted: accountConnectionsTable.clinkAppKeyEncrypted })
          .from(accountConnectionsTable)
          .where(and(eq(accountConnectionsTable.id, id), eq(accountConnectionsTable.accountId, account.id)));
        if (!conn) return json(res, 404, { error: "Connection not found" });
        if (conn.kind !== "ndebit") return json(res, 400, { error: "Authorizations apply to CLINK debit wallets - this connection does not send" });
        const v = await body(req);
        const amountSats = Math.floor(Number(v.amountSats));
        if (!Number.isFinite(amountSats) || amountSats < 1 || amountSats > 100_000_000) return json(res, 400, { error: "Enter an allowance between 1 and 100,000,000 sats" });
        const unit = v.unit === undefined ? "month" : String(v.unit);
        if (unit !== "day" && unit !== "week" && unit !== "month") return json(res, 400, { error: "The allowance period must be day, week, or month" });
        const number = v.number === undefined ? 1 : Number(v.number);
        if (!Number.isInteger(number) || number < 1 || number > 12) return json(res, 400, { error: "The allowance period must be a whole number from 1 to 12" });
        const pointer = conn.clinkPointer ? parseClinkPointer(conn.clinkPointer) : null;
        const appKey = resolveNwcUrl(conn.clinkAppKeyEncrypted);
        if (!pointer || pointer.kind !== "ndebit" || !appKey) return json(res, 500, { error: "This wallet's stored code could not be read - reconnect it" });
        try {
          await clinkRequestBudget({ pointer, appKey, amountSats, frequency: { number, unit }, description: "openLN send authorization" });
          return json(res, 200, { ok: true, status: "authorized", amountSats, frequency: { number, unit } });
        } catch (err) {
          return json(res, 200, { ok: false, ...clinkAuthorizeFailure(err) });
        }
      }
      const connDefault = u.pathname.match(/^\/api\/connections\/([^/]+)\/default$/);
      if (req.method === "POST" && connDefault) {
        const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
        const [conn] = await db
          .select({ id: accountConnectionsTable.id })
          .from(accountConnectionsTable)
          .where(and(eq(accountConnectionsTable.id, decodeURIComponent(connDefault[1])), eq(accountConnectionsTable.accountId, account.id)));
        if (!conn) return json(res, 404, { error: "Connection not found" });
        await db.update(accountsTable).set({ defaultConnectionId: conn.id }).where(eq(accountsTable.id, account.id));
        await syncLegacyWalletMirror(account.id);
        return json(res, 200, { ok: true, defaultId: conn.id });
      }
      const connDelete = u.pathname.match(/^\/api\/connections\/([^/]+)$/);
      if (req.method === "PATCH" && connDelete) {
        // Rename only. Shown in Settings and the RIC / Cards pickers.
        const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
        const id = decodeURIComponent(connDelete[1]);
        const v = await body(req);
        const label = typeof v.label === "string" ? v.label.trim().slice(0, 40) : "";
        if (!label) return json(res, 400, { error: "Wallet name cannot be empty" });
        const [conn] = await db
          .select({ id: accountConnectionsTable.id })
          .from(accountConnectionsTable)
          .where(and(eq(accountConnectionsTable.id, id), eq(accountConnectionsTable.accountId, account.id)));
        if (!conn) return json(res, 404, { error: "Connection not found" });
        await db.update(accountConnectionsTable).set({ label, updatedAt: new Date() }).where(eq(accountConnectionsTable.id, id));
        return json(res, 200, { ok: true, label });
      }
      if (req.method === "DELETE" && connDelete) {
        const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
        const id = decodeURIComponent(connDelete[1]);
        const rows = await db
          .select({ id: accountConnectionsTable.id })
          .from(accountConnectionsTable)
          .where(eq(accountConnectionsTable.accountId, account.id))
          .orderBy(accountConnectionsTable.createdAt, accountConnectionsTable.id);
        if (!rows.some((r) => r.id === id)) return json(res, 404, { error: "Connection not found" });
        if (rows.length <= 1) return json(res, 409, { error: "Add another wallet before removing this one." });
        await db.delete(accountConnectionsTable).where(and(eq(accountConnectionsTable.id, id), eq(accountConnectionsTable.accountId, account.id)));
        const [acc] = await db
          .select({ defaultConnectionId: accountsTable.defaultConnectionId })
          .from(accountsTable)
          .where(eq(accountsTable.id, account.id));
        if (acc && acc.defaultConnectionId === id) {
          const next = rows.find((r) => r.id !== id);
          await db.update(accountsTable).set({ defaultConnectionId: next?.id ?? null }).where(eq(accountsTable.id, account.id));
          await syncLegacyWalletMirror(account.id);
        }
        return json(res, 200, { ok: true });
      }
    }
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
      // Receive-only funding sources get an honest message instead of a
      // cryptic wallet error; NWC and Blink accounts both send.
      const paySource = await resolveWalletSource(account.id);
      if (!connectionCapabilities(paySource.kind).send) return json(res, 400, { error: "This wallet can't send. It may be receive-only or not fully set up - connect a wallet that can send (NWC, Blink, or a CLINK debit) in Settings." });
      try { const { parseBolt11AmountSats } = await import("./money/boltcard.js"); const { processExternalPayment, AmbiguousPaymentError } = await import("./money/feeEngine.js"); const amountSats = parseBolt11AmountSats(bolt11); if (!amountSats) return json(res, 400, { error: "Invoice has no valid amount" }); const result = await processExternalPayment(account.id, bolt11, amountSats, undefined, typeof v.memo === "string" ? v.memo.slice(0, 140) : "openLN send", undefined, undefined, "wallet");
        // Books: the sender declared what this payment is (spend / transfer to own wallet / refund). Stored as a user classification on the row.
        const purpose = String(v.purpose ?? ""); if (["spend", "transfer_out", "refund"].includes(purpose) && result.paymentHash) { await db.update(transactionsTable).set({ class: purpose as "spend" | "transfer_out" | "refund", classSource: "user" }).where(and(eq(transactionsTable.accountId, account.id), eq(transactionsTable.paymentHash, result.paymentHash), eq(transactionsTable.direction, "out"))).catch(() => {}); }
        return json(res, 200, { status: "completed", ...result }); } catch (e) { if (e instanceof AmbiguousPaymentError) return json(res, 202, { status: "pending", pendingTxId: e.pendingTxId, error: "Payment outcome is unknown; check Activity before retrying" }); return json(res, 400, { error: e instanceof Error ? e.message : "Payment failed" }); }
    }

    // Send scanner target resolution: accepts BOLT11, lightning addresses, LNURL
    // (bech32 / LUD-17 / raw https) and BIP21 bitcoin: URIs. Never pays; when an
    // LNURL-pay target comes with amountSats it mints the provider invoice so the
    // client can confirm and then pay it through /api/wallet/pay as usual.
    if (req.method === "POST" && u.pathname === "/api/wallet/resolve") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const input = String(v.input ?? "").trim();
      if (!input) return json(res, 400, { error: "Nothing to read" });
      if (input.length > 2000) return json(res, 400, { error: "That code is too long to read" });
      const amountSats = Number(v.amountSats);
      const comment = typeof v.comment === "string" ? v.comment.slice(0, 200) : undefined;
      try {
        const { resolveSendTarget } = await import("./money/lnurlTarget.js");
        const target = await resolveSendTarget(input, { amountSats: Number.isSafeInteger(amountSats) && amountSats > 0 ? amountSats : undefined, comment });
        return json(res, 200, target);
      } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "Could not read that code" }); }
    }

    // Scanner debug reports: the ?sd=1 diagnostic posts stats + a thumbnail of
    // the decoder input every few seconds so a merchant phone can be diagnosed
    // without screenshots. Auth-gated, size-capped, one rotated append file.
    if (req.method === "POST" && u.pathname === "/api/wallet/scan-debug") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      let v: Record<string, unknown> = {};
      try { v = await body(req); } catch { return json(res, 400, { error: "Invalid report" }); }
      const raw = JSON.stringify(v ?? {});
      if (raw.length > 300000) return json(res, 400, { error: "Report is too large" });
      try {
        const dir = join(process.cwd(), "var");
        await mkdir(dir, { recursive: true });
        const file = join(dir, "scan-debug.jsonl");
        const st = await stat(file).catch(() => null);
        if (st && st.size > 3 * 1024 * 1024) await rename(file, join(dir, "scan-debug.1.jsonl"));
        await appendFile(file, JSON.stringify({ at: new Date().toISOString(), accountId: account.id, report: v }) + "\n");
      } catch { /* diagnostics must never break a scan */ }
      return json(res, 200, { ok: true });
    }

    // POS invoice endpoint uses the identical wrapped hold path. The device
    // polls the payment status endpoint below; no direct-success shortcut.

    // POS invoice endpoint uses the identical wrapped hold path. The device
    // polls the payment status endpoint below; no direct-success shortcut.
    if (req.method === "POST" && u.pathname === "/api/pos/invoice") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const amountSats = Number(v.amountSats);
      if (!Number.isSafeInteger(amountSats) || amountSats < 1) return json(res, 400, { error: "amountSats must be a positive integer" });
      const memo = typeof v.memo === "string" ? v.memo.slice(0, 140) : "POS payment";
      // Books: a POS invoice is a sale. RIC requests carry a device token / deviceId; the browser POS does not.
      const fromRic = typeof v.deviceId === "string" || (req.headers["user-agent"] ?? "").toString().startsWith("openLN-RIC");
      // RIC sales land in the wallet assigned to the RIC in Settings; every
      // other surface on this route (web POS, wallet top-up) uses the default.
      const source = await resolveWalletSource(account.id, fromRic ? "ric_receive" : "default");
      const funding = merchantFundingFromSource(source);
      if (!funding) return json(res, 400, { error: "Wallet not configured" });
      // The wallet's own Receive screen declares purpose "top_up" (owner funding the wallet:
      // not income). Anything else on this route is a sale: RIC, or the browser POS.
      const posOrigin = fromRic ? "ric" : v.purpose === "top_up" ? "wallet" : "web_pos";
      // Partner rev-share: resolve the RIC's hardware MAC from its device token
      // (populated by /api/ric/hello telemetry). Captured at create time so the
      // settle can credit whichever partner registered this MAC.
      const deviceMac = cardToken && /^[0-9a-f]{64}$/.test(cardToken)
        ? (await db.select({ mac: deviceTokensTable.mac }).from(deviceTokensTable).where(eq(deviceTokensTable.token, cardToken)).limit(1))[0]?.mac?.toUpperCase() ?? undefined
        : undefined;
      // NOTE: the RIC (hardware) is always a sale; the browser Receive screen defaults to top_up
      // and the user flips it to "sale" when a customer is paying at the counter without a RIC.
      const fiatSnapshot = await captureFiatSnapshot(account.id, amountSats, "receive");
      const wrap = await createWrappedInvoice(amountSats, memo, funding);
      if (wrap) {
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats, memo, nwcUrlEncrypted: funding.kind === "nwc" ? encrypt(funding.nwcUrl) : null, connectionId: source.connectionId ?? null, merchantBolt11: wrap.merchantBolt11, merchantPaymentHash: wrap.merchantPaymentHash, holdPreimage: wrap.holdPreimage, posboxDeviceId: typeof v.deviceId === "string" ? v.deviceId : undefined, deviceMac, origin: posOrigin, feeSats: wrap.feeSats, wrapStatus: "created", wrapUpdatedAt: new Date(), expiresAt: wrap.expiresAt, ...(fiatSnapshot ?? {}) });
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
      if (funding.kind === "clink_offer") {
        // A CLINK offer settles directly only when the offer carries a
        // webhook: that push is our payment observer (Lightning.Pub calls our
        // callback when the invoice is paid). Without it nothing on our side
        // could observe a direct payment - like a verify-less Lightning
        // Address, refuse (policy A) so we never sell blind.
        if (funding.hasWebhook) {
          try {
            const invoice = await mintNofferInvoice(funding, amountSats, memo);
            const expiresAt = new Date(Date.now() + 3600 * 1000);
            await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, connectionId: source.connectionId ?? null, posboxDeviceId: typeof v.deviceId === "string" ? v.deviceId : undefined, deviceMac, origin: posOrigin, expiresAt, ...(fiatSnapshot ?? {}) });
            return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt });
          } catch (err) {
            recordPaymentEvent({ paymentId: "fallback", accountId: account.id, kind: "receive", event: "clink.direct_failed", status: "fail", method: "pos", message: describeClinkError(err), amountSats });
            return json(res, 503, { error: "Payments to this wallet are temporarily unavailable. Please retry in a moment." });
          }
        }
        recordPaymentEvent({ paymentId: "fallback", accountId: account.id, kind: "wrap", event: "wrap.fallback_refused", status: "info", method: "pos", message: `Direct fallback refused (wrapped path unavailable, CLINK offer has no payment webhook); ${amountSats} sat sale was not started`, amountSats });
        return json(res, 503, { error: "Payments to this wallet are temporarily unavailable. Please retry in a moment." });
      }
      // Direct (unwrapped) invoice - the fallback when wrapping is not
      // available, so a sale is never blocked. The funding source decides how
      // the invoice is minted and how settlement is observed (NWC lookups,
      // LUD-21 verify polling, or the Blink API). A verify-less Lightning
      // Address refuses here instead (policy A): nothing could confirm its
      // invoice, so it must retry the wrapped path rather than sell blind.
      if (funding.kind === "nwc") {
        const invoice = await makeInvoice(amountSats, memo, 3600, funding.nwcUrl);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, nwcUrlEncrypted: encrypt(funding.nwcUrl), connectionId: source.connectionId ?? null, origin: posOrigin, expiresAt: invoice.expiresAt, ...(fiatSnapshot ?? {}) });
        return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt: invoice.expiresAt });
      }
      if (funding.kind === "lnaddress") {
        // Policy A (2026-09-30): a verify-less provider (Wallet of Satoshi)
        // settles only through the wrapped path. When wrapping is unavailable,
        // refuse the sale rather than mint a direct invoice nothing could
        // observe; the merchant retries and the wrap path is tried again.
        if (source.kind === "lnaddress" && !source.verifySupported) {
          recordPaymentEvent({ paymentId: "fallback", accountId: account.id, kind: "wrap", event: "wrap.fallback_refused", status: "info", method: "pos", message: `Direct fallback refused (wrapped path unavailable, provider has no LUD-21 verify); ${amountSats} sat sale was not started`, amountSats });
          return json(res, 503, { error: "Payments to this wallet are temporarily unavailable. Please retry in a moment." });
        }
        const { requestLnurlInvoice } = await import("./money/lnAddress.js");
        const invoice = await requestLnurlInvoice(funding.address, amountSats, memo);
        const expiresAt = new Date(Date.now() + 3600 * 1000);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, lnurlVerifyUrl: invoice.verifyUrl, connectionId: source.connectionId ?? null, origin: posOrigin, expiresAt, ...(fiatSnapshot ?? {}) });
        return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt, receiveOnly: true });
      }
      {
        const { blinkMakeInvoice } = await import("./money/blink.js");
        const invoice = await blinkMakeInvoice(funding.apiKey, funding.walletId, amountSats, memo, 60);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, connectionId: source.connectionId ?? null, origin: posOrigin, expiresAt: invoice.expiresAt, ...(fiatSnapshot ?? {}) });
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
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: funding.kind === "nwc" ? encrypt(funding.nwcUrl) : null, connectionId: source.connectionId ?? null, merchantBolt11: wrap.merchantBolt11, merchantPaymentHash: wrap.merchantPaymentHash, holdPreimage: wrap.holdPreimage, feeSats: wrap.feeSats, wrapStatus: "created", wrapUpdatedAt: new Date(), origin: "ln_address", expiresAt: wrap.expiresAt, ...(lnFiat ?? {}) });
        return json(res, 200, { pr: wrap.bolt11, routes: [] });
      }
      if (funding.kind === "clink_offer") {
        // Same policy as the POS route: a direct offer invoice is observable
        // only through the offer's webhook (Lightning.Pub pushes the paid
        // callback). With one configured, mint directly; without it, the
        // wrapped path is the only safe settlement.
        if (funding.hasWebhook) {
          try {
            const invoice = await mintNofferInvoice(funding, sats, "openLN payment");
            const expiresAt = new Date(Date.now() + 3600 * 1000);
            await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", connectionId: source.connectionId ?? null, origin: "ln_address", expiresAt, ...(lnFiat ?? {}) });
            return json(res, 200, { pr: invoice.bolt11, routes: [] });
          } catch (err) {
            recordPaymentEvent({ paymentId: "fallback", accountId: account.id, kind: "receive", event: "clink.direct_failed", status: "fail", method: "lnurlp", message: describeClinkError(err), amountSats: sats });
            return json(res, 503, { status: "ERROR", reason: "This merchant cannot receive right now. Please retry in a moment." });
          }
        }
        recordPaymentEvent({ paymentId: "fallback", accountId: account.id, kind: "wrap", event: "wrap.fallback_refused", status: "info", method: "lnurlp", message: `Direct fallback refused (wrapped path unavailable, CLINK offer has no payment webhook); ${sats} sat payment was not started`, amountSats: sats });
        return json(res, 503, { status: "ERROR", reason: "This merchant cannot receive right now. Please retry in a moment." });
      }
      if (funding.kind === "nwc") {
        const invoice = await makeInvoice(sats, "openLN payment", 3600, funding.nwcUrl);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: encrypt(funding.nwcUrl), connectionId: source.connectionId ?? null, origin: "ln_address", expiresAt: invoice.expiresAt, ...(lnFiat ?? {}) });
        return json(res, 200, { pr: invoice.bolt11, routes: [] });
      }
      if (funding.kind === "lnaddress") {
        // Policy A: same as POS - a verify-less provider refuses when wrapping
        // is unavailable instead of minting an invoice nothing could observe.
        if (source.kind === "lnaddress" && !source.verifySupported) {
          recordPaymentEvent({ paymentId: "fallback", accountId: account.id, kind: "wrap", event: "wrap.fallback_refused", status: "info", method: "lnurlp", message: `Direct fallback refused (wrapped path unavailable, provider has no LUD-21 verify); ${sats} sat payment was not started`, amountSats: sats });
          return json(res, 503, { status: "ERROR", reason: "This merchant cannot receive right now. Please retry in a moment." });
        }
        const { requestLnurlInvoice } = await import("./money/lnAddress.js");
        const invoice = await requestLnurlInvoice(funding.address, sats, "openLN payment");
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", lnurlVerifyUrl: invoice.verifyUrl, connectionId: source.connectionId ?? null, origin: "ln_address", expiresAt: new Date(Date.now() + 3600 * 1000), ...(lnFiat ?? {}) });
        return json(res, 200, { pr: invoice.bolt11, routes: [] });
      }
      {
        const { blinkMakeInvoice } = await import("./money/blink.js");
        const invoice = await blinkMakeInvoice(funding.apiKey, funding.walletId, sats, "openLN payment", 60);
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", connectionId: source.connectionId ?? null, origin: "ln_address", expiresAt: invoice.expiresAt, ...(lnFiat ?? {}) });
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
let stopPartnerPayoutDriver: (() => void) | undefined;
server.listen({ port, host: "0.0.0.0" }, () => {
  console.log(`openLN core listening on ${port}`);
  if (process.env.WRAP_DRIVER_ENABLED === "0") return;
  // One place advances hold-wraps; HTTP polls never touch the relay.
  stopWrapDriver = startWrapDriver();
  // Partner payouts: executes requested payouts and reconciles stuck sends.
  stopPartnerPayoutDriver = startPartnerPayoutDriver();
  // Pending-send reconciliation + fallback sweep (was defined, never started).
  startInvoiceMonitor();
  // Push path: Alby Hub notifications advance a wrap the moment the customer's
  // HTLC locks. The driver sweep above is the safety net if the relay drops.
  startWrapNotifications().then((stop) => { stopWrapNotifications = stop; }).catch(() => {});
});
let stopWrapNotifications: (() => void) | undefined;
server.on("close", () => { stopWrapDriver?.(); stopWrapNotifications?.(); stopPartnerPayoutDriver?.(); });
export { auth, wallet, registry };

export const __test = { accountForHandle };
export default server;
export type { IncomingMessage, ServerResponse };

