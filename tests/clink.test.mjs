// CLINK wallet pointers (clinkme.dev): decode + validate, invoice requests,
// debits, and the money-safety classes - GFY is definitive rejection, silence
// is ambiguous (never retry blind), ok carries a proof we can verify.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { nofferEncode, ndebitEncode, OfferPriceType } from '@shocknet/clink-sdk';
import {
  parseClinkPointer, generateClinkAppKey, clinkRequestInvoice, clinkPayInvoice,
  preimageMatchesHash, clinkLatestFrom, describeClinkError,
  ClinkError, ClinkDebitError, ClinkAmbiguousError,
  __setClinkClientFactoryForTests,
} from '../dist/core/money/clink.js';

const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
// Structurally valid bolt11: the openLN parser reads the p-tag; the checksum
// is skipped, so a synthetic invoice round-trips without signing keys.
function mkBolt11(hashHex, sats = null) {
  const words = [0, 0, 0, 0, 0, 0, 0];
  const hw = []; let acc = 0, bits = 0;
  for (const b of Buffer.from(hashHex, 'hex')) { acc = (acc << 8) | b; bits += 8; while (bits >= 5) { bits -= 5; hw.push((acc >> bits) & 31); } }
  if (bits) hw.push((acc << (5 - bits)) & 31);
  words.push(1, hw.length >> 5, hw.length & 31, ...hw);
  return (sats ? 'lnbc' + (sats * 10) + 'n' : 'lnbc') + '1' + words.map(w => CHARSET[w]).join('') + 'qqqqqq';
}

const noffer = nofferEncode({ pubkey: 'a'.repeat(64), relay: 'wss://relay.example', offer: 'offertoken123', priceType: OfferPriceType.Spontaneous });
const ndebit = ndebitEncode({ pubkey: 'b'.repeat(64), relay: 'wss://relay.example' });

let stops = 0;
const scriptClient = (impl) => {
  stops = 0;
  __setClinkClientFactoryForTests(() => ({
    requestInvoice: impl.request ?? (async () => ({ bolt11: '' })),
    debit: impl.debit ?? (async () => ({ res: 'ok' })),
    stop: () => { stops += 1; },
  }));
};

test('pointer parsing: valid codes decode; garbage and tampering are refused', () => {
  const n = parseClinkPointer(noffer);
  assert.equal(n.kind, 'noffer');
  assert.equal(n.pubkey, 'a'.repeat(64));
  assert.equal(n.relay, 'wss://relay.example');
  assert.equal(n.offer, 'offertoken123');
  const d = parseClinkPointer(ndebit);
  assert.equal(d.kind, 'ndebit');
  assert.equal(d.pubkey, 'b'.repeat(64));
  assert.equal(d.k1, null);
  const mid = 20;
  const tampered = noffer.slice(0, mid) + (noffer[mid] === 'q' ? 'p' : 'q') + noffer.slice(mid + 1);
  assert.equal(parseClinkPointer(tampered), null, 'a tampered pointer fails its checksum');
  assert.equal(parseClinkPointer('ndebit1zzzz'), null);
  assert.equal(parseClinkPointer('hello world'), null);
  assert.equal(parseClinkPointer(''), null);
});

test('app keys: one fresh 32-byte identity per connection', () => {
  const k = generateClinkAppKey();
  assert.match(k, /^[0-9a-f]{64}$/);
  assert.notEqual(generateClinkAppKey(), k);
});

test('invoice requests go through the client seam and carry the payment hash', async () => {
  const hash = createHash('sha256').update('clink-offer-test').digest('hex');
  let seen = null;
  scriptClient({ request: async (req, t) => { seen = { req, t }; return { bolt11: mkBolt11(hash, 21) }; } });
  const r = await clinkRequestInvoice({ pointer: parseClinkPointer(noffer), appKey: 'a'.repeat(64), amountSats: 21, description: 'openLN test' });
  assert.equal(r.paymentHash, hash);
  assert.match(r.bolt11, /^lnbc/);
  assert.equal(seen.req.offer, 'offertoken123');
  assert.equal(seen.req.amountSats, 21);
  assert.ok(stops > 0, 'the relay client is stopped after the request');
  // A wallet-side rejection surfaces as ClinkError with the wallet's own code.
  scriptClient({ request: async () => { throw new ClinkError('your wallet rejected the request', 4); } });
  await assert.rejects(
    () => clinkRequestInvoice({ pointer: parseClinkPointer(noffer), appKey: 'a'.repeat(64), amountSats: 1 }),
    (e) => e instanceof ClinkError && e.code === 4,
  );
  // A bolt11 we cannot read is refused (we must know its payment hash).
  scriptClient({ request: async () => ({ bolt11: 'not-an-invoice' }) });
  await assert.rejects(
    () => clinkRequestInvoice({ pointer: parseClinkPointer(noffer), appKey: 'a'.repeat(64), amountSats: 1 }),
    (e) => e instanceof ClinkError,
  );
  __setClinkClientFactoryForTests(null);
});

test('debits: GFY is definitive, ok resolves with its proof, silence is ambiguous', async () => {
  const ptr = parseClinkPointer(ndebit);
  const call = () => clinkPayInvoice({ pointer: ptr, appKey: 'b'.repeat(64), bolt11: mkBolt11('c'.repeat(64), 10), amountSats: 10 });
  scriptClient({ debit: async () => ({ res: 'GFY', code: 5, error: 'budget exceeded' }) });
  await assert.rejects(call, (e) => e instanceof ClinkDebitError && e.code === 5);
  scriptClient({ debit: async () => ({ res: 'ok', preimage: 'ab'.repeat(32) }) });
  const ok = await call();
  assert.equal(ok.preimage, 'ab'.repeat(32));
  assert.ok(stops > 0, 'the relay client is stopped after the debit');
  scriptClient({ debit: async () => { throw new Error('relay closed'); } });
  await assert.rejects(call, (e) => e instanceof ClinkAmbiguousError);
  scriptClient({ debit: async () => { throw new ClinkError('wallet says no', 1); } });
  await assert.rejects(call, (e) => e instanceof ClinkDebitError && e.code === 1);
  __setClinkClientFactoryForTests(null);
});

test('proofs: a preimage must hash to the invoice payment hash', () => {
  const pre = '11'.repeat(32);
  const h = createHash('sha256').update(Buffer.from(pre, 'hex')).digest('hex');
  assert.equal(preimageMatchesHash(pre, h), true);
  assert.equal(preimageMatchesHash(pre, 'f'.repeat(64)), false);
  assert.equal(preimageMatchesHash('not-hex', h), false);
});

test('a wallet reporting a moved offer surfaces its replacement pointer', () => {
  const moved = new ClinkError('moved', 3, noffer);
  assert.equal(clinkLatestFrom(moved), noffer);
  assert.equal(clinkLatestFrom(new ClinkError('no latest', 3)), null);
  assert.equal(clinkLatestFrom(new Error('x')), null);
});

test('failures read like causes: an unreachable relay never surfaces SDK internals', async () => {
  // The SDK rejects with bare strings ("websocket error") - user copy must
  // still say what happened and what to do.
  assert.match(describeClinkError('websocket error'), /relay/i);
  assert.match(describeClinkError(new Error('Failed to connect to wss://relay.x')), /relay/i);
  assert.match(describeClinkError(new Error('Received network error or non-101 status code.')), /relay/i);
  scriptClient({ request: async () => { throw 'websocket error'; } });
  try {
    await clinkRequestInvoice({ pointer: parseClinkPointer(noffer), appKey: 'a'.repeat(64), amountSats: 1 });
    assert.fail('the request should have thrown');
  } catch (e) {
    assert.ok(e instanceof ClinkError, 'the bare string is normalized to a ClinkError');
    assert.match(describeClinkError(e), /relay/i);
    assert.ok(!/websocket/i.test(describeClinkError(e)), 'no SDK internals leak into user copy');
  }
  __setClinkClientFactoryForTests(null);
});
