// Read-only probe: subscribe to NIP-47 notifications on the platform wallet,
// mint a 1-sat HOLD invoice (never paid, never exposed), and print every
// notification event received for N seconds, then cancel the hold.
// Purpose: see the exact notification_type / payload shapes Alby Hub emits
// before wiring a handler to them. No money moves.
// Usage: node <this> <nwcUrl> [seconds]
import { NWCClient } from '@getalby/sdk';
import { randomBytes, createHash } from 'node:crypto';
const [url, secsArg] = process.argv.slice(2);
const secs = Number(secsArg ?? 40);
const t = () => new Date().toISOString().slice(11, 23);
const client = new NWCClient({ nostrWalletConnectUrl: url });
const info = await client.getInfo();
console.log(`[${t()}] methods=${info.methods.join(',')}`);
console.log(`[${t()}] notifications=${JSON.stringify(info.notifications ?? null)}`);
const unsub = await client.subscribeNotifications((n) => {
  console.log(`[${t()}] NOTIFICATION type=${n.notification_type} payload=${JSON.stringify(n.notification).slice(0, 400)}`);
});
console.log(`[${t()}] subscribed`);
const preimage = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
let hold;
try {
  hold = await client.makeHoldInvoice({ amount: 1000, description: 'openLN notification probe (unpaid)', expiry: 120, payment_hash: hash });
  console.log(`[${t()}] hold minted hash=${hold.payment_hash?.slice(0, 16)} state=${hold.state}`);
} catch (e) { console.log(`[${t()}] makeHoldInvoice FAIL ${e.code ?? ''} ${e.message}`); }
console.log(`[${t()}] listening ${secs}s for notifications (expect none unless something is paid)...`);
await new Promise((r) => setTimeout(r, secs * 1000));
if (hold) {
  try { await client.cancelHoldInvoice({ payment_hash: hash }); console.log(`[${t()}] cancel_hold_invoice OK`); }
  catch (e) { console.log(`[${t()}] cancel_hold_invoice on a PENDING (unaccepted) hold -> ${e.code ?? ''} ${e.message}`); }
  try { const l = await client.lookupInvoice({ payment_hash: hash }); console.log(`[${t()}] lookup after cancel: state=${l.state}`); }
  catch (e) { console.log(`[${t()}] lookup after cancel -> ${e.code ?? ''} ${e.message}`); }
}
unsub();
client.close();
process.exit(0);
