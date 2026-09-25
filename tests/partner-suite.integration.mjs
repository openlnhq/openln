import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Scratch DB only (mirrors the other integration suites).
const dbUrl = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) || !dbUrl.pathname.startsWith('/openln_qa_')) throw Error('Local scratch DB required (openln_qa_*)');
process.env.DOMAIN = 'partner.test.invalid';
process.env.ALBY_NWC_URL = process.env.ALBY_NWC_URL || 'nostr+walletconnect://qa-placeholder';

const { pool, db, partnerAccountsTable, partnerEarningsTable, partnerPayoutsTable } = await import('../dist/core/db/index.js');
const { eq } = await import('drizzle-orm');
const { createPartner, issueClaim, redeemClaim } = await import('../dist/plugins/partner.js');
const { PARTNER_SHARE_PERCENT_OF_FEE, partnerFeeShareSats, recordPartnerEarning } = await import('../dist/core/money/partnerShare.js');
const { MIN_PAYOUT_SATS, partnerBalance, requestPartnerPayout, executePayout, reconcilePayout } = await import('../dist/core/money/partnerPayouts.js');

const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
const rand = () => randomBytes(5).toString('hex');
const mac = (suffix) => `AA:BB:CC:DD:EE:${suffix}`;
const waitState = async (id, states, ms = 8000) => {
  const t0 = Date.now();
  for (;;) {
    const [r] = await db.select().from(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, id));
    if (!r || states.includes(r.state) || Date.now() - t0 > ms) return r;
    await new Promise((res) => setTimeout(res, 100));
  }
};
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let partnerA, partnerB;
const macA = mac(rand().slice(0, 2).toUpperCase());
const macB = mac('B' + rand().slice(0, 1).toUpperCase());
const macC = mac('C' + rand().slice(0, 1).toUpperCase());

const fakeDeps = (over = {}) => ({
  requestInvoice: over.requestInvoice ?? (async () => ({ bolt11: 'lnbc1qa-invoice-' + rand(), paymentHash: 'qa-h-' + rand() })),
  pay: over.pay ?? (async () => ({ preimage: 'ab'.repeat(32), paymentHash: 'qa-ph-' + rand() })),
  balance: over.balance ?? (async () => ({ balanceSats: 1_000_000 })),
  lookup: over.lookup ?? (async () => undefined),
});

before(async () => {
  await sql.connect();
  partnerA = await createPartner('QA Partner A', 'qa-partner-a-' + rand(), 'QA', 'qa-password-123456');
  partnerB = await createPartner('QA Partner B', 'qa-partner-b-' + rand(), 'QA', 'qa-password-123456');
});
after(async () => {
  await sql.end();
  await pool.end();
});

test('claim codes bind a device MAC to the issuing partner, first-wins and replay-safe', async () => {
  const claimA = await issueClaim(partnerA.id);
  const first = await redeemClaim(macA.toLowerCase(), claimA.claimCode);
  assert.equal(first.partnerId, partnerA.id);
  assert.equal(first.replayed, false);
  assert.equal(first.mac, macA.toUpperCase(), 'MAC stored normalized');
  const again = await redeemClaim(macA, claimA.claimCode);
  assert.equal(again.replayed, true);
  assert.equal(again.partnerId, partnerA.id);
  const claimB = await issueClaim(partnerB.id);
  await assert.rejects(() => redeemClaim(macA, claimB.claimCode), (e) => e.status === 409, 'a different partner cannot claim a bound MAC');
  const regB = await redeemClaim(macB, claimB.claimCode);
  assert.equal(regB.partnerId, partnerB.id);
  await assert.rejects(() => redeemClaim(macC, 'NOT-A-REAL-CODE'), (e) => e.status === 400 || e.status === 401, 'unknown codes are rejected');
});

test('partner share is 15% of the fee (0.3% of the sale), floored to whole sats', () => {
  assert.equal(PARTNER_SHARE_PERCENT_OF_FEE, 15);
  assert.equal(partnerFeeShareSats(0), 0);
  assert.equal(partnerFeeShareSats(1), 0);
  assert.equal(partnerFeeShareSats(6), 0);
  assert.equal(partnerFeeShareSats(7), 1);
  assert.equal(partnerFeeShareSats(20), 3);
  assert.equal(partnerFeeShareSats(200), 30); // 10,000 sat sale
  assert.equal(partnerFeeShareSats(240), 36); // 12,000 sat sale
});

test('settled sales accrue to the registered partner by device MAC, exactly once', async () => {
  const h1 = 'qa-h-' + rand();
  await recordPartnerEarning({ paymentHash: h1, amountSats: 10000, feeSats: 200, deviceMac: macA.toLowerCase() });
  await recordPartnerEarning({ paymentHash: h1, amountSats: 10000, feeSats: 200, deviceMac: macA }); // replayed settle
  const rows = await db.select().from(partnerEarningsTable).where(eq(partnerEarningsTable.paymentHash, h1));
  assert.equal(rows.length, 1, 'idempotent per payment hash');
  assert.equal(rows[0].feeShareSats, 30);
  assert.equal(rows[0].partnerId, partnerA.id);
  assert.equal(rows[0].deviceMac, macA.toUpperCase());
  const h2 = 'qa-h-' + rand();
  await recordPartnerEarning({ paymentHash: h2, amountSats: 5000, feeSats: 100, deviceMac: macC });
  const none = await db.select().from(partnerEarningsTable).where(eq(partnerEarningsTable.paymentHash, h2));
  assert.equal(none.length, 0, 'unregistered MACs accrue nothing');
  const h3 = 'qa-h-' + rand();
  await recordPartnerEarning({ paymentHash: h3, amountSats: 5000, feeSats: 100, deviceMac: null });
  const none2 = await db.select().from(partnerEarningsTable).where(eq(partnerEarningsTable.paymentHash, h3));
  assert.equal(none2.length, 0, 'browser POS sales have no device and accrue nothing');
});

test('payout request guards: address required, minimum enforced, one in flight at a time', async () => {
  let b = await partnerBalance(partnerA.id);
  assert.equal(b.earnedSats, 30);
  assert.equal(b.availableSats, 30);
  const noAddr = await requestPartnerPayout(partnerA.id, fakeDeps());
  assert.equal(noAddr.ok, false);
  assert.equal(noAddr.status, 400);
  await db.update(partnerAccountsTable).set({ lightningAddress: 'qa@partner.test.invalid' }).where(eq(partnerAccountsTable.id, partnerA.id));
  const belowMin = await requestPartnerPayout(partnerA.id, fakeDeps());
  assert.equal(belowMin.ok, false);
  assert.equal(belowMin.status, 400);
  assert.ok(MIN_PAYOUT_SATS >= 1000);
  for (let i = 0; i < 40; i++) await recordPartnerEarning({ paymentHash: `qa-bulk-${rand()}`, amountSats: 10000, feeSats: 200, deviceMac: macA });
  b = await partnerBalance(partnerA.id);
  assert.equal(b.earnedSats, 30 + 40 * 30);
  const [held] = await db.insert(partnerPayoutsTable).values({ partnerId: partnerA.id, amountSats: 10, state: 'requested', destination: 'qa@partner.test.invalid' }).returning();
  const blocked = await requestPartnerPayout(partnerA.id, fakeDeps());
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 409);
  await db.delete(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, held.id));
});

test('payout pays out the full balance through the platform wallet and records proof', async () => {
  const sentHash = 'qa-sent-' + rand();
  const deps = fakeDeps({ pay: async () => ({ preimage: 'cd'.repeat(32), paymentHash: sentHash }) });
  const req = await requestPartnerPayout(partnerA.id, deps);
  assert.equal(req.ok, true);
  assert.equal(req.payout.amountSats, 1230);
  const row = await waitState(req.payout.id, ['sent', 'failed']);
  assert.equal(row.state, 'sent');
  assert.equal(row.paymentHash, sentHash);
  assert.ok(row.preimage);
  assert.ok(row.bolt11);
  const b = await partnerBalance(partnerA.id);
  assert.equal(b.paidSats, 1230);
  assert.equal(b.availableSats, 0);
  assert.equal(await executePayout(req.payout.id, deps), 'skipped', 'a sent payout cannot be re-executed');
});

test('definitive failures mark the payout failed and release the balance', async () => {
  for (let i = 0; i < 40; i++) await recordPartnerEarning({ paymentHash: `qa-bulk2-${rand()}`, amountSats: 10000, feeSats: 200, deviceMac: macA });
  const failDeps = fakeDeps({ requestInvoice: async () => { throw Error('Could not resolve this address'); } });
  const r2 = await requestPartnerPayout(partnerA.id, failDeps);
  assert.equal(r2.ok, true);
  const row2 = await waitState(r2.payout.id, ['failed', 'sent']);
  assert.equal(row2.state, 'failed');
  assert.match(row2.error, /resolve/i);
  const b = await partnerBalance(partnerA.id);
  assert.equal(b.pendingSats, 0);
  assert.equal(b.availableSats, 1200);
});

test('ambiguous send outcomes stay reserved, then reconcile to sent', async () => {
  const amb = fakeDeps({ pay: async () => { throw Error('reply timeout waiting for response'); } });
  const r3 = await requestPartnerPayout(partnerA.id, amb);
  assert.equal(r3.ok, true);
  let row3;
  for (let i = 0; i < 80; i++) {
    const [r] = await db.select().from(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, r3.payout.id));
    row3 = r;
    if (r.state === 'failed' || r.state === 'sent') break;
    if (r.state === 'sending' && r.bolt11) break;
    await sleep(100);
  }
  assert.equal(row3.state, 'sending', 'ambiguous outcome stays reserved for reconcile');
  assert.ok(row3.bolt11);
  let b = await partnerBalance(partnerA.id);
  assert.equal(b.availableSats, 0, 'reserved while unresolved');
  const rec = await reconcilePayout(row3.id, fakeDeps({ lookup: async () => ({ state: 'settled', preimage: 'ee'.repeat(32) }) }));
  assert.equal(rec, 'sent');
  b = await partnerBalance(partnerA.id);
  assert.equal(b.paidSats, 1230 + 1200);
  assert.equal(b.availableSats, 0);
});

test('platform float shortfall fails the payout without sending', async () => {
  for (let i = 0; i < 40; i++) await recordPartnerEarning({ paymentHash: `qa-bulk3-${rand()}`, amountSats: 10000, feeSats: 200, deviceMac: macA });
  const r4 = await requestPartnerPayout(partnerA.id, fakeDeps({ balance: async () => ({ balanceSats: 10 }) }));
  assert.equal(r4.ok, true);
  const row4 = await waitState(r4.payout.id, ['failed', 'sent']);
  assert.equal(row4.state, 'failed');
  assert.match(row4.error, /float/i);
});

test('reconcile requeues a payout interrupted before any invoice was fetched', async () => {
  const [stuck] = await db.insert(partnerPayoutsTable).values({ partnerId: partnerA.id, amountSats: 5, state: 'sending', destination: 'qa@partner.test.invalid', updatedAt: new Date(Date.now() - 10 * 60 * 1000) }).returning();
  const out = await reconcilePayout(stuck.id, fakeDeps());
  assert.equal(out, 'requested');
  const [after] = await db.select().from(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, stuck.id));
  assert.equal(after.state, 'requested');
  await db.delete(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, stuck.id));
  // A fresh no-invoice 'sending' row is left alone (grace window).
  const [fresh] = await db.insert(partnerPayoutsTable).values({ partnerId: partnerA.id, amountSats: 5, state: 'sending', destination: 'qa@partner.test.invalid' }).returning();
  const out2 = await reconcilePayout(fresh.id, fakeDeps());
  assert.equal(out2, 'sending');
  await db.delete(partnerPayoutsTable).where(eq(partnerPayoutsTable.id, fresh.id));
  await sleep(1);
});
