/**
 * Wallet source resolution - the single place that answers "how does this
 * account receive and spend?".
 *
 * Sources come from saved wallet connections (account_connections): an
 * account can keep several wallets on file, and each feature resolves its
 * own. RIC and Cards carry a per-feature assignment; every other surface
 * uses the account's default connection. Both directions of a feature (send
 * and receive) run through its assigned connection - what is possible
 * depends on the wallet's capabilities (core/money/connections.ts).
 *
 *   - kind 'nwc'       : Veil or custom NWC wallet (receive + spend + balance)
 *   - kind 'blink'     : Blink API wallet (receive + spend + balance; spending
 *                        needs the API key's Write scope)
 *   - kind 'lnaddress' : lightning address (receive-only; wrapped settlement,
 *                        LUD-21 verify used where the provider serves it)
 *   - kind 'none'      : wallet setup not completed
 */
import { db } from "../db/index.js";
import { accountsTable, accountConnectionsTable } from "../db/index.js";
import { and, eq } from "drizzle-orm";
import { getAccountNwcUrl, getAccountVeilNwcUrl, normalizeNwcUrl, resolveNwcUrl } from "./nwc.js";

/** Which feature a resolution is for. More purposes (pos, shop, ...) later. */
export type WalletPurpose = "default" | "ric" | "cards";

export type WalletSource =
  | { kind: "nwc"; nwcUrl: string; mode: "veil" | "custom"; connectionId?: string }
  | { kind: "blink"; apiKey: string; walletId: string | null; currency: string | null; connectionId?: string }
  | { kind: "lnaddress"; address: string; verifySupported: boolean; connectionId?: string }
  | { kind: "none"; connectionId?: string };

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

/**
 * The connection ids a purpose resolves through, in order: the feature's own
 * assignment first, then the default connection. Pure - exported for tests.
 * A stale pointer (row deleted) falls through the chain; a connection whose
 * payload cannot be read fails closed instead of silently rerouting.
 */
export function connectionChainForPurpose(
  account: { defaultConnectionId: string | null; ricConnectionId: string | null; cardsConnectionId: string | null },
  purpose: WalletPurpose,
): string[] {
  const featureId = purpose === "ric" ? account.ricConnectionId : purpose === "cards" ? account.cardsConnectionId : null;
  const chain: string[] = [];
  if (featureId) chain.push(featureId);
  if (account.defaultConnectionId && account.defaultConnectionId !== featureId) chain.push(account.defaultConnectionId);
  return chain;
}

type ConnectionRow = typeof accountConnectionsTable.$inferSelect;

/** Build a WalletSource from one saved connection row. Null when unusable. */
async function walletSourceFromConnection(accountId: string, conn: ConnectionRow): Promise<WalletSource | null> {
  if (conn.kind === "lnaddress") {
    if (!conn.lightningAddress) return null;
    return { kind: "lnaddress", address: conn.lightningAddress, verifySupported: conn.lnurlVerifySupported !== false, connectionId: conn.id };
  }
  if (conn.kind === "blink") {
    const apiKey = resolveNwcUrl(conn.blinkApiKeyEncrypted);
    if (!apiKey) return null;
    return { kind: "blink", apiKey, walletId: conn.blinkWalletId, currency: conn.blinkWalletCurrency, connectionId: conn.id };
  }
  if (conn.kind === "nwc") {
    if (conn.mode === "custom") {
      const decrypted = resolveNwcUrl(conn.nwcUrlEncrypted);
      const raw = decrypted ?? (conn.nwcUrlEncrypted ?? undefined); // plaintext fallback for legacy rows
      // Legacy parity: a custom connection with no stored URL resolved to the
      // account's Veil wallet; keep that behavior for those rows.
      const nwcUrl = raw ? normalizeNwcUrl(raw) : await getAccountVeilNwcUrl(accountId);
      if (!nwcUrl) return null;
      return { kind: "nwc", nwcUrl, mode: "custom", connectionId: conn.id };
    }
    const nwcUrl = await getAccountVeilNwcUrl(accountId);
    if (!nwcUrl) return null;
    return { kind: "nwc", nwcUrl, mode: "veil", connectionId: conn.id };
  }
  // Unknown kind (no capability entry yet): cannot build a source.
  return null;
}

/**
 * Resolve the wallet for an account, for a purpose:
 *   default -> default connection; ric/cards -> their assignment, else default.
 * Falls back to the legacy account wallet fields when an account has no saved
 * connections yet (pre-migration rows).
 */
export async function resolveWalletSource(accountId: string, purpose: WalletPurpose = "default"): Promise<WalletSource> {
  const [account] = await db
    .select({
      walletMode: accountsTable.walletMode,
      lightningAddress: accountsTable.lightningAddress,
      blinkApiKeyEncrypted: accountsTable.blinkApiKeyEncrypted,
      blinkWalletId: accountsTable.blinkWalletId,
      blinkWalletCurrency: accountsTable.blinkWalletCurrency,
      lnurlVerifySupported: accountsTable.lnurlVerifySupported,
      defaultConnectionId: accountsTable.defaultConnectionId,
      ricConnectionId: accountsTable.ricConnectionId,
      cardsConnectionId: accountsTable.cardsConnectionId,
    })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));

  if (!account) return { kind: "none" };

  const chain = connectionChainForPurpose(account, purpose);
  if (chain.length) {
    for (const connectionId of chain) {
      const [conn] = await db
        .select()
        .from(accountConnectionsTable)
        .where(and(eq(accountConnectionsTable.id, connectionId), eq(accountConnectionsTable.accountId, accountId)));
      if (!conn) continue; // stale pointer - try the next link in the chain
      const source = await walletSourceFromConnection(accountId, conn);
      // Fail closed: an assigned connection that cannot be read must never
      // silently reroute money to a different wallet.
      return source ?? { kind: "none" };
    }
  }

  // No saved connections: legacy account fields.
  if (account.walletMode === "lnaddress") {
    if (!account.lightningAddress) return { kind: "none" };
    return { kind: "lnaddress", address: account.lightningAddress, verifySupported: account.lnurlVerifySupported !== false };
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

/**
 * Resolve a specific saved connection by id. Settle/reconcile rows against
 * the wallet that created them (per-row snapshot), regardless of what the
 * account's assignments look like today.
 */
export async function resolveConnectionSource(accountId: string, connectionId: string): Promise<WalletSource | null> {
  const [conn] = await db
    .select()
    .from(accountConnectionsTable)
    .where(and(eq(accountConnectionsTable.id, connectionId), eq(accountConnectionsTable.accountId, accountId)));
  if (!conn) return null;
  return walletSourceFromConnection(accountId, conn);
}

/**
 * If the account has no default connection yet, make this one the default
 * and mirror it into the legacy fields. Returns true when it became default.
 */
export async function assignDefaultIfUnset(accountId: string, connectionId: string): Promise<boolean> {
  const [acc] = await db
    .select({ defaultConnectionId: accountsTable.defaultConnectionId })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  if (!acc || acc.defaultConnectionId) return false;
  await db.update(accountsTable).set({ defaultConnectionId: connectionId, updatedAt: new Date() }).where(eq(accountsTable.id, accountId));
  await syncLegacyWalletMirror(accountId);
  return true;
}

/**
 * Mirror the default connection into the legacy account wallet fields
 * (wallet_mode, custom_nwc_url, blink_*, lightning_address). Those columns
 * predate named connections and are still read by a few code paths (internal
 * transfers, admin tools); keeping them in step with the default connection
 * means every reader agrees on the same wallet.
 */
export async function syncLegacyWalletMirror(accountId: string): Promise<void> {
  const [acc] = await db
    .select({ defaultConnectionId: accountsTable.defaultConnectionId })
    .from(accountsTable)
    .where(eq(accountsTable.id, accountId));
  if (!acc) return;

  let conn: ConnectionRow | undefined;
  if (acc.defaultConnectionId) {
    [conn] = await db
      .select()
      .from(accountConnectionsTable)
      .where(and(eq(accountConnectionsTable.id, acc.defaultConnectionId), eq(accountConnectionsTable.accountId, accountId)));
  }

  if (!conn) {
    await db
      .update(accountsTable)
      .set({ walletMode: "unset", customNwcUrl: null, lightningAddress: null, blinkApiKeyEncrypted: null, blinkWalletId: null, blinkWalletCurrency: null, lnurlVerifySupported: null, updatedAt: new Date() })
      .where(eq(accountsTable.id, accountId));
    return;
  }

  if (conn.kind === "lnaddress") {
    await db
      .update(accountsTable)
      .set({ walletMode: "lnaddress", lightningAddress: conn.lightningAddress, lnurlVerifySupported: conn.lnurlVerifySupported, customNwcUrl: null, blinkApiKeyEncrypted: null, blinkWalletId: null, blinkWalletCurrency: null, updatedAt: new Date() })
      .where(eq(accountsTable.id, accountId));
    return;
  }

  if (conn.kind === "blink") {
    await db
      .update(accountsTable)
      .set({ walletMode: "blink", blinkApiKeyEncrypted: conn.blinkApiKeyEncrypted, blinkWalletId: conn.blinkWalletId, blinkWalletCurrency: conn.blinkWalletCurrency, customNwcUrl: null, lightningAddress: null, lnurlVerifySupported: null, updatedAt: new Date() })
      .where(eq(accountsTable.id, accountId));
    return;
  }

  // nwc (veil keeps its keypair on the account; custom carries the URL)
  await db
    .update(accountsTable)
    .set({ walletMode: conn.mode === "custom" ? "custom" : "veil", customNwcUrl: conn.mode === "custom" ? conn.nwcUrlEncrypted : null, lightningAddress: null, blinkApiKeyEncrypted: null, blinkWalletId: null, blinkWalletCurrency: null, lnurlVerifySupported: null, updatedAt: new Date() })
    .where(eq(accountsTable.id, accountId));
}
