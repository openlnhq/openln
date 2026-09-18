// Read-only: resolve the merchant account's NWC URL through the app's own
// resolver (dist build) and run the wallet probe against it. Prints relay +
// pubkey prefix only, never the secret.
// Usage: cd /opt/openln && node <this> <accountId>
import { getAccountNwcUrl } from '/opt/openln/dist/core/money/nwc.js';
import { NWCClient } from '@getalby/sdk';
const [accountId] = process.argv.slice(2);
const url = await getAccountNwcUrl(accountId);
if (!url) { console.log('no NWC url resolved for account', accountId); process.exit(1); }
const relay = new URL(url.replace('nostr+walletconnect://', 'https://')).searchParams.get('relay');
const t = () => new Date().toISOString().slice(11, 23);
console.log(`[${t()}] MERCHANT relay=${relay} walletpubkey=${url.slice(23, 31)}...`);
const bounded = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timeout ${ms}ms`)), ms))]);
const client = new NWCClient({ nostrWalletConnectUrl: url });
async function step(name, fn, ms = 20000) {
  const start = Date.now();
  try { const r = await bounded(fn(), ms); console.log(`[${t()}] MERCHANT ${name} OK ${Date.now() - start}ms`, JSON.stringify(r).slice(0, 220)); return r; }
  catch (e) { console.log(`[${t()}] MERCHANT ${name} FAIL ${Date.now() - start}ms code=${e.code ?? ''} ${e.message}`); return undefined; }
}
const info = await step('get_info', () => client.getInfo());
await step('get_balance', () => client.getBalance());
const inv = await step('make_invoice(1 sat, 60s)', () => client.makeInvoice({ amount: 1000, description: 'openLN wallet probe', expiry: 60 }), 45000);
if (inv?.payment_hash) await step('lookup_invoice', () => client.lookupInvoice({ payment_hash: inv.payment_hash }));
if (info?.methods) console.log(`[${t()}] MERCHANT methods=${info.methods.join(',')}`);
client.close();
process.exit(0);
