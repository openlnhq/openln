import { eq } from "drizzle-orm";
import { db, partnerEarningsTable, posboxDevicesAttributionTable } from "../db/index.js";
import { logger } from "./logger.js";

/**
 * Partner revenue share: a partner earns 0.3% of each settled sale, which is
 * 15% of the 2% wrapped-sale fee (floored to whole sats).
 */
export const PARTNER_SHARE_PERCENT_OF_FEE = 15;

export function partnerFeeShareSats(feeSats: number): number {
  if (!Number.isFinite(feeSats) || feeSats <= 0) return 0;
  return Math.floor((feeSats * PARTNER_SHARE_PERCENT_OF_FEE) / 100);
}

/**
 * Accrue a partner's share of one settled wrapped sale.
 *
 * Deliberately runs AFTER the settle transaction has committed and never
 * throws: the merchant money path must not depend on partner bookkeeping. The
 * insert is idempotent (partner_earnings.payment_hash is unique), so a retry
 * or a replayed settle cannot double-accrue.
 */
export async function recordPartnerEarning(input: {
  paymentHash: string;
  amountSats: number;
  feeSats: number;
  deviceMac: string | null | undefined;
}): Promise<void> {
  const mac = input.deviceMac?.trim().toUpperCase();
  if (!mac) return;
  try {
    const [attribution] = await db
      .select({ partnerId: posboxDevicesAttributionTable.partnerId })
      .from(posboxDevicesAttributionTable)
      .where(eq(posboxDevicesAttributionTable.mac, mac))
      .limit(1);
    if (!attribution?.partnerId) return;
    await db
      .insert(partnerEarningsTable)
      .values({
        partnerId: attribution.partnerId,
        deviceMac: mac,
        paymentHash: input.paymentHash,
        amountSats: input.amountSats,
        feeShareSats: partnerFeeShareSats(input.feeSats),
      })
      .onConflictDoNothing();
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err), paymentHash: input.paymentHash, mac },
      "partner earning accrual failed - merchant settle unaffected",
    );
  }
}
