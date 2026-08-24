// openLN Phase 2 FINAL E2E v2: three-wallet topology
// SENDER (NWC_SENDER_URL) pays the hold.
// PLATFORM (ALBY_NWC_URL) mints the hold, receives 1% fee, forwards to merchant.
// MERCHANT (NWC_USER_URL) receives the forwarded payment.
const { createWrappedInvoice, advanceWrap } = await import("/home/kongzi/openln/dist/core/money/holdWrap.js");
const { payInvoice, lookupInvoice, getBalance } = await import("/home/kongzi/openln/dist/core/money/nwc.js");
const { db } = await import("/home/kongzi/openln/dist/core/db/index.js");
const { pendingInvoicesTable, accountsTable } = await import("/home/kongzi/openln/dist/core/db/schema/index.js");
const { eq } = await import("drizzle-orm");

const platform = process.env.ALBY_NWC_URL;
const merchant = process.env.USER_NWC;
const sender = process.env.SENDER_NWC;

const pBefore = (await getBalance(platform)).balanceSats;
const mBefore = (await getBalance(merchant)).balanceSats;
console.log("platform:", pBefore, "| merchant:", mBefore);

// merchant account row (custom wallet)
const [acct] = await db.select().from(accountsTable).where(eq(accountsTable.walletMode, "custom")).limit(1);

// 1. wrapped invoice: hold on PLATFORM wallet, merchant invoice on MERCHANT wallet
const w = await createWrappedInvoice(1000, "openLN 3-wallet wrap E2E", merchant);
if (!w) { console.error("WRAP NULL"); process.exit(1); }
console.log("WRAP CREATED fee=", w.feeSats);

// 2. persist (pos.ts shape)
await db.insert(pendingInvoicesTable).values({
  accountId: acct.id, bolt11: w.bolt11, paymentHash: w.paymentHash, amountSats: 1000,
  memo: "openLN 3-wallet wrap E2E", expiresAt: w.expiresAt,
  merchantBolt11: w.merchantBolt11, merchantPaymentHash: w.merchantPaymentHash,
  feeSats: w.feeSats, wrapStatus: "created", holdPreimage: w.holdPreimage,
});
console.log("ROW PERSISTED");

// 3. SENDER pays the hold
try {
  const r = await payInvoice(w.bolt11, sender);
  console.log("SENDER PAID HOLD: fees:", r.feesPaidSats);
} catch (e) {
  console.error("SENDER PAY ERR (may be ambiguous):", e.message);
}

// 4. drive the wrap state machine to terminal
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

const pAfter = (await getBalance(platform)).balanceSats;
const mAfter = (await getBalance(merchant)).balanceSats;
console.log("platform delta:", pAfter - pBefore, "(expect +10 fee minus routing)");
console.log("merchant delta:", mAfter - pBefore === 0 ? "n/a" : mAfter - mBefore, "(expect +990 minus routing)");
process.exit(0);
