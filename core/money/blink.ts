/**
 * Blink API wallet lane (Blink, blink.sv / blinkbtc.com - Galoy stack).
 *
 * A merchant backs their openLN account with a Blink account via a Blink API
 * key (created at dashboard.blink.sv). The key's scopes decide capability:
 *   - Read + Receive : receive on the RIC/POS + balance display (this lane)
 *   - + Write        : sending from the wallet (RIC send, cards). The pay
 *                      call exists below; openLN's send paths still go through
 *                      NWC only, so Write is not required to launch receive.
 *
 * openLN never holds funds at any point: the key is stored encrypted at rest
 * and only ever sent to Blink's own HTTPS API. Blink is custodial - the
 * merchant's balance stays inside their Blink account, which is the point
 * (their wallet, their funds).
 *
 * GraphQL shapes verified against Blink's published introspection
 * (graphql-api-for-llm.json, dev.blink.sv).
 */
import { logger } from "./logger.js";
import { extractPaymentHash } from "./lnAddress.js";

const BLINK_API_URL = process.env.BLINK_API_URL ?? "https://api.blink.sv/graphql";
const FETCH_TIMEOUT_MS = 20_000;

export function isBlinkApiKey(raw: string): boolean {
  return /^blink_[A-Za-z0-9._-]{10,}$/.test(raw.trim());
}

async function blinkGraphql<T>(
  apiKey: string,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  let resp: Response;
  try {
    resp = await fetch(BLINK_API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "X-API-KEY": apiKey },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "error",
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not reach Blink (${msg})`);
  }
  if (!resp.ok) {
    throw new Error(`Blink API returned HTTP ${resp.status} - check the API key`);
  }
  const data = (await resp.json()) as { data?: T; errors?: Array<{ message?: string }> };
  if (data.errors?.length) {
    const msg = data.errors.map((e) => e.message).filter(Boolean).join("; ") || "unknown error";
    throw new Error(`Blink rejected the request (${msg})`);
  }
  if (!data.data) throw new Error("Blink returned no data");
  return data.data;
}

function parseSats(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return Math.trunc(v);
  if (typeof v === "string" && /^-?\d+$/.test(v)) return Number(v);
  return null;
}

export interface BlinkWalletInfo {
  id: string;
  walletCurrency: string;
  balanceSats: number | null;
}

const ME_WALLETS_QUERY = `query OpenLnMe { me { defaultAccount { ... on ConsumerAccount { wallets { id walletCurrency balance } } } } }`;

export async function blinkWallets(apiKey: string): Promise<BlinkWalletInfo[]> {
  const data = await blinkGraphql<{
    me?: { defaultAccount?: { wallets?: Array<{ id?: string; walletCurrency?: string; balance?: unknown }> } };
  }>(apiKey, ME_WALLETS_QUERY);
  const wallets = data.me?.defaultAccount?.wallets ?? [];
  if (!wallets.length) throw new Error("This Blink account returned no wallets");
  return wallets.map((w) => ({
    id: String(w.id ?? ""),
    walletCurrency: String(w.walletCurrency ?? ""),
    balanceSats: parseSats(w.balance),
  }));
}

/** Pick the BTC wallet (openLN is sats-native; USD wallets are not supported). */
function btcWallet(wallets: BlinkWalletInfo[]): BlinkWalletInfo {
  const btc = wallets.find((w) => w.walletCurrency === "BTC") ?? wallets[0];
  if (!btc || !btc.id) throw new Error("No Blink BTC wallet found on this account");
  return btc;
}

export async function blinkGetBalance(
  apiKey: string,
  walletId?: string | null,
): Promise<{ balanceSats: number }> {
  const wallets = await blinkWallets(apiKey);
  const wallet = walletId ? wallets.find((w) => w.id === walletId) ?? btcWallet(wallets) : btcWallet(wallets);
  return { balanceSats: wallet.balanceSats ?? 0 };
}

const INVOICE_CREATE_MUTATION = `mutation OpenLnInvoiceCreate($input: LnInvoiceCreateInput!) {
  lnInvoiceCreate(input: $input) {
    errors { message }
    invoice { paymentRequest paymentHash satoshis }
  }
}`;

export interface BlinkInvoice {
  bolt11: string;
  paymentHash: string;
  expiresAt: Date;
}

/**
 * Mint a receive invoice on the merchant's Blink BTC wallet. `expiresInMinutes`
 * maps to Blink's own `expiresIn` (default 24h when omitted); openLN passes the
 * wrap's merchant window explicitly. Resolves the wallet id when not cached.
 */
export async function blinkMakeInvoice(
  apiKey: string,
  walletId: string | null,
  amountSats: number,
  memo?: string,
  expiresInMinutes = 60,
): Promise<BlinkInvoice> {
  let resolvedWalletId = walletId;
  if (!resolvedWalletId) {
    resolvedWalletId = btcWallet(await blinkWallets(apiKey)).id;
  }
  const data = await blinkGraphql<{
    lnInvoiceCreate?: {
      errors?: Array<{ message?: string }>;
      invoice?: { paymentRequest?: string; paymentHash?: string; satoshis?: unknown };
    };
  }>(apiKey, INVOICE_CREATE_MUTATION, {
    input: {
      walletId: resolvedWalletId,
      amount: amountSats,
      memo: memo?.slice(0, 200),
      expiresIn: expiresInMinutes,
    },
  });
  const payload = data.lnInvoiceCreate;
  const payloadError = payload?.errors?.map((e) => e.message).filter(Boolean).join("; ");
  if (payloadError) throw new Error(`Blink invoice error (${payloadError})`);
  const invoice = payload?.invoice;
  if (!invoice?.paymentRequest) throw new Error("Blink returned no invoice");
  const paymentHash = invoice.paymentHash
    ? String(invoice.paymentHash)
    : extractPaymentHash(invoice.paymentRequest);
  return {
    bolt11: invoice.paymentRequest,
    paymentHash,
    expiresAt: new Date(Date.now() + expiresInMinutes * 60_000),
  };
}

const STATUS_BY_PAYMENT_REQUEST_QUERY = `query OpenLnStatus($input: LnInvoicePaymentStatusByPaymentRequestInput!) {
  lnInvoicePaymentStatusByPaymentRequest(input: $input) { status paymentHash }
}`;

/**
 * Invoice settlement status by BOLT11 payment request. Status is one of
 * PENDING | PAID | EXPIRED - anything other than PAID leaves the sale open.
 */
export async function blinkInvoiceStatus(
  apiKey: string,
  paymentRequest: string,
): Promise<{ paid: boolean; status?: string }> {
  const data = await blinkGraphql<{
    lnInvoicePaymentStatusByPaymentRequest?: { status?: string; paymentHash?: string };
  }>(apiKey, STATUS_BY_PAYMENT_REQUEST_QUERY, { input: { paymentRequest } });
  const status = data.lnInvoicePaymentStatusByPaymentRequest?.status;
  return { paid: status === "PAID", status };
}

const PAY_INVOICE_MUTATION = `mutation OpenLnPay($input: LnInvoicePaymentInput!) {
  lnInvoicePaymentSend(input: $input) {
    status
    errors { message }
  }
}`;

/**
 * Pay a bolt11 from the merchant's Blink wallet (requires the Write scope).
 *
 * Not wired into openLN's send paths yet - sending still goes through NWC
 * only (phase 2). Exposed here so the integration is one dispatch away.
 * Callers must treat PENDING as AMBIGUOUS (same money rules as NWC timeouts):
 * never retry, resolve via the wallet's transaction record first.
 */
export async function blinkPayInvoice(
  apiKey: string,
  walletId: string,
  paymentRequest: string,
  memo?: string,
): Promise<{ status: "SUCCESS" | "PENDING" | "FAILURE" | "ALREADY_PAID" | string }> {
  const data = await blinkGraphql<{
    lnInvoicePaymentSend?: { status?: string; errors?: Array<{ message?: string }> };
  }>(apiKey, PAY_INVOICE_MUTATION, {
    input: { walletId, paymentRequest, ...(memo ? { memo: memo.slice(0, 200) } : {}) },
  });
  const payload = data.lnInvoicePaymentSend;
  const payloadError = payload?.errors?.map((e) => e.message).filter(Boolean).join("; ");
  if (payloadError) throw new Error(`Blink payment error (${payloadError})`);
  return { status: String(payload?.status ?? "UNKNOWN") };
}

/**
 * Validate a Blink API key for use as an openLN funding source:
 *  1. read the account's wallets (Read scope), then
 *  2. mint a 1-sat invoice (Receive scope).
 * Throws a user-facing message when either step fails.
 */
export async function validateBlinkApiKeyForWallet(apiKey: string): Promise<{
  walletId: string;
  walletCurrency: string;
  balanceSats: number;
}> {
  let wallets: BlinkWalletInfo[];
  try {
    wallets = await blinkWallets(apiKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Could not read this Blink account. Create an API key with Read and Receive permissions at dashboard.blink.sv (${msg}).`,
    );
  }
  const wallet = btcWallet(wallets);
  try {
    await blinkMakeInvoice(apiKey, wallet.id, 1, "openLN connection test", 5);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `This Blink key cannot create invoices. Add the Receive permission to it at dashboard.blink.sv (${msg}).`,
    );
  }
  logger.info({ walletId: wallet.id, walletCurrency: wallet.walletCurrency }, "Blink API wallet validated");
  return { walletId: wallet.id, walletCurrency: wallet.walletCurrency, balanceSats: wallet.balanceSats ?? 0 };
}
