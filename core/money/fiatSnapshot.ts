/** Port of bitPOS lib/fiatSnapshot.ts, verbatim except import paths. */
import { db, accountsTable } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getBtcPriceFor, applyRateModifier, type RateSource } from "./price.js";

export interface FiatSnapshot {
  fiatCurrency: string;
  fiatAmount: string;
  fiatBaseRate: string;
  fiatEffectiveRate: string;
  fiatModifier: string | null;
  fiatRateSource: string;
  fiatRateDirection: string;
  fiatRateAt: Date;
}

export async function captureFiatSnapshot(accountId: string, amountSats: number, direction: "receive" | "send"): Promise<FiatSnapshot | null> {
  const [account] = await db.select({ currency: accountsTable.currency, rateSource: accountsTable.rateSource, rateModifier: accountsTable.rateModifier, sendRateModifier: accountsTable.sendRateModifier }).from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!account || account.currency === "sats") return null;
  const source: RateSource = account.rateSource === "binance" ? "binance" : "coingecko";
  const base = await getBtcPriceFor(account.currency, source);
  if (!Number.isFinite(base) || base <= 0) return null;
  const modifier = direction === "send" ? (account.sendRateModifier ?? "") : (account.rateModifier ?? "");
  const effective = applyRateModifier(base, modifier);
  if (!Number.isFinite(effective) || effective <= 0) return null;
  return { fiatCurrency: account.currency, fiatAmount: String(amountSats / 100_000_000 * effective), fiatBaseRate: String(base), fiatEffectiveRate: String(effective), fiatModifier: modifier || null, fiatRateSource: source, fiatRateDirection: direction, fiatRateAt: new Date() };
}
