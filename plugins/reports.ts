import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, transactionsTable, accountsTable, entitiesTable } from "../core/db/index.js";
import { TRANSACTION_CLASSES } from "../core/db/schema/transactions.js";
import type { TransactionClass } from "../core/db/schema/transactions.js";
import { reconcileAccountInvoicesBounded } from "../core/money/invoiceMonitor.js";
import { parseBooksFilter, listBooks, summarizeBooks, booksCsv, statementHtml, getBusinessProfile, saveBusinessProfile } from "../core/books/books.js";
import { CLASS_LABEL, ORIGIN_LABEL } from "../core/money/bookkeeping.js";

const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); return true; };
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []; for await (const c of req) chunks.push(c as Buffer);
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return {}; }
}
const reportId = (accountId: string, d: Date) => `OLN-${d.toISOString().slice(0, 10).replace(/-/g, "")}-${accountId.slice(0, 4).toUpperCase()}${d.getTime().toString(36).slice(-4).toUpperCase()}`;

// Books: the account's own ledger, valued at the fiat rate recorded at the
// moment of each payment. Routes live under /api/reports/* (the wallet History
// already reads /api/reports/transactions) and /api/books/*.
export async function handleReportsRoute(req: IncomingMessage, res: ServerResponse, u: URL, account: { id: string } | undefined): Promise<boolean> {
  if (!u.pathname.startsWith("/api/reports/") && !u.pathname.startsWith("/api/books/")) return false;
  if (!account) return json(res, 401, { error: "Authentication required" });

  // --- classification correction (the one write on this surface) ---
  const txPatch = u.pathname.match(/^\/api\/books\/transactions\/([0-9a-f-]{36})$/);
  if (req.method === "PATCH" && txPatch) {
    const v = await readBody(req);
    const set: Record<string, unknown> = {};
    if ("class" in v) {
      if (!(TRANSACTION_CLASSES as readonly string[]).includes(String(v.class))) return json(res, 400, { error: `class must be one of ${TRANSACTION_CLASSES.join(", ")}` });
      set.class = v.class as TransactionClass; set.classSource = "user";
    }
    if ("note" in v) set.note = v.note == null || v.note === "" ? null : String(v.note).slice(0, 500);
    if ("reference" in v) set.reference = v.reference == null || v.reference === "" ? null : String(v.reference).slice(0, 80);
    if (!Object.keys(set).length) return json(res, 400, { error: "Nothing to update" });
    const [row] = await db.update(transactionsTable).set(set).where(and(eq(transactionsTable.id, txPatch[1]), eq(transactionsTable.accountId, account.id))).returning();
    if (!row) return json(res, 404, { error: "Transaction not found" });
    return json(res, 200, { transaction: row });
  }

  // --- business profile (letterhead) ---
  if (u.pathname === "/api/books/profile") {
    if (req.method === "GET") return json(res, 200, { profile: await getBusinessProfile(account.id) });
    if (req.method === "PUT") return json(res, 200, { profile: await saveBusinessProfile(account.id, await readBody(req)) });
    return json(res, 405, { error: "Method not allowed" });
  }

  if (req.method !== "GET") return json(res, 405, { error: "Method not allowed" });
  await reconcileAccountInvoicesBounded(account.id);
  const f = parseBooksFilter(u);

  if (u.pathname === "/api/books/meta") {
    return json(res, 200, { classes: TRANSACTION_CLASSES.map((c) => ({ id: c, label: CLASS_LABEL[c] })), origins: Object.entries(ORIGIN_LABEL).map(([id, label]) => ({ id, label })) });
  }
  if (u.pathname === "/api/reports/summary" || u.pathname === "/api/books/summary") {
    return json(res, 200, await summarizeBooks(account.id, f));
  }
  if (u.pathname === "/api/reports/transactions" || u.pathname === "/api/books/transactions") {
    const { rows, total } = await listBooks(account.id, f);
    return json(res, 200, { transactions: rows, total });
  }
  if (u.pathname === "/api/books/export.csv") {
    const { rows } = await listBooks(account.id, { ...f, limit: 5000, offset: 0 });
    const fn = `openln-books-${f.from ? f.from.toISOString().slice(0, 10) : "all"}-${(f.to ?? new Date()).toISOString().slice(0, 10)}.csv`;
    res.writeHead(200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fn}"`, "cache-control": "no-store" });
    res.end("\ufeff" + booksCsv(rows)); return true;
  }
  if (u.pathname === "/api/books/statement") {
    const [{ rows }, summary, profile, [acct]] = await Promise.all([
      listBooks(account.id, { ...f, limit: 2000, offset: 0 }),
      summarizeBooks(account.id, f),
      getBusinessProfile(account.id),
      db.select({ handle: entitiesTable.handle }).from(accountsTable).innerJoin(entitiesTable, eq(entitiesTable.id, accountsTable.entityId)).where(eq(accountsTable.id, account.id)),
    ]);
    const now = new Date();
    const html = statementHtml({ profile, handle: acct?.handle ?? "account", summary, rows, filter: f, generatedAt: now, reportId: reportId(account.id, now) });
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(html); return true;
  }
  return json(res, 404, { error: "Not found" });
}
