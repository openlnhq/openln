// Saved wallet connections: capability matrix, resolution chains, labels and
// the secret-free public view (pure unit checks; no network, no DB).
import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionCapabilities, connectionKindLabel, connectionDisplayLabel, nextConnectionLabel, connectionPublicView } from '../dist/core/money/connections.js';
import { connectionChainForPurpose } from '../dist/core/money/walletSource.js';

test('capabilities by kind: address lanes receive only; unknown kinds stay inert', () => {
  assert.deepEqual(connectionCapabilities('nwc'), { send: true, receive: true });
  assert.deepEqual(connectionCapabilities('blink'), { send: true, receive: true });
  assert.deepEqual(connectionCapabilities('lnaddress'), { send: false, receive: true });
  // Future kinds (e.g. lightning.pub nDebit / nOffer) get an entry when they ship.
  assert.deepEqual(connectionCapabilities('ndebit'), { send: false, receive: false });
  assert.deepEqual(connectionCapabilities('noffer'), { send: false, receive: false });
});

test('resolution chain: feature assignment first, default fallback, de-duplicated', () => {
  const account = { defaultConnectionId: 'd', ricConnectionId: 'r', cardsConnectionId: null };
  assert.deepEqual(connectionChainForPurpose(account, 'ric'), ['r', 'd']);
  assert.deepEqual(connectionChainForPurpose(account, 'cards'), ['d']);
  assert.deepEqual(connectionChainForPurpose(account, 'default'), ['d']);
  assert.deepEqual(connectionChainForPurpose({ defaultConnectionId: 'd', ricConnectionId: 'd', cardsConnectionId: null }, 'ric'), ['d']);
  assert.deepEqual(connectionChainForPurpose({ defaultConnectionId: null, ricConnectionId: null, cardsConnectionId: null }, 'ric'), []);
  const both = { defaultConnectionId: 'd', ricConnectionId: 'r', cardsConnectionId: 'c' };
  assert.deepEqual(connectionChainForPurpose(both, 'cards'), ['c', 'd']);
});

test('public view never carries stored secrets and names kinds in human terms', () => {
  const view = connectionPublicView({ id: '1', kind: 'lnaddress', label: null, lightningAddress: 'alice@ln.test', createdAt: new Date('2026-10-01T00:00:00Z') });
  assert.deepEqual(view, { id: '1', kind: 'lnaddress', label: 'Lightning Address', capabilities: { send: false, receive: true }, address: 'alice@ln.test', createdAt: new Date('2026-10-01T00:00:00Z') });
  assert.ok(!/nwc_url|api_key|encrypted|secret/i.test(JSON.stringify(view)), 'no store fields leak into the API view');
  assert.equal(connectionKindLabel('nwc'), 'Nostr Wallet Connect');
  assert.equal(connectionKindLabel('blink'), 'Blink');
  assert.equal(connectionDisplayLabel('nwc', '  My Hub '), 'My Hub');
  assert.equal(connectionDisplayLabel('nwc', ''), 'Nostr Wallet Connect');
});

test('auto labels number repeat kinds', () => {
  assert.equal(nextConnectionLabel([], 'nwc'), 'Nostr Wallet Connect');
  assert.equal(nextConnectionLabel([{ kind: 'nwc' }], 'nwc'), 'Nostr Wallet Connect 2');
  assert.equal(nextConnectionLabel([{ kind: 'nwc' }, { kind: 'nwc' }], 'nwc'), 'Nostr Wallet Connect 3');
  assert.equal(nextConnectionLabel([{ kind: 'nwc' }], 'lnaddress'), 'Lightning Address');
});
