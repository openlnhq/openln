import { logger } from "./logger.js";

interface PriceCache { usd: number; eur: number; gbp: number; fetchedAt: number; }
let cache: PriceCache | null = null;
const CACHE_TTL_MS = 60_000;
const currencyCache = new Map<string, { price: number; fetchedAt: number }>();
const supportedCurrenciesCache = new Map<string, { list: string[]; fetchedAt: number }>();
const CURRENCIES_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Fiat currencies Binance actually trades against BTC (live-verified 2026-07,
 * ported verbatim from bitPOS). Anything not in this set has no BTC/FIAT pair
 * on Binance, so selecting it yields a missing/zero price.
 */
const BINANCE_FIAT_QUOTES = new Set([
  "usd", "ars", "aud", "brl", "eur", "gbp", "idr", "jpy", "mxn",
  "ngn", "pln", "ron", "rub", "try", "uah", "zar",
]);

export type RateSource = "coingecko" | "binance";
export interface BtcPrice { usd: number; eur: number; gbp: number; }

async function fetchJson(url: string, timeoutMs = 5000): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

export async function getBtcPrice(): Promise<BtcPrice> {
  const now = Date.now();
  if (cache && now - cache.fetchedAt < CACHE_TTL_MS) return { usd: cache.usd, eur: cache.eur, gbp: cache.gbp };
  try {
    const data = await fetchJson("https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=usd,eur,gbp") as { bitcoin?: { usd: number; eur: number; gbp: number } };
    const d = data?.bitcoin;
    if (!d) throw new Error("Unexpected CoinGecko response");
    cache = { usd: d.usd, eur: d.eur, gbp: d.gbp, fetchedAt: now };
    return { usd: cache.usd, eur: cache.eur, gbp: cache.gbp };
  } catch (err) {
    logger.error({ err }, "Failed to fetch BTC price from CoinGecko");
    if (cache) return { usd: cache.usd, eur: cache.eur, gbp: cache.gbp };
    return { usd: 0, eur: 0, gbp: 0 };
  }
}

async function getBtcPriceBinanceUsd(): Promise<number | null> {
  try {
    const data = await fetchJson("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT") as { price?: string };
    const price = parseFloat(data?.price ?? "");
    if (isNaN(price)) throw new Error("Invalid Binance price");
    return price;
  } catch (err) { logger.error({ err }, "Failed to fetch BTC price from Binance"); return null; }
}

export async function getBtcPriceFor(currency: string, source: RateSource = "coingecko"): Promise<number> {
  const key = currency.toLowerCase();
  if (key === "sats") return 100_000_000;
  const now = Date.now();
  const cached = currencyCache.get(`${source}:${key}`);
  if (cached && now - cached.fetchedAt < CACHE_TTL_MS) return cached.price;

  if (source === "binance") {
    const btcUsdt = await getBtcPriceBinanceUsd();
    if (btcUsdt === null) return getBtcPriceFor(key, "coingecko");
    if (key === "usd" || key === "usdt") { currencyCache.set(`${source}:${key}`, { price: btcUsdt, fetchedAt: now }); return btcUsdt; }
    const usdtPrice = await getBtcPriceFor(key === "usd" ? "usd" : key, "coingecko").catch(() => 0);
    const usdPrice = key === "usd" ? btcUsdt : (await getBtcPriceFor("usd", "coingecko").catch(() => 0));
    if (usdPrice > 0) {
      const ratio = usdtPrice / usdPrice;
      const price = btcUsdt * ratio;
      currencyCache.set(`${source}:${key}`, { price, fetchedAt: now });
      return price;
    }
    return btcUsdt;
  }

  try {
    const data = await fetchJson(`https://api.coingecko.com/api/v3/simple/price?ids=bitcoin&vs_currencies=${encodeURIComponent(key)}`) as Record<string, Record<string, number>>;
    const price = data?.bitcoin?.[key];
    if (typeof price !== "number") throw new Error(`No price for ${key}`);
    currencyCache.set(`${source}:${key}`, { price, fetchedAt: now });
    return price;
  } catch (err) {
    logger.error({ err, currency: key }, "Failed to fetch BTC price for currency");
    const stale = currencyCache.get(`${source}:${key}`);
    if (stale) return stale.price;
    return 0;
  }
}

/**
 * Evaluate a rate modifier expression like "THB*1.01" or "THB-0.5+THB*0.02".
 * Ported verbatim from bitPOS's lib/price.ts.
 */
export function applyRateModifier(price: number, modifier: string | null | undefined): number {
  if (!modifier || !modifier.trim()) return price;
  const expr = modifier.replace(/\s/g, "").toLowerCase();
  const match = expr.match(/^([a-z]{3,5})(.+)$/);
  if (!match) return price;
  const [, , ops] = match;

  let result = price;
  const firstTerm = ops.match(/^\*?(\d+\.?\d*)/);
  if (firstTerm) {
    const mult = parseFloat(firstTerm[1]);
    if (!isNaN(mult) && ops.startsWith("*")) result = price * mult;
  }

  const rest = ops.replace(/^\*?\d+\.?\d*/, "");
  const opTerms = rest.match(/([+-])\*?(\d+\.?\d*)/g);
  if (opTerms) {
    for (const term of opTerms) {
      const m = term.match(/([+-])\*?(\d+\.?\d*)/);
      if (m) {
        const op = m[1];
        const num = parseFloat(m[2]);
        if (!isNaN(num) && (op === "+" || op === "-")) {
          result += (op === "+" ? 1 : -1) * (term.includes("*") ? price * num / price * num : num);
        }
      }
    }
  }

  const simpleMult = ops.match(/^\*(\d+\.?\d*)$/);
  if (simpleMult) result = price * parseFloat(simpleMult[1]);

  const simpleAdd = ops.match(/^([+-])(\d+\.?\d*)$/);
  if (simpleAdd) {
    const op = simpleAdd[1];
    const num = parseFloat(simpleAdd[2]);
    result = op === "+" ? price + num : price - num;
  }

  return Math.round(result * 100) / 100;
}

export async function getSupportedCurrencies(source: RateSource = "coingecko"): Promise<string[]> {
  const now = Date.now();
  const cached = supportedCurrenciesCache.get(source);
  if (cached && now - cached.fetchedAt < CURRENCIES_TTL_MS) return cached.list;
  try {
    const raw = await fetchJson("https://api.coingecko.com/api/v3/simple/supported_vs_currencies", 8000) as string[];
    if (!Array.isArray(raw)) throw new Error("Unexpected response");
    let filtered = raw.filter((c) => c !== "btc" && c !== "sats");
    if (source === "binance") filtered = filtered.filter((c) => BINANCE_FIAT_QUOTES.has(c));
    filtered.sort();
    const list = ["sats", "btc", ...filtered];
    supportedCurrenciesCache.set(source, { list, fetchedAt: now });
    return list;
  } catch (err) {
    logger.error({ err }, "Failed to fetch supported currencies from CoinGecko");
    if (cached) return cached.list;
    const fallback = ["usd", "eur", "gbp", "xau", "jpy", "aud", "cad", "chf"];
    const base = source === "binance" ? fallback.filter((c) => BINANCE_FIAT_QUOTES.has(c)) : fallback;
    return ["sats", "btc", ...base];
  }
}

export function satsToFiat(sats: number, price: BtcPrice): { usd: number; eur: number; gbp: number } {
  const btc = sats / 100_000_000;
  return {
    usd: Math.round(btc * price.usd * 100) / 100,
    eur: Math.round(btc * price.eur * 100) / 100,
    gbp: Math.round(btc * price.gbp * 100) / 100,
  };
}

export function fiatToSats(amount: number, currency: "usd" | "eur" | "gbp", price: BtcPrice): number {
  const priceInCurrency = price[currency];
  if (!priceInCurrency) return 0;
  return Math.round((amount / priceInCurrency) * 100_000_000);
}
