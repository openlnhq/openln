// Send scanner input classification: bech32 lnurl decode/encode round-trips and
// the pure normalizeSendInput classifier (no network, no DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSendInput } from '../dist/core/money/lnurlTarget.js';
import { decodeLnurl, encodeLnurl } from '../dist/core/money/boltcard.js';

test('lnurl bech32 encodes and decodes round-trip, checksum verified', () => {
  for (const url of ['https://ln.test/.well-known/lnurlp/alice', 'https://getalby.com/lnurlp/openln?x=1&y=2']) {
    const enc = encodeLnurl(url);
    assert.match(enc, /^lnurl1/);
    assert.equal(decodeLnurl(enc), url);
    assert.equal(decodeLnurl(enc.toUpperCase()), url, 'upper case decodes too');
  }
  assert.equal(decodeLnurl('lnurl1qqqqqq'), null, 'bad checksum rejected');
  assert.equal(decodeLnurl('lnurl1q'), null);
  assert.equal(decodeLnurl('notlnurl'), null);
});

test('send input normalization classifies every lightning shape', () => {
  assert.deepEqual(normalizeSendInput('  '), { kind: 'error', message: 'Nothing to read' });

  assert.deepEqual(normalizeSendInput('lnbc10n1qqqqqq'), { kind: 'bolt11', bolt11: 'lnbc10n1qqqqqq' });
  assert.deepEqual(normalizeSendInput('LNBC10N1QQQQQQ'), { kind: 'bolt11', bolt11: 'lnbc10n1qqqqqq' });
  assert.deepEqual(normalizeSendInput('lightning:lnbc10n1qqqqqq'), { kind: 'bolt11', bolt11: 'lnbc10n1qqqqqq' });

  assert.deepEqual(normalizeSendInput('alice@ln.test'), { kind: 'address', address: 'alice@ln.test' });
  assert.deepEqual(normalizeSendInput('LIGHTNING:ALICE@LN.TEST'), { kind: 'address', address: 'alice@ln.test' });

  assert.deepEqual(normalizeSendInput('lnurlp://ln.test/.well-known/lnurlp/alice'), { kind: 'lnurl', url: 'https://ln.test/.well-known/lnurlp/alice' });
  assert.deepEqual(normalizeSendInput('https://ln.test/pay/alice'), { kind: 'lnurl', url: 'https://ln.test/pay/alice' });

  assert.deepEqual(
    normalizeSendInput('bitcoin:bc1qexampleaddress?amount=0.001&lightning=lnbc10n1qqqqqq'),
    { kind: 'bolt11', bolt11: 'lnbc10n1qqqqqq' },
  );
  assert.deepEqual(
    normalizeSendInput('BITCOIN:BC1QEXAMPLE?LIGHTNING=LNBC10N1QQQQQQ'),
    { kind: 'bolt11', bolt11: 'lnbc10n1qqqqqq' },
  );
  assert.equal(normalizeSendInput('bitcoin:bc1qexampleaddress').kind, 'unsupported');

  assert.equal(normalizeSendInput('lno1pqps7sjq').kind, 'unsupported');
  assert.equal(normalizeSendInput('hello world').kind, 'unsupported');
  assert.equal(normalizeSendInput('http://ln.test/x').kind, 'unsupported');
  assert.equal(normalizeSendInput('lnurl1qqqqqq').kind, 'unsupported', 'damaged lnurl is explained, not paid');
});
