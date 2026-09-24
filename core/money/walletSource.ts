/**
 * Wallet source resolution - the single place that answers "how does this
 * account receive and spend?".
 *
 *   - kind 'nwc'       : Veil or custom NWC wallet (receive + spend + balance)
 *   - kind 'blink'     : Blink API wallet (receive + spend + balance; spending
 *                        needs the API key's Write scope)
 *   - kind 'lnaddress' : lightning address (receive-only via LNURL-pay/verify)
 *   - kind 'none'      : wallet setup not completed
 */
import { db } from "../db/index.js";
import { accountsTable } from "../db/index.js";
import { eq } from "drizzle-orm";
import { getAccountNwcUrl, resolveNwcUrl } from "./nwc.js";

export type WalletSource =
  | { kind: "nwc"; nwcUrl: string; mode: "veil" | "custom" }
  | { kind: "blink"; apiKey: string; walletId: string | null; currency: string | null }
  | { kind: "lnaddress"; address: string }
  | { kind: "none" };

/**
 * The minimum a funding source must provide for openLN to mint the merchant
 * invoice inside a wrapped hold invoice ("we pay 98 to get 100"). The hold,
 * forward, and settle steps all run on the platform wallet - the merchant
 * side is only ever asked to mint one invoice per sale, which is why even a
 * receive-only Lightning Address can back the full 2% fee path.
 */
export type MerchantFunding =
  | { kind: "nwc"; nwcUrl: string }
  | { kind: "blink"; apiKey: string; walletId: string | null }
  | { kind: "lnaddress"; address: string };

export function merchantFundingFromSource(source: WalletSource): MerchantFunding | null {
  switch (source.kind) {
    case "nwc":
      return { kind: "nwc", nwcUrl: source.nwcUrl };
    case "blink":
      return { kind: "blink", apiKey: source.apiKey, walletId: source.walletId };
    case "lnaddress":
      return { kind: "lnaddress", address: source.address };
    default:
      return null;
  }
}

export async function resolveWalletSource(accountId: string): Promise<WalletSource> {
  const [account] = await db
    .select({
      walletMode: accountsTable.walletMode,
      lightningAddress: accountsTable.lightningAddress,
      blinkApiKeyEncrypted: accountsTable.blinkApiKeyEncrypted,
      blinkWalletId: accountsTable.blinkWalletId,
      blinkWalletCurrency: accountsTable.blinkWalletCurrency,
    })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) return { kind: "none" };

  if (account.walletMode === "lnaddress") {
    if (!account.lightningAddress) return { kind: "none" };
    return { kind: "lnaddress", address: account.lightningAddress };
  }

  if (account.walletMode === "blink") {
    // resolveNwcUrl is the shared try-decrypt helper (one crypto envelope
    // for every stored secret).
    const apiKey = resolveNwcUrl(account.blinkApiKeyEncrypted);
    if (!apiKey) return { kind: "none" };
    return { kind: "blink", apiKey, walletId: account.blinkWalletId, currency: account.blinkWalletCurrency };
  }

  if (account.walletMode === "unset") return { kind: "none" };

  const nwcUrl = await getAccountNwcUrl(accountId);
  if (!nwcUrl) return { kind: "none" };
  return { kind: "nwc", nwcUrl, mode: account.walletMode === "custom" ? "custom" : "veil" };
}
