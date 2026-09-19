// Books. Bitcoin is money: every settled movement is reported at the fiat value
// recorded at the moment it happened, exactly like a cash sale. Nothing here
// re-prices anything at today's rate. Rows whose fiat snapshot is missing are
// reported in sats only and listed under "no fiat value recorded", never
// silently converted.

import { and, asc, desc, eq, gte, ilike, inArray, lte, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { db, transactionsTable, businessProfilesTable, accountsTable } from "../db/index.js";
import type { Transaction, TransactionClass } from "../db/schema/transactions.js";
import { CLASS_LABEL, ORIGIN_LABEL } from "../money/bookkeeping.js";
import { TRANSACTION_CLASSES } from "../db/schema/transactions.js";

export interface BooksFilter {
  from?: Date;
  to?: Date;
  classes?: TransactionClass[];
  direction?: "in" | "out";
  origins?: string[];
  search?: string;      // memo, note, reference, counterpart, payment hash prefix
  status?: "completed" | "all";
  limit?: number;
  offset?: number;
}

export function parseBooksFilter(u: URL): BooksFilter {
  const q = (k: string) => u.searchParams.get(k);
  const from = q("from") ? new Date(q("from")!) : undefined;
  const to = q("to") ? new Date(q("to")!) : undefined;
  const classes = (q("class") ?? "").split(",").map((s) => s.trim()).filter((s): s is TransactionClass => (TRANSACTION_CLASSES as readonly string[]).includes(s));
  const origins = (q("origin") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const direction = q("direction") === "in" || q("direction") === "out" ? (q("direction") as "in" | "out") : undefined;
  const search = (q("q") ?? "").trim().slice(0, 120) || undefined;
  const status = q("status") === "all" ? "all" : "completed";
  const limit = Math.min(5000, Math.max(1, Number(q("limit") ?? 500) || 500));
  const offset = Math.max(0, Number(q("offset") ?? 0) || 0);
  return {
    from: from && !isNaN(from.getTime()) ? from : undefined,
    to: to && !isNaN(to.getTime()) ? to : undefined,
    classes: classes.length ? classes : undefined,
    origins: origins.length ? origins : undefined,
    direction, search, status, limit, offset,
  };
}

function whereFor(accountId: string, f: BooksFilter): SQL {
  const parts: SQL[] = [eq(transactionsTable.accountId, accountId)];
  if (f.status !== "all") parts.push(eq(transactionsTable.status, "completed"));
  if (f.from) parts.push(gte(transactionsTable.createdAt, f.from));
  if (f.to) parts.push(lte(transactionsTable.createdAt, f.to));
  if (f.classes?.length) parts.push(inArray(transactionsTable.class, f.classes));
  if (f.origins?.length) parts.push(inArray(transactionsTable.origin, f.origins));
  if (f.direction) parts.push(eq(transactionsTable.direction, f.direction));
  if (f.search) {
    const like = `%${f.search.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    parts.push(or(
      ilike(transactionsTable.memo, like),
      ilike(transactionsTable.note, like),
      ilike(transactionsTable.reference, like),
      ilike(transactionsTable.counterpartHandle, like),
      ilike(transactionsTable.counterpartLnAddress, like),
      ilike(transactionsTable.paymentHash, `${f.search.toLowerCase()}%`),
    )!);
  }
  return and(...parts)!;
}

export async function listBooks(accountId: string, f: BooksFilter): Promise<{ rows: Transaction[]; total: number }> {
  const where = whereFor(accountId, f);
  const [rows, [{ total }]] = await Promise.all([
    db.select().from(transactionsTable).where(where).orderBy(desc(transactionsTable.createdAt)).limit(f.limit ?? 500).offset(f.offset ?? 0),
    db.select({ total: sql<number>`count(*)` }).from(transactionsTable).where(where),
  ]);
  return { rows, total: Number(total) };
}

// Totals per class. Sats are exact integers. Fiat is summed from the recorded
// per-row fiat_amount (decimal strings) with cents precision; rows without a
// snapshot are counted separately so the report can say so.
export interface ClassTotal {
  class: TransactionClass;
  label: string;
  count: number;
  sats: number;
  feeSats: number;
  fiat: string | null;         // "1234.56" in the report currency, null when nothing recorded
  fiatMissingCount: number;    // rows in this class with no fiat snapshot
}

export interface BooksSummary {
  currency: string | null;     // report currency (account currency), null when the account books in sats
  from: string | null;
  to: string | null;
  totals: ClassTotal[];
  salesFiat: string | null;
  refundsFiat: string | null;
  netSalesFiat: string | null;
  spendFiat: string | null;
  feesSats: number;
  inSats: number;
  outSats: number;
  rows: number;
  mixedCurrencies: string[];   // any fiat currencies on rows other than the report currency
}

function addDec(a: string | null, b: string | null): string | null {
  if (a == null && b == null) return null;
  // decimal add on strings via integer cents (round each to cents like a receipt)
  const cents = (x: string | null) => (x == null ? 0 : Math.round(Number(x) * 100));
  return ((cents(a) + cents(b)) / 100).toFixed(2);
}

export async function summarizeBooks(accountId: string, f: BooksFilter): Promise<BooksSummary> {
  const where = whereFor(accountId, { ...f, limit: undefined, offset: undefined });
  const [account] = await db.select({ currency: accountsTable.currency }).from(accountsTable).where(eq(accountsTable.id, accountId));
  const reportCurrency = account?.currency && account.currency !== "sats" ? account.currency : null;
  const rows = await db.select({
    class: transactionsTable.class, direction: transactionsTable.direction, amountSats: transactionsTable.amountSats,
    feeSats: transactionsTable.feeSats, fiatAmount: transactionsTable.fiatAmount, fiatCurrency: transactionsTable.fiatCurrency, type: transactionsTable.type,
  }).from(transactionsTable).where(where);

  const byClass = new Map<TransactionClass, ClassTotal>();
  for (const c of TRANSACTION_CLASSES) byClass.set(c, { class: c, label: CLASS_LABEL[c], count: 0, sats: 0, feeSats: 0, fiat: null, fiatMissingCount: 0 });
  const mixed = new Set<string>();
  let inSats = 0, outSats = 0, feesSats = 0;
  for (const r of rows) {
    const c: TransactionClass = r.class ?? (r.type === "fee" ? "fee" : "other");
    const t = byClass.get(c)!;
    t.count += 1; t.sats += r.amountSats; t.feeSats += r.feeSats;
    if (r.direction === "in") inSats += r.amountSats; else outSats += r.amountSats;
    feesSats += r.feeSats;
    if (r.fiatAmount != null && reportCurrency && (r.fiatCurrency ?? reportCurrency) === reportCurrency) t.fiat = addDec(t.fiat, r.fiatAmount);
    else { t.fiatMissingCount += 1; if (r.fiatCurrency && r.fiatCurrency !== reportCurrency) mixed.add(r.fiatCurrency); }
  }
  const g = (c: TransactionClass) => byClass.get(c)!.fiat;
  const neg = (x: string | null) => (x == null ? null : (-Number(x)).toFixed(2));
  return {
    currency: reportCurrency,
    from: f.from?.toISOString() ?? null,
    to: f.to?.toISOString() ?? null,
    totals: [...byClass.values()].filter((t) => t.count > 0),
    salesFiat: g("sale"),
    refundsFiat: g("refund"),
    netSalesFiat: addDec(g("sale"), neg(g("refund"))),
    spendFiat: g("spend"),
    feesSats, inSats, outSats, rows: rows.length,
    mixedCurrencies: [...mixed],
  };
}

// ---------------------------------------------------------------------------
// Business profile (letterhead)
// ---------------------------------------------------------------------------

export async function getBusinessProfile(accountId: string) {
  const [row] = await db.select().from(businessProfilesTable).where(eq(businessProfilesTable.accountId, accountId));
  return row ?? null;
}

const PROFILE_FIELDS = ["legalName", "tradingName", "taxId", "address", "city", "country", "email", "phone", "reportCurrency"] as const;
export async function saveBusinessProfile(accountId: string, v: Record<string, unknown>) {
  const set: Record<string, unknown> = { accountId, updatedAt: new Date() };
  for (const k of PROFILE_FIELDS) if (k in v) set[k] = v[k] == null || v[k] === "" ? null : String(v[k]).slice(0, 200);
  if ("fiscalYearStartMonth" in v) { const m = Number(v.fiscalYearStartMonth); if (Number.isInteger(m) && m >= 1 && m <= 12) set.fiscalYearStartMonth = m; }
  await db.insert(businessProfilesTable).values(set as typeof businessProfilesTable.$inferInsert)
    .onConflictDoUpdate({ target: businessProfilesTable.accountId, set });
  return getBusinessProfile(accountId);
}

// ---------------------------------------------------------------------------
// Renderers. Numbers are formatted here for display only; no derivation.
// ---------------------------------------------------------------------------

const esc = (s: unknown) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
const csvCell = (s: unknown) => { const v = s == null ? "" : String(s); return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v; };
const fmtSats = (n: number) => n.toLocaleString("en-US");
const fmtFiat = (v: string | null, cur: string | null) => (v == null ? "" : `${Number(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${(cur ?? "").toUpperCase()}`);
const fmtDate = (d: Date) => d.toISOString().replace("T", " ").slice(0, 19) + " UTC";

export function booksCsv(rows: Transaction[]): string {
  const head = ["date_utc", "class", "origin", "direction", "status", "amount_sats", "fee_sats", "fiat_currency", "fiat_amount", "fiat_rate", "rate_source", "rate_at_utc", "memo", "note", "reference", "counterpart", "payment_hash", "id"];
  const lines = [head.join(",")];
  for (const r of rows) {
    lines.push([
      fmtDate(r.createdAt), r.class ?? "", r.origin ?? "", r.direction, r.status, r.amountSats, r.feeSats,
      r.fiatCurrency ? r.fiatCurrency.toUpperCase() : "", r.fiatAmount == null ? "" : Number(r.fiatAmount).toFixed(2),
      r.fiatEffectiveRate ?? "", r.fiatRateSource ?? "", r.fiatRateAt ? fmtDate(r.fiatRateAt) : "",
      r.memo ?? "", r.note ?? "", r.reference ?? "", r.counterpartLnAddress ?? r.counterpartHandle ?? "", r.paymentHash ?? "", r.id,
    ].map(csvCell).join(","));
  }
  return lines.join("\r\n") + "\r\n";
}

export interface StatementInput {
  profile: Awaited<ReturnType<typeof getBusinessProfile>>;
  handle: string;
  summary: BooksSummary;
  rows: Transaction[];
  filter: BooksFilter;
  generatedAt: Date;
  reportId: string;
}

// Self-contained printable statement. Light theme, Inter/system font, no emoji,
// prints to PDF from any browser (window.print). Same markup for screen + paper.
export function statementHtml(inp: StatementInput): string {
  const { profile: p, summary: s, rows, filter: f } = inp;
  const cur = s.currency;
  const name = p?.tradingName || p?.legalName || inp.handle;
  const period = `${f.from ? f.from.toISOString().slice(0, 10) : "beginning"} to ${f.to ? f.to.toISOString().slice(0, 10) : inp.generatedAt.toISOString().slice(0, 10)}`;
  const address = [p?.address, [p?.city, p?.country].filter(Boolean).join(", ")].filter(Boolean);
  const filters = [
    f.classes?.length ? `Classes: ${f.classes.map((c) => CLASS_LABEL[c]).join(", ")}` : null,
    f.origins?.length ? `Sources: ${f.origins.map((o) => ORIGIN_LABEL[o] ?? o).join(", ")}` : null,
    f.direction ? `Direction: ${f.direction === "in" ? "incoming" : "outgoing"}` : null,
    f.search ? `Search: "${f.search}"` : null,
  ].filter(Boolean) as string[];

  const totalRows = s.totals.map((t) => `<tr><td>${esc(t.label)}</td><td class="n">${t.count}</td><td class="n">${fmtSats(t.sats)}</td><td class="n">${cur ? esc(fmtFiat(t.fiat, cur)) : ""}${t.fiatMissingCount && cur ? `<div class="small">${t.fiatMissingCount} without fiat value</div>` : ""}</td></tr>`).join("");
  const lineRows = rows.map((r) => `<tr>
    <td class="mono">${esc(fmtDate(r.createdAt).slice(0, 16))}</td>
    <td>${esc(CLASS_LABEL[(r.class ?? "other") as TransactionClass])}${r.classSource === "user" ? ' <span class="small">(edited)</span>' : ""}</td>
    <td>${esc(ORIGIN_LABEL[r.origin ?? ""] ?? r.origin ?? "")}</td>
    <td>${esc([r.memo, r.note, r.reference ? `Ref ${r.reference}` : null].filter(Boolean).join(" / "))}</td>
    <td class="n mono">${r.direction === "out" ? "-" : ""}${fmtSats(r.amountSats)}</td>
    <td class="n mono">${r.fiatAmount != null ? esc(fmtFiat(r.direction === "out" ? (-Number(r.fiatAmount)).toFixed(2) : r.fiatAmount, r.fiatCurrency ?? cur)) : '<span class="small">not recorded</span>'}</td>
    <td class="n mono small">${r.fiatEffectiveRate ? esc(Number(r.fiatEffectiveRate).toLocaleString("en-US", { maximumFractionDigits: 2 })) : ""}</td>
  </tr>`).join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Statement ${esc(inp.reportId)} - ${esc(name)}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{color-scheme:light}
  *{box-sizing:border-box}
  body{margin:0;background:#fff;color:#111;font:13px/1.45 Inter,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
  .page{max-width:900px;margin:0 auto;padding:36px 40px}
  .head{display:flex;justify-content:space-between;gap:24px;border-bottom:2px solid #111;padding-bottom:16px}
  .brand{font-weight:700;font-size:18px;letter-spacing:.2px}
  .brand small{display:block;font-weight:400;color:#555;font-size:12px}
  .biz{text-align:right;font-size:12.5px;color:#222}
  .biz b{display:block;font-size:15px;color:#111}
  h1{font-size:20px;margin:22px 0 2px}
  .meta{color:#555;font-size:12px}
  .meta span{display:inline-block;margin-right:16px}
  .doctrine{margin:16px 0 0;padding:10px 12px;border:1px solid #ddd;background:#fafafa;font-size:12px;color:#333}
  table{width:100%;border-collapse:collapse;margin-top:14px}
  th,td{padding:7px 8px;border-bottom:1px solid #e5e5e5;text-align:left;vertical-align:top}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555;border-bottom:1px solid #111}
  td.n,th.n{text-align:right;white-space:nowrap}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px}
  .small{font-size:11px;color:#666}
  .kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-top:16px}
  .kpi{border:1px solid #ddd;padding:10px 12px}
  .kpi .l{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:#555}
  .kpi .v{font-size:17px;font-weight:700;margin-top:2px}
  .kpi .s{font-size:11.5px;color:#555}
  h2{font-size:14px;margin:26px 0 0;text-transform:uppercase;letter-spacing:.06em;color:#333}
  .foot{margin-top:28px;padding-top:12px;border-top:1px solid #ddd;font-size:11px;color:#555;display:flex;justify-content:space-between;gap:16px}
  .toolbar{position:sticky;top:0;background:#fff;border-bottom:1px solid #ddd;padding:10px 40px;display:flex;gap:10px;align-items:center;font-size:13px}
  .toolbar button{font:inherit;padding:7px 14px;border:1px solid #111;background:#111;color:#fff;border-radius:6px;cursor:pointer}
  .toolbar a{color:#111}
  @media print{.toolbar{display:none}.page{padding:0}@page{margin:16mm 14mm}}
</style></head><body>
<div class="toolbar"><button onclick="window.print()">Save as PDF / Print</button><span class="small">Use your browser's print dialog and choose "Save as PDF".</span></div>
<div class="page">
  <div class="head">
    <div class="brand">${esc(name)}<small>Statement of Bitcoin transactions</small></div>
    <div class="biz">${p?.legalName ? `<b>${esc(p.legalName)}</b>` : ""}${p?.tradingName && p?.legalName && p.tradingName !== p.legalName ? `<div>trading as ${esc(p.tradingName)}</div>` : ""}${p?.taxId ? `<div>Tax ID ${esc(p.taxId)}</div>` : ""}${address.map((a) => `<div>${esc(a)}</div>`).join("")}${p?.email ? `<div>${esc(p.email)}</div>` : ""}${p?.phone ? `<div>${esc(p.phone)}</div>` : ""}</div>
  </div>
  <h1>Statement ${esc(inp.reportId)}</h1>
  <div class="meta"><span>Period ${esc(period)}</span><span>Generated ${esc(fmtDate(inp.generatedAt))}</span><span>Account ${esc(inp.handle)}@openln.com</span>${cur ? `<span>Report currency ${esc(cur.toUpperCase())}</span>` : `<span>Books kept in sats</span>`}</div>
  ${filters.length ? `<div class="meta" style="margin-top:4px">${filters.map((x) => `<span>${esc(x)}</span>`).join("")}</div>` : ""}
  <p class="doctrine">Each line is valued in ${cur ? esc(cur.toUpperCase()) : "sats"} at the exchange rate recorded at the moment the payment settled, in the same way a cash sale is booked at its price on the day. Later movements of the bitcoin price do not change these figures. Rate source and time are shown per line. Sats amounts are exact.</p>
  ${cur ? `<div class="kpis">
    <div class="kpi"><div class="l">Sales</div><div class="v">${esc(fmtFiat(s.salesFiat ?? "0", cur))}</div><div class="s">${s.totals.find((t) => t.class === "sale")?.count ?? 0} transactions</div></div>
    <div class="kpi"><div class="l">Refunds</div><div class="v">${esc(fmtFiat(s.refundsFiat ?? "0", cur))}</div><div class="s">${s.totals.find((t) => t.class === "refund")?.count ?? 0} transactions</div></div>
    <div class="kpi"><div class="l">Net sales</div><div class="v">${esc(fmtFiat(s.netSalesFiat ?? "0", cur))}</div><div class="s">sales minus refunds</div></div>
    <div class="kpi"><div class="l">Spend</div><div class="v">${esc(fmtFiat(s.spendFiat ?? "0", cur))}</div><div class="s">${s.totals.find((t) => t.class === "spend")?.count ?? 0} transactions</div></div>
  </div>` : ""}
  <h2>Totals by class</h2>
  <table><thead><tr><th>Class</th><th class="n">Count</th><th class="n">Sats</th><th class="n">${cur ? esc(cur.toUpperCase()) : ""}</th></tr></thead><tbody>${totalRows}
  <tr><td><b>Received</b></td><td></td><td class="n"><b>${fmtSats(s.inSats)}</b></td><td></td></tr>
  <tr><td><b>Sent</b></td><td></td><td class="n"><b>${fmtSats(s.outSats)}</b></td><td></td></tr>
  <tr><td>Fees paid (sats)</td><td></td><td class="n">${fmtSats(s.feesSats)}</td><td></td></tr></tbody></table>
  <p class="small">Top-ups and transfers to the owner's own wallet are the owner's money moving, not income or expense. They are listed for completeness and excluded from Sales and Spend.${s.mixedCurrencies.length ? ` Some lines were recorded in ${esc(s.mixedCurrencies.join(", ").toUpperCase())} and are not added to the ${esc((cur ?? "").toUpperCase())} totals.` : ""}</p>
  <h2>Transactions (${rows.length}${rows.length < s.rows ? ` of ${s.rows}, most recent first` : ""})</h2>
  <table><thead><tr><th>Date (UTC)</th><th>Class</th><th>Source</th><th>Description</th><th class="n">Sats</th><th class="n">${cur ? esc(cur.toUpperCase()) : "Fiat"}</th><th class="n">Rate</th></tr></thead><tbody>${lineRows || `<tr><td colspan="7" class="small">No transactions in this period.</td></tr>`}</tbody></table>
  <div class="foot"><div>Produced by openln.com from the account's own transaction ledger. Payments settle to the account holder's own wallet; openLN holds no balance.</div><div class="mono">${esc(inp.reportId)}</div></div>
</div></body></html>`;
}
