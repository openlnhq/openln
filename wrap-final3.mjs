// openLN Phase 2 FINAL E2E v3: full clean run with the patched state machine.
// SENDER pays hold -> platform detects LOCKED (pending) -> forwards to merchant -> settles -> fee accrues.
const { createWrappedInvoice, advanceWrap } = await import("/home/kongzi/openln/dist/core/money/holdWrap.js");
const { payInvoice, getBalance } = await import("/home/kongzi/openln/dist/core/money/nwc.js");
const { db } = await import("/home/kongzi/openln/dist/core/db/index.js");
const { pendingInvoicesTable, accountsTable } = await import("/home/kongzi/openln/dist/core/db/schema/index.js");
const { eq } = await import("drizzle-orm");

const platform = process.env.ALBY_NWC_URL;
const merchant = process.env.SENDER_NWC;   // openlntestuser2 (merchant/receiver, 990 sats)
const sender   = process.env.USER_NWC;     // openlntestuser (funded sender)

const pBefore = (await getBalance(platform)).balanceSats;
const mBefore = (await getBalance(merchant)).balanceSats;
console.log("platform:", pBefore, "| merchant:", mBefore);

const [acct] = await db.select().from(accountsTable).where(eq(accountsTable.walletMode, "custom")).limit(1);

const w = await createWrappedInvoice(1000, "openLN full wrap E2E v3", merchant);
if (!w) { console.error("WRAP NULL"); process.exit(1); }
console.log("WRAP CREATED fee=", w.feeSats);

await db.insert(pendingInvoicesTable).values({
  accountId: acct.id, bolt11: w.bolt11, paymentHash: w.paymentHash, amountSats: 1000,
  memo: "openLN full wrap E2E v3", expiresAt: w.expiresAt,
  merchantBolt11: w.merchantBolt11, merchantPaymentHash: w.merchantPaymentHash,
  feeSats: w.feeSats, wrapStatus: "created", holdPreimage: w.holdPreimage,
});
console.log("ROW PERSISTED");

try {
  const r = await payInvoice(w.bolt11, sender);
  console.log("SENDER PAID HOLD: fees:", r.feesPaidSats);
} catch (e) {
  console.error("SENDER PAY ERR (ambiguous ok):", e.message);
}

let status = "created";
for (let i = 0; i < 36; i++) {
  const [row] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, w.paymentHash));
  status = await advanceWrap(row);
  if (["settled", "cancelled", "needs_reconciliation"].includes(status)) break;
  await new Promise(r => setTimeout(r, 8000));
}
console.log("FINAL WRAP STATUS:", status);

const [after] = await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash, w.paymentHash));
console.log("AFTER:", JSON.stringify({ wrapStatus: after.wrapStatus, feeSats: after.feeSats, paidAt: after.paidAt }));

const pAfter = (await getBalance(platform)).balanceSats;
const mAfter = (await getBalance(merchant)).balanceSats;
console.log("platform delta:", pAfter - pBefore, "(expect +10)");
console.log("merchant delta:", mAfter - mBefore, "(expect +990)");
process.exit(0);
