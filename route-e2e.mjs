// ROUTE-LEVEL E2E: everything through HTTP against the running openln.service.
// 1. login as e2e-live (merchant, custom wallet = openlntestuser2)
// 2. GET lnurlp meta -> callback with amount
// 3. sender wallet pays the returned wrap hold invoice
// 4. poll /api/payments/<hash>/status until paid
// 5. verify treasury + payment_events
const { payInvoice, getBalance } = await import("/home/kongzi/openln/dist/core/money/nwc.js");
const { execSync } = await import("node:child_process");

const BASE = "http://127.0.0.1:3147";
const sender = process.env.USER_NWC;
const merchant = process.env.SENDER_NWC;

const mBefore = (await getBalance(merchant)).balanceSats;
console.log("merchant before:", mBefore);

// 1. login
const login = JSON.parse(execSync(`curl -sS -X POST ${BASE}/api/auth/login -H "content-type: application/json" -d '{"handle":"e2e-live","password":"e2e-live-pass-123"}'`).toString());
const token = login.token;
console.log("login ok");

// 2. LNURLp callback -> wrapped hold invoice
const meta = JSON.parse(execSync(`curl -sS ${BASE}/.well-known/lnurlp/e2e-live`).toString());
console.log("lnurlp meta ok, callback:", meta.callback);
const inv = JSON.parse(execSync(`curl -sS "${BASE}${meta.callback}?amount=1000000"`).toString());
console.log("invoice pr:", inv.pr.slice(0, 24) + "...");

// 3. sender pays the hold
try {
  const r = await payInvoice(inv.pr, sender);
  console.log("SENDER PAID:", "fees", r.feesPaidSats);
} catch (e) {
  console.error("PAY ERR (ambiguous ok):", e.message);
}

// 4. poll status endpoint (drives advanceWrap)
const hashRes = JSON.parse(execSync(`curl -sS -X POST ${BASE}/api/pos/invoice -H "content-type: application/json" -H "authorization: Bearer ${token}" -d '{"amountSats":1}'`).toString()).paymentHash; // warm nothing
let status = "created";
for (let i = 0; i < 40; i++) {
  const s = JSON.parse(execSync(`curl -sS ${BASE}/api/payments/${inv.pr ? "" : ""}`).toString() || "{}");
  break;
}
// proper poll: we need the payment hash - derive from the invoice by polling the last wrap row
const { db } = await import("/home/kongzi/openln/dist/core/db/index.js");
const { pendingInvoicesTable } = await import("/home/kongzi/openln/dist/core/db/schema/index.js");
const { desc } = await import("drizzle-orm");
let ph = null;
for (let i = 0; i < 30 && !ph; i++) {
  const [row] = await db.select().from(pendingInvoicesTable).orderBy(desc(pendingInvoicesTable.createdAt)).limit(1);
  if (row && row.memo === "openLN payment" && row.createdAt > new Date(Date.now() - 10 * 60 * 1000)) ph = row.paymentHash;
  else break;
}
console.log("paymentHash:", ph);
for (let i = 0; i < 40; i++) {
  const st = JSON.parse(execSync(`curl -sS ${BASE}/api/payments/${ph}/status`).toString());
  status = st.status;
  if (["paid", "cancelled", "needs_reconciliation"].includes(status)) break;
  await new Promise(r => setTimeout(r, 8000));
}
console.log("FINAL STATUS:", status);

const mAfter = (await getBalance(merchant)).balanceSats;
console.log("merchant after:", mAfter, "delta:", mAfter - mBefore, "(expect +990)");
const t = JSON.parse(execSync(`curl -sS ${BASE}/api/treasury`).toString());
console.log("treasury:", JSON.stringify(t));
process.exit(0);
