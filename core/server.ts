import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { AuthService } from "./auth/service.js";
import { WalletService } from "./wallet/service.js";
import { PluginRegistry } from "./plugins/api.js";
import { db, entitiesTable, accountsTable, pendingInvoicesTable, transactionsTable, paymentEventsTable } from "./db/index.js";
import { and, eq, sql } from "drizzle-orm";
import { makeInvoice } from "./money/nwc.js";
import { encrypt } from "./money/encrypt.js";
import { resolveWalletSource } from "./money/walletSource.js";
const DOMAIN = process.env.DOMAIN ?? "openln.com";

const auth = new AuthService(); const wallet = new WalletService(); const registry = new PluginRegistry();
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
    if (req.method === "GET" && u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><title>openLN</title><main><h1>openLN</h1><p>Non-custodial Lightning workspace</p><a href="/app">Open wallet</a></main>'); }
    if (req.method === "GET" && u.pathname === "/app") { res.writeHead(200, { "content-type": "text/html" }); return res.end('<!doctype html><title>Wallet | openLN</title><main><h1>Wallet</h1><p>Connect your own NWC wallet to receive and send sats.</p><form method="post" action="/api/wallet/connect"><input name="connection" placeholder="nostr+walletconnect://…"><button>Connect wallet</button></form></main>'); }
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
      const invoice = await makeInvoice(sats, "openLN payment", 3600, source.nwcUrl);
      await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: invoice.bolt11, paymentHash: invoice.paymentHash, amountSats: sats, memo: "openLN payment", nwcUrlEncrypted: encrypt(source.nwcUrl), expiresAt: invoice.expiresAt });
      return json(res, 200, { pr: invoice.bolt11, routes: [] });
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

