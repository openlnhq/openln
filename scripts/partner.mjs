#!/usr/bin/env node
/**
 * Partner ops. Run from the repo root after `npm run build`:
 *   node scripts/partner.mjs list
 *   node scripts/partner.mjs create <handle> <name> <region> [password]
 *   node scripts/partner.mjs password <handle> [password]
 *   node scripts/partner.mjs address <handle> <name@wallet.com>
 *   node scripts/partner.mjs status <handle> active|pending|suspended
 *   node scripts/partner.mjs show <handle>
 *   node scripts/partner.mjs resolve <payoutId> sent|failed [note]
 *
 * `resolve` is the manual escape hatch for a payout stuck in 'sending' when the
 * wallet never gives a definitive answer. It moves money state: only use it
 * after checking the platform wallet (Alby Hub) for the payment.
 */
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";

function loadEnv() {
  if (process.env.DATABASE_URL) return;
  for (const p of ["artifacts/api-server/.env", "../artifacts/api-server/.env"]) {
    try {
      for (const line of readFileSync(p, "utf8").split("\n")) {
        const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
        if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
      }
      if (process.env.DATABASE_URL) return;
    } catch {
      /* try the next candidate */
    }
  }
}
loadEnv();
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set and artifacts/api-server/.env was not found");
  process.exit(1);
}

const [cmd, ...args] = process.argv.slice(2);
const { db, pool, partnerAccountsTable, partnerEarningsTable, partnerPayoutsTable } = await import("../dist/core/db/index.js");
const { eq } = await import("drizzle-orm");
const partnerMod = await import("../dist/plugins/partner.js");
const payoutsMod = await import("../dist/core/money/partnerPayouts.js");

const genPassword = () => randomBytes(12).toString("base64url");
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

async function partnerByHandle(handle) {
  const [p] = await db.select().from(partnerAccountsTable).where(eq(partnerAccountsTable.handle, String(handle || "").trim().toLowerCase()));
  if (!p) throw Error(`No partner with handle "${handle}"`);
  return p;
}

try {
  switch (cmd) {
    case "list": {
      const partners = await db.select().from(partnerAccountsTable).orderBy(partnerAccountsTable.createdAt, partnerAccountsTable.id);
      for (const p of partners) {
        const b = await payoutsMod.partnerBalance(p.id);
        console.log(
          `${p.handle.padEnd(18)} ${p.status.padEnd(9)} ${(p.region || "").padEnd(14)} earned ${fmt(b.earnedSats).padStart(9)} | paid ${fmt(b.paidSats).padStart(8)} | available ${fmt(b.availableSats).padStart(8)} | ${p.lightningAddress || "(no payout address)"}`,
        );
      }
      break;
    }
    case "create": {
      const [handle, name, region, pw] = args;
      if (!handle || !name || !region) {
        console.error("usage: partner.mjs create <handle> <name> <region> [password]");
        process.exitCode = 1;
        break;
      }
      const password = pw || genPassword();
      const p = await partnerMod.createPartner(name, handle, region, password);
      if (pw === undefined) console.log(`generated password: ${password}`);
      console.log(`created ${p.handle} (${p.id}) status=${p.status}`);
      break;
    }
    case "password": {
      const [handle, pw] = args;
      const password = pw || genPassword();
      console.log(`password set for ${await partnerMod.setPartnerPassword(handle, password)}`);
      if (pw === undefined) console.log(`generated password: ${password}`);
      break;
    }
    case "address": {
      const [handle, addr] = args;
      const p = await partnerByHandle(handle);
      const r = await payoutsMod.setPayoutAddress(p.id, addr || "");
      console.log(r.ok ? `payout address set for ${p.handle}: ${r.address}` : `rejected: ${r.error}`);
      if (!r.ok) process.exitCode = 1;
      break;
    }
    case "status": {
      const [handle, status] = args;
      const p = await partnerMod.setPartnerStatus(handle, status || "");
      console.log(`${p.handle} -> ${p.status}`);
      break;
    }
    case "show": {
      const p = await partnerByHandle(args[0]);
      const b = await payoutsMod.partnerBalance(p.id);
      const earnings = await db.select({ id: partnerEarningsTable.id }).from(partnerEarningsTable).where(eq(partnerEarningsTable.partnerId, p.id));
      const payouts = await payoutsMod.listPartnerPayouts(p.id, 10);
      console.log(`${p.name} (${p.handle}, ${p.region}) status=${p.status}`);
      console.log(`payout address: ${p.lightningAddress || "(not set)"}`);
      console.log(`earned ${fmt(b.earnedSats)} sats over ${earnings.length} sales | paid ${fmt(b.paidSats)} | pending ${fmt(b.pendingSats)} | available ${fmt(b.availableSats)}`);
      for (const x of payouts) {
        console.log(`  payout ${x.id} ${fmt(x.amountSats)} sats ${x.state} ${x.destination || ""} ${x.paymentHash ? x.paymentHash.slice(0, 16) : ""}${x.error ? " [" + x.error + "]" : ""}`);
      }
      break;
    }
    case "resolve": {
      const [id, verdict, ...note] = args;
      if (!id || !["sent", "failed"].includes(verdict || "")) {
        console.error("usage: partner.mjs resolve <payoutId> sent|failed [note]");
        process.exitCode = 1;
        break;
      }
      const [row] = await db
        .update(partnerPayoutsTable)
        .set({ state: verdict, error: note.join(" ") || (verdict === "sent" ? null : "resolved by operator as failed"), updatedAt: new Date() })
        .where(eq(partnerPayoutsTable.id, id))
        .returning();
      console.log(row ? `payout ${id} -> ${row.state} (balance updates immediately)` : `payout ${id} not found`);
      break;
    }
    default:
      console.log("commands: list | create | password | address | status | show | resolve");
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
} finally {
  await pool.end();
}
