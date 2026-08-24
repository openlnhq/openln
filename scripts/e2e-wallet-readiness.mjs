#!/usr/bin/env node
/**
 * Deterministic preflight for the Phase 2 three-wallet NWC E2E.
 *
 * This intentionally does not create wallets or copy credentials. Alby Hub/
 * other NWC providers create/revoke connections outside this repository; the
 * runner receives three dedicated test connection strings via an explicit
 * env file. Production env names are rejected.
 */
import fs from "node:fs";
import process from "node:process";

const required = ["NWC_TEST_URL", "NWC_USER_URL", "NWC_SENDER_URL"];
const forbidden = ["ALBY_NWC_URL", "DATABASE_URL", "SESSION_SECRET"];
const envPath = process.env.NWC_E2E_ENV_FILE;
if (!envPath) {
  console.error("NWC_E2E_ENV_FILE is required; refusing implicit shell/.env credentials");
  process.exit(2);
}
const stat = fs.statSync(envPath, { throwIfNoEntry: false });
if (!stat || !stat.isFile()) throw new Error(`env file not found: ${envPath}`);
if ((stat.mode & 0o077) !== 0) throw new Error(`env file must be mode 600: ${envPath}`);
const text = fs.readFileSync(envPath, "utf8");
const values = Object.create(null);
for (const line of text.split(/\r?\n/)) {
  const m = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
  if (m) values[m[1]] = m[2].trim().replace(/^['"]|['"]$/g, "");
}
for (const key of forbidden) {
  if (values[key] || process.env[key]) throw new Error(`forbidden production variable present: ${key}`);
}
for (const key of required) {
  if (!values[key] || !values[key].startsWith("nostr+walletconnect://")) throw new Error(`missing/invalid ${key}`);
  if (!values[key].includes("relay=") || !values[key].includes("secret=")) throw new Error(`${key} must contain relay= and secret=`);
}
if (new Set(required.map((key) => values[key])).size !== required.length) throw new Error("wallet roles must use three distinct NWC URLs");

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl || !/^postgres(ql)?:\/\//.test(dbUrl)) throw new Error("DATABASE_URL must be supplied separately for the isolated E2E database");
if (!/(^|[/?_])openln_test([/?]|$)/.test(dbUrl)) throw new Error("DATABASE_URL must target an isolated openln_test database");

const { probeNwcWallet, getBalance } = await import("../dist/core/money/nwc.js");
const roles = ["platform", "sender", "merchant"];
const urls = [values.NWC_TEST_URL, values.NWC_USER_URL, values.NWC_SENDER_URL];
const wallets = [];
for (let i = 0; i < roles.length; i++) {
  const probe = await probeNwcWallet(urls[i]);
  if (!probe.canGetBalance || !probe.canMakeInvoice || !probe.canLookupInvoice) {
    throw new Error(`${roles[i]} wallet lacks required NWC capabilities`);
  }
  const balance = await getBalance(urls[i]);
  wallets.push({ role: roles[i], balanceSats: balance.balanceSats, methods: probe.methods });
}
if (wallets[1].balanceSats < 1000) throw new Error(`sender wallet needs >=1000 sats (reported ${wallets[1].balanceSats})`);
if (wallets[0].balanceSats < 1010) throw new Error(`platform wallet needs >=1010 sats float (reported ${wallets[0].balanceSats})`);
console.log(JSON.stringify({ ready: true, database: "openln_test", plugins: [], wallets: wallets.map(({ role, balanceSats }) => ({ role, balanceSats })) }));
