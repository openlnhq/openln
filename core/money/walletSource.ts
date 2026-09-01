/**
 * Wallet source resolution - the single place that answers "how does this
 * account receive and spend?".
 *
 *   - kind 'nwc'       : Veil or custom NWC wallet (receive + spend + balance)
 *   - kind 'lnaddress' : lightning address (receive-only via LNURL-pay/verify)
 *   - kind 'none'      : wallet setup not completed
 */
import { db } from "@workspace/db";
import { accountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAccountNwcUrl } from "./nwc";

export type WalletSource =
  | { kind: "nwc"; nwcUrl: string; mode: "veil" | "custom" }
  | { kind: "lnaddress"; address: string }
  | { kind: "none" };

export async function resolveWalletSource(accountId: string): Promise<WalletSource> {
  const [account] = await db
    .select({
      walletMode: accountsTable.walletMode,
      lightningAddress: accountsTable.lightningAddress,
    })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) return { kind: "none" };

  if (account.walletMode === "lnaddress") {
    if (!account.lightningAddress) return { kind: "none" };
    return { kind: "lnaddress", address: account.lightningAddress };
  }

  if (account.walletMode === "unset") return { kind: "none" };

  const nwcUrl = await getAccountNwcUrl(accountId);
  if (!nwcUrl) return { kind: "none" };
  return { kind: "nwc", nwcUrl, mode: account.walletMode === "custom" ? "custom" : "veil" };
}
