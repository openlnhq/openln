import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AuthService } from "./auth/service.js";
import { WalletService } from "./wallet/service.js";
import { createBuiltinRegistry } from "./plugins/builtin.js";
import { db, entitiesTable, accountsTable, pendingInvoicesTable, transactionsTable, paymentEventsTable } from "./db/index.js";
import { and, eq, sql } from "drizzle-orm";
import { makeInvoice } from "./money/nwc.js";
import { createWrappedInvoice, advanceWrap, type WrapRow } from "./money/holdWrap.js";
import { encrypt } from "./money/encrypt.js";
import { resolveWalletSource } from "./money/walletSource.js";
import { recordPaymentEvent } from "./money/paymentLog.js";
import { AmbiguousPaymentError } from "./money/feeEngine.js";
import { handleCardsRoute } from "../plugins/cards.js";
import { handleReportsRoute } from "../plugins/reports.js";
import { handleExtensionsRoute } from "../plugins/extensions.js";
import { handlePosboxRoute } from "../plugins/posbox.js";
import { handleShopRoute } from "../plugins/shop.js";
import { handlePartnerRoute } from "../plugins/partner.js";
const DOMAIN = process.env.DOMAIN ?? "openln.com";

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
    if (req.method === "GET" && u.pathname === "/health") return json(res, 200, { status: "ok", service: "openln-core", plugins: registry.list().map(p => p.id) });
    const cardToken = (req.headers.authorization ?? "").startsWith("Bearer ") ? (req.headers.authorization ?? "").slice(7) : String(req.headers.cookie ?? "").match(/openln_session=([^;]+)/)?.[1];
    const currentAccount = cardToken ? await auth.authenticate(cardToken) : undefined;
    if (await handlePartnerRoute(req,res,u)) return;
    if (await handlePosboxRoute(req,res,u,currentAccount)) return;
    if (handleShopRoute(req,res,u)) return;
    if (await handleExtensionsRoute(req,res,u,currentAccount)) return;
    if (await handleReportsRoute(req,res,u,currentAccount)) return;
    const cardsHandled = await handleCardsRoute(req, res, u, currentAccount); if (cardsHandled) return;
    if (req.method === "GET" && u.pathname === "/") {
      try { return res.end(await (await import("node:fs/promises")).readFile(new URL("../../artifacts/web/landing.html", import.meta.url), "utf8")); }
      catch { return res.end("<!doctype html><title>openLN</title><h1>openLN</h1><a href='/app'>Open wallet</a>"); }
    }
    if (req.method === "GET" && (u.pathname === "/app" || u.pathname === "/app/" || u.pathname === "/partner" || u.pathname === "/partner/")) { try { const html = await readFile(join(process.cwd(), "artifacts/web/index.html"), "utf8"); res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(html); } catch { return json(res, 500, { error: "Web application unavailable" }); } }
    if (req.method === "GET" && u.pathname === "/api/plugins") return json(res, 200, registry.list());
    if (req.method === "POST" && u.pathname === "/api/auth/register") { const v = await body(req); try { return json(res, 201, await auth.register(String(v.handle ?? ""), String(v.password ?? ""))); } catch (e) { return json(res, 400, { error: e instanceof Error ? e.message : "Invalid request" }); } }
    if (req.method === "POST" && u.pathname === "/api/auth/login") { const v = await body(req); try { return json(res, 200, await auth.login(String(v.handle ?? ""), String(v.password ?? ""))); } catch (e) { return json(res, 401, { error: e instanceof Error ? e.message : "Invalid credentials" }); } }
    const sessionAccount = async () => { const h = req.headers.authorization ?? ""; const token = h.startsWith("Bearer ") ? h.slice(7) : String(req.headers.cookie ?? "").match(/openln_session=([^;]+)/)?.[1]; return token ? auth.authenticate(token) : undefined; };
    if (req.method === "POST" && u.pathname === "/api/wallet/connect") {
      const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" });
      const v = await body(req); const connection = String(v.connection ?? v.nwcUrl ?? "").trim();
      if (!connection.startsWith("nostr+walletconnect://")) return json(res, 400, { error: "Invalid NWC connection string" });
      await db.update(accountsTable).set({ walletMode: "custom", customNwcUrl: encrypt(connection) }).where(eq(accountsTable.id, account.id));
      return json(res, 200, { ok: true, walletMode: "custom", connected: true, relays: (connection.match(/relay=/g) ?? []).length });
    }
    if (req.method === "GET" && u.pathname === "/api/wallet/status") { const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" }); const source = await resolveWalletSource(account.id); return json(res, 200, { wallet: "non-custodial", connected: source.kind === "nwc", walletMode: source.kind === "nwc" ? source.mode : source.kind, plugins: [] }); }
    if (req.method === "GET" && u.pathname === "/api/wallet/balance") { const account = await sessionAccount(); if (!account) return json(res, 401, { error: "Authentication required" }); const source = await resolveWalletSource(account.id); if (source.kind !== "nwc") return json(res, 200, { balanceSats: 0, connected: false }); const { getBalance } = await import("./money/nwc.js"); const balance = await getBalance(source.nwcUrl); return json(res, 200, { balanceSats: balance.balanceSats, connected: true }); }

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
      try { const { parseBolt11AmountSats } = await import("./money/boltcard.js"); const { processExternalPayment, AmbiguousPaymentError } = await import("./money/feeEngine.js"); const amountSats = parseBolt11AmountSats(bolt11); if (!amountSats) return json(res, 400, { error: "Invoice has no valid amount" }); const result = await processExternalPayment(account.id, bolt11, amountSats, undefined, "openLN send"); return json(res, 200, { status: "completed", ...result }); } catch (e) { if (e instanceof AmbiguousPaymentError) return json(res, 202, { status: "pending", pendingTxId: e.pendingTxId, error: "Payment outcome is unknown; check Activity before retrying" }); return json(res, 400, { error: e instanceof Error ? e.message : "Payment failed" }); }
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
      if (source.kind !== "nwc") return json(res, 400, { error: "Wallet not configured for NWC" });
      const memo = typeof v.memo === "string" ? v.memo.slice(0, 140) : "POS payment";
      const wrap = await createWrappedInvoice(amountSats, memo, source.nwcUrl);
      if (wrap) {
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats, memo, nwcUrlEncrypted: encrypt(source.nwcUrl), merchantBolt11: wrap.merchantBolt11, merchantPaymentHash: wrap.merchantPaymentHash, holdPreimage: wrap.holdPreimage, posboxDeviceId: typeof v.deviceId === "string" ? v.deviceId : undefined, feeSats: wrap.feeSats, wrapStatus: "created", wrapUpdatedAt: new Date(), expiresAt: wrap.expiresAt });
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
        return json(res, 201, { bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats, expiresAt: wrap.expiresAt });
      }
      const invoice = await makeInvoice(amountSats, memo, 3600, source.nwcUrl);
      await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, memo, nwcUrlEncrypted: encrypt(source.nwcUrl), expiresAt: invoice.expiresAt });
      return json(res, 201, { bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats, expiresAt: invoice.expiresAt });
    }
    const posStatus = u.pathname.match(/^\/api\/pos\/invoice\/([^/]+)\/status$/);
    if (req.method === "GET" && posStatus) {
      const paymentHash = decodeURIComponent(posStatus[1]);
      const [invoice] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, paymentHash));
      if (!invoice) return json(res, 404, { status: "unknown", paymentHash });
      if (invoice.wrapStatus) {
        const status = await advanceWrap(invoice as unknown as WrapRow);
        return json(res, 200, { status: status === "settled" ? "paid" : status, paymentHash, feeSats: invoice.feeSats ?? 0 });
      }
      return json(res, 200, { status: invoice.paidAt ? "paid" : invoice.expiresAt < new Date() ? "expired" : "pending", paymentHash, feeSats: 0 });
    }
    // LNURL-pay endpoints are core money-path routes and deliberately root-level.
    const meta = u.pathname.match(/^\/.well-known\/lnurlp\/([^/]+)$/);
    if (req.method === "GET" && meta) {
      const handle = decodeURIComponent(meta[1]).toLowerCase();
      if (!(await accountForHandle(handle))) return json(res, 404, { status: "ERROR", reason: "User not found" });
      return json(res, 200, { tag: "payRequest", callback: `/lnurlp/${handle}/callback`, minSendable: 1000, maxSendable: 100_000_000_000, metadata: JSON.stringify([["text/plain", `Send sats to ${handle}`]]) });
    }
    const callback = u.pathname.match(/^\/lnurlp\/([^/]+)\/callback$/);
    if (req.method === "GET" && callback) {
      const account = await accountForHandle(decodeURIComponent(callback[1]));
      if (!account) return json(res, 404, { status: "ERROR", reason: "User not found" });
      const sats = Math.ceil(Number(u.searchParams.get("amount") ?? 0) / 1000);
      if (!Number.isSafeInteger(sats) || sats < 1) return json(res, 400, { status: "ERROR", reason: "Invalid amount" });
      const source = await resolveWalletSource(account.id);
      if (source.kind !== "nwc") return json(res, 400, { status: "ERROR", reason: "Wallet is not configured for NWC receiving" });
      // Use the same wrapped hold-invoice path as POS: customer pays the
      // platform hold, then status polling forwards merchant sats and settles
      // the hold, recording the 1% fee in the core ledger.
      const wrap = await createWrappedInvoice(sats, "openLN payment", source.nwcUrl);
      if (wrap) {
        await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: wrap.bolt11, paymentHash: wrap.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: encrypt(source.nwcUrl), merchantBolt11: wrap.merchantBolt11, merchantPaymentHash: wrap.merchantPaymentHash, holdPreimage: wrap.holdPreimage, feeSats: wrap.feeSats, wrapStatus: "created", wrapUpdatedAt: new Date(), expiresAt: wrap.expiresAt });
        return json(res, 200, { pr: wrap.bolt11, routes: [] });
      }
      const invoice = await makeInvoice(sats, "openLN payment", 3600, source.nwcUrl);
      await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: encrypt(source.nwcUrl), expiresAt: invoice.expiresAt });
      return json(res, 200, { pr: invoice.bolt11, routes: [] });
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
      if (invoice.wrapStatus) {
        const status = await advanceWrap(invoice as unknown as WrapRow);
        return json(res, 200, { status: status === "settled" ? "paid" : status, paymentHash, feeSats: invoice.feeSats ?? 0 });
      }
      if (invoice.paidAt) return json(res, 200, { status: "paid", paymentHash, feeSats: 0 });
      return json(res, 200, { status: invoice.expiresAt < new Date() ? "expired" : "pending", paymentHash, feeSats: 0 });
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
    if (req.method === "GET" && (u.pathname === "/api/admin/payments" || u.pathname === "/api/adminPayments")) {
      const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") ?? 50)));
      const rows = await db.select().from(transactionsTable).limit(Number.isFinite(limit) ? limit : 50);
      return json(res, 200, { transactions: rows });
    }
    if (req.method === "GET" && u.pathname === "/api/admin/payment-events") {
      const limit = Math.min(100, Math.max(1, Number(u.searchParams.get("limit") ?? 50)));
      const rows = await db.select().from(paymentEventsTable).limit(Number.isFinite(limit) ? limit : 50);
      return json(res, 200, { events: rows });
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
const port = Number(process.env.PORT ?? 3001); server.listen({ port, host: "0.0.0.0" }, () => console.log(`openLN core listening on ${port}`));
export { auth, wallet, registry };

export const __test = { accountForHandle };
export default server;
export type { IncomingMessage, ServerResponse };

