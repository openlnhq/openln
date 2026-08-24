// openLN Phase 2 FINAL E2E: cross-wallet wrapped hold invoice
// PLATFORM wallet (ALBY_NWC_URL) mints hold + receives 1% fee.
// MERCHANT (also platform wallet, as Kongzi specified) receives forward.
// USER wallet (USER_NWC) pays the hold invoice.
const { createWrappedInvoice, advanceWrap } = await import("/home/kongzi/openln/dist/core/money/holdWrap.js");
const { payInvoice, lookupInvoice, getBalance } = await import("/home/kongzi/openln/dist/core/money/nwc.js");
const { db } = await import("/home/kongzi/openln/dist/core/db/index.js");
const { pendingInvoicesTable, accountsTable } = await import("/home/kongzi/openln/dist/core/db/schema/index.js");
const { eq, desc } = await import("drizzle-orm");

const platform = process.env.ALBY_NWC_URL;
const user = process.env.USER_NWC;

const platformBefore = (await getBalance(platform)).balanceSats;
console.log("platform before:", platformBefore);

// merchant account = the e2e-live account (its stored wallet is the platform wallet in this topology,
// but createWrappedInvoice takes merchantNwcUrl directly — pass the platform wallet per Kongzi's instruction)
const [acct] = await db.select().from(accountsTable).where(eq(accountsTable.walletMode, "custom")).limit(1);

// 1. create the wrapped invoice: hold on platform wallet, merchant invoice to be forwarded from platform float
const w = await createWrappedInvoice(1000, "openLN cross-wallet wrap E2E", platform);
if (!w) { console.error("WRAP NULL"); process.exit(1); }
console.log("WRAP CREATED fee=", w.feeSats);

// 2. persist like pos.ts does
await db.insert(pendingInvoicesTable).values({
  accountId: acct.id, bolt11: w.bolt11, paymentHash: w.paymentHash, amountSats: 1000,
  memo: "openLN cross-wallet wrap E2E", expiresAt: w.expiresAt,
  merchantBolt11: w.merchantBolt11, merchantPaymentHash: w.merchantPaymentHash,
  feeSats: w.feeSats, wrapStatus: "created", holdPreimage: w.holdPreimage,
});
console.log("ROW PERSISTED");

// 3. USER pays the hold invoice (cross-wallet — this is the leg that self-pay couldn't do)
try {
  const r = await payInvoice(w.bolt11, user);
  console.log("USER PAID HOLD: preimage", r.preimage.slice(0, 12) + "...", "routing fees:", r.feesPaidSats);
} catch (e) {
  console.error("USER PAY ERR (may be ambiguous):", e.message);
}

// 4. poll the wrap state machine to terminal state
let status = "created";
for (let i = 0; i < 36; i++) {
  const [row] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, w.paymentHash));
  status = await advanceWrap(row);
  if (["settled", "cancelled", "needs_reconciliation"].includes(status)) break;
  await new Promise(r => setTimeout(r, 8000));
}
console.log("FINAL WRAP STATUS:", status);

const [after] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, w.paymentHash));
console.log("AFTER:", JSON.stringify({ wrapStatus: after.wrapStatus, feeSats: after.feeSats, paidAt: after.paidAt, preimage: (after.preimage ?? "").slice(0, 12) + "..." }));

const platformAfter = (await getBalance(platform)).balanceSats;
console.log("platform after:", platformAfter, "(delta:", platformAfter - platformBefore, "sats, expect +fee -routing)");

// 5. verify treasury + payment_events
const { execSync } = await import("node:child_process");
process.exit(0);
