// Read-only wallet health probe. No payments, no invoice mutation.
// Usage (on a host with the openln node_modules): node wallet_probe.mjs <label> <nwcUrl>
// Prints timings for get_info, get_balance, make_invoice(1 sat, 60s expiry), lookup_invoice.
import { NWCClient } from '@getalby/sdk';
const [label, url] = process.argv.slice(2);
if (!url) { console.error('usage: node wallet_probe.mjs <label> <nwcUrl>'); process.exit(2); }
const t = () => new Date().toISOString().slice(11, 23);
const bounded = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`probe timeout ${ms}ms`)), ms))]);
const client = new NWCClient({ nostrWalletConnectUrl: url });
const relay = new URL(url.replace('nostr+walletconnect://', 'https://')).searchParams.get('relay');
console.log(`[${t()}] ${label} relay=${relay} pubkey=${url.slice(23, 31)}...`);
async function step(name, fn, ms = 20000) {
  const start = Date.now();
  try { const r = await bounded(fn(), ms); console.log(`[${t()}] ${label} ${name} OK ${Date.now() - start}ms`, JSON.stringify(r).slice(0, 300)); return r; }
  catch (e) { console.log(`[${t()}] ${label} ${name} FAIL ${Date.now() - start}ms code=${e.code ?? ''} ${e.message}`); return undefined; }
}
const info = await step('get_info', () => client.getInfo());
await step('get_balance', () => client.getBalance());
const inv = await step('make_invoice(1 sat)', () => client.makeInvoice({ amount: 1000, description: 'openLN wallet probe', expiry: 60 }), 45000);
if (inv?.payment_hash) await step('lookup_invoice', () => client.lookupInvoice({ payment_hash: inv.payment_hash }));
if (info?.methods) console.log(`[${t()}] ${label} methods=${info.methods.join(',')}`);
client.close();
process.exit(0);
