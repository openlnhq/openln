/**
 * Rizful one-click wallet provisioning. Session-authenticated only (device
 * tokens are refused upstream): these routes create a real Rizful account for
 * the signed-in merchant, link its NWC connection to the account, and hand
 * the login back to the owner.
 *
 *   POST /api/wallet/rizful/provision   start a run (queued, runs sequentially)
 *   GET  /api/wallet/rizful/provision   latest run for this account
 *
 * The heavy lifting lives in core/money/rizfulProvision.ts (browser + temp
 * mailbox + one-time-code exchange). Runs are serialized in-process and one
 * active run per account keeps a double-click from creating two accounts.
 * A run older than 15 minutes that never finished reads as interrupted
 * instead of blocking forever; credentials are encrypted at rest.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, desc, eq, gte, or } from "drizzle-orm";
import { db, accountConnectionsTable, rizfulProvisionsTable } from "../core/db/index.js";
import { encrypt, decrypt } from "../core/money/encrypt.js";
import { runRizfulFlow } from "../core/money/rizfulProvision.js";
import { uniqueConnectionLabel, deriveConnectionLabel } from "../core/money/connections.js";
import { assignDefaultIfUnset } from "../core/money/walletSource.js";
import { resolveNwcUrl, getBalance } from "../core/money/nwc.js";

const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); return true; };

const STALE_MS = 15 * 60_000;
const RETRY_COOLDOWN_MS = 10 * 60_000;

function provisionView(row: any) {
  const stale = (row.status === "pending" || row.status === "running")
    && row.updatedAt && Date.now() - new Date(row.updatedAt).getTime() > STALE_MS;
  const status = stale ? "error" : row.status;
  const view: Record<string, unknown> = {
    id: row.id,
    status,
    step: row.step,
    error: stale ? "Setup was interrupted. Try again." : row.error,
    createdAt: row.createdAt,
    rizfulEmail: row.rizfulEmail,
    lightningAddress: row.lightningAddress,
    connectionSaved: !!row.connectionId,
  };
  if (status === "done" && row.rizfulPasswordEncrypted) {
    try { view.rizfulPassword = decrypt(row.rizfulPasswordEncrypted); } catch { /* unreadable; leave out */ }
  }
  return view;
}

const queue: string[] = [];
let active = false;

function enqueue(provisionId: string): void {
  queue.push(provisionId);
  void drain();
}

async function drain(): Promise<void> {
  if (active) return;
  const id = queue.shift();
  if (!id) return;
  active = true;
  try {
    await processProvision(id);
  } catch (err) {
    console.error("[rizful] run failed:", err instanceof Error ? err.message : err);
  } finally {
    active = false;
    if (queue.length) void drain();
  }
}

async function processProvision(id: string): Promise<void> {
  const [row] = await db.select().from(rizfulProvisionsTable).where(eq(rizfulProvisionsTable.id, id));
  if (!row) return;
  const setStep = (step: string) =>
    db.update(rizfulProvisionsTable).set({ status: "running", step, updatedAt: new Date() })
      .where(eq(rizfulProvisionsTable.id, id)).catch(() => {});
  await setStep("Starting");
  try {
    const result = await runRizfulFlow({ onStep: (s) => void setStep(s) });

    // The wallet must answer before anything is saved (same probe the manual
    // connect route runs on pasted NWC strings).
    await getBalance(result.nwcUri);

    const existing = await db
      .select({ id: accountConnectionsTable.id, kind: accountConnectionsTable.kind, label: accountConnectionsTable.label, nwcUrlEncrypted: accountConnectionsTable.nwcUrlEncrypted })
      .from(accountConnectionsTable)
      .where(eq(accountConnectionsTable.accountId, row.accountId));
    let connectionId: string | null = null;
    const dup = existing.find((r) => r.kind === "nwc" && resolveNwcUrl(r.nwcUrlEncrypted) === result.nwcUri);
    if (dup) {
      connectionId = dup.id;
    } else {
      const [created] = await db.insert(accountConnectionsTable).values({
        accountId: row.accountId,
        kind: "nwc",
        mode: "custom",
        label: uniqueConnectionLabel(existing, deriveConnectionLabel("nwc", result.nwcUri)),
        nwcUrlEncrypted: encrypt(result.nwcUri),
      }).returning();
      connectionId = created.id;
      await assignDefaultIfUnset(row.accountId, created.id);
    }

    await db.update(rizfulProvisionsTable).set({
      status: "done",
      step: "Ready",
      error: null,
      rizfulEmail: result.rizfulEmail,
      rizfulPasswordEncrypted: encrypt(result.rizfulPassword),
      lightningAddress: result.lightningAddress,
      mailboxAddress: result.mailbox.address,
      mailboxPasswordEncrypted: encrypt(result.mailbox.password),
      mailboxTokenEncrypted: encrypt(result.mailbox.token),
      connectionId,
      updatedAt: new Date(),
    }).where(eq(rizfulProvisionsTable.id, id));
    console.log(`[rizful] provision ${id} ready for account ${row.accountId}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(rizfulProvisionsTable).set({
      status: "error", error: message.slice(0, 500), updatedAt: new Date(),
    }).where(eq(rizfulProvisionsTable.id, id)).catch(() => {});
    console.error(`[rizful] provision ${id} failed:`, message);
  }
}

export async function handleRizfulRoute(
  req: IncomingMessage,
  res: ServerResponse,
  u: URL,
  account: { id: string } | null | undefined,
): Promise<boolean> {
  if (u.pathname !== "/api/wallet/rizful/provision") return false;
  if (!account?.id) { json(res, 401, { error: "Authentication required" }); return true; }

  if (req.method === "GET") {
    const [row] = await db.select().from(rizfulProvisionsTable)
      .where(eq(rizfulProvisionsTable.accountId, account.id))
      .orderBy(desc(rizfulProvisionsTable.createdAt)).limit(1);
    json(res, 200, { provision: row ? provisionView(row) : null });
    return true;
  }

  if (req.method === "POST") {
    const [activeRow] = await db.select().from(rizfulProvisionsTable)
      .where(and(
        eq(rizfulProvisionsTable.accountId, account.id),
        or(eq(rizfulProvisionsTable.status, "pending"), eq(rizfulProvisionsTable.status, "running")),
      ))
      .orderBy(desc(rizfulProvisionsTable.createdAt)).limit(1);
    if (activeRow && Date.now() - new Date(activeRow.updatedAt).getTime() < STALE_MS) {
      json(res, 409, { error: "A Rizful setup is already running.", provision: provisionView(activeRow) });
      return true;
    }
    const [recent] = await db.select({ id: rizfulProvisionsTable.id }).from(rizfulProvisionsTable)
      .where(and(
        eq(rizfulProvisionsTable.accountId, account.id),
        eq(rizfulProvisionsTable.status, "done"),
        gte(rizfulProvisionsTable.createdAt, new Date(Date.now() - RETRY_COOLDOWN_MS)),
      )).limit(1);
    if (recent) {
      json(res, 429, { error: "A Rizful wallet was just created for this account. Try again in a few minutes." });
      return true;
    }
    const [created] = await db.insert(rizfulProvisionsTable).values({
      accountId: account.id, status: "pending", step: "Queued",
    }).returning();
    enqueue(created.id);
    console.log(`[rizful] provision ${created.id} queued for account ${account.id}`);
    json(res, 200, { ok: true, provision: provisionView(created) });
    return true;
  }

  json(res, 405, { error: "Method not allowed" });
  return true;
}
