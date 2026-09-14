import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

// Execute the real feeEngine only; all DB/wallet boundaries are isolated.
// No app bootstrap, credentials, network, payment, settlement or real DB writes.
const require = createRequire(import.meta.url);
const ts = require(process.env.TYPESCRIPT_PATH || 'typescript');
const source = readFileSync(process.env.FEE_ENGINE_SOURCE || new URL('../core/money/feeEngine.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: {
  module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022,
} }).outputText;
const hash = 'a'.repeat(64);
const invoice = 'offline-invoice';
const cancellationStates = ['cancelling', 'cancel_pending', 'cancelled'];
const table = name => new Proxy({ name }, { get: (obj, key) => key === 'name' ? obj.name : `${name}.${String(key)}` });
const pendingInvoicesTable = table('invoice');
const transactionsTable = table('transaction');
const eq = (column, value) => ({ op: 'eq', column, value });
const and = (...terms) => ({ op: 'and', terms });
function matches(row, predicate) {
  if (predicate.op === 'and') return predicate.terms.every(term => matches(row, term));
  assert.equal(predicate.op, 'eq');
  return row[predicate.column.split('.')[1]] === predicate.value;
}
function fixture(options = {}) {
  const state = {
    row: { id: 'invoice-id', accountId: 'merchant', paymentHash: hash, bolt11: invoice,
      wrapStatus: options.wrapStatus ?? 'created', paidAt: options.paidAt ?? null },
    tx: { id: 'tx-id', status: 'pending' },
    lookups: 0, outgoingLookups: 0, reads: 0, advances: [], writes: [], forbiddenCalls: [],
  };
  const forbidden = name => () => { state.forbiddenCalls.push(name); throw Error(`Forbidden boundary: ${name}`); };
  const db = {
    select(fields) {
      let predicate;
      return {
        from(target) { assert.equal(target, pendingInvoicesTable); return this; },
        where(value) { predicate = value; return this; },
        async limit(value) {
          assert.equal(value, 1); state.reads++;
          if (state.reads > 1 && options.rereadError) throw Error('DB reread unavailable');
          if (!state.row || !matches(state.row, predicate)) return [];
          return [Object.fromEntries(Object.entries(fields).map(([key, column]) => [key, state.row[column.split('.')[1]]]))];
        },
      };
    },
    update(target) {
      assert.equal(target, transactionsTable, 'proof must not mutate invoice/ledger');
      let values, predicate;
      return {
        set(value) { values = value; return this; },
        where(value) { predicate = value; return this; },
        async returning() {
          if (!matches(state.tx, predicate)) return [];
          Object.assign(state.tx, values); state.writes.push(values);
          return [{ id: state.tx.id }];
        },
      };
    },
    insert: forbidden('DB insert'),
  };
  let now = 0;
  class Clock extends Date { static now() { return now; } }
  const dependencies = {
    '../db/index.js': { db, pendingInvoicesTable, transactionsTable },
    'drizzle-orm': { eq, and },
    './nwc.js': {
      PLATFORM_NWC_URL: options.noPlatform ? '' : 'offline-platform',
      async lookupInvoice(paymentHash, wallet) {
        assert.equal(paymentHash, hash); assert.equal(wallet, 'offline-platform');
        state.lookups++;
        if (options.lookup) return options.lookup(state);
        if (options.lookupError) throw Error('NOT_FOUND');
        return { paymentHash: hash, state: options.holdState ?? 'accepted', paid: options.holdPaid ?? false };
      },
      async lookupOutgoingPayment(bolt11, wallet) {
        assert.equal(bolt11, invoice); assert.equal(wallet, 'offline-payer'); state.outgoingLookups++;
        if (options.outgoingError) throw Error('NOT_FOUND');
        return { paymentHash: hash, state: options.outgoingState ?? 'pending', paid: options.outgoingPaid ?? false, feesPaidMsats: 1500 };
      },
      payInvoice: forbidden('payInvoice'), makeInvoice: forbidden('makeInvoice'),
      getAccountNwcUrl: forbidden('getAccountNwcUrl'),
    },
    './holdWrap.js': { advanceWrap: async row => { state.advances.push(row); } },
    './lnAddress.js': { extractPaymentHash: value => { assert.equal(value, invoice); return hash; } },
    './logger.js': { logger: { info() {}, warn() {}, error() {} } },
    './paymentLog.js': { recordPaymentEvent: forbidden('ledger/event write') },
  };
  const module = { exports: {} };
  runInNewContext(code, {
    exports: module.exports, module, Date: Clock, Error,
    setTimeout(fn, ms) { now += ms; queueMicrotask(fn); },
    require(spec) { assert.ok(Object.hasOwn(dependencies, spec), `Unmocked import ${spec}`); return dependencies[spec]; },
  }, { filename: 'actual-feeEngine.cjs' });
  return { state, api: module.exports,
    proof: () => module.exports.checkOwnSettlementProof(hash),
    resolve: () => module.exports.resolveAmbiguousPayment(new module.exports.AmbiguousPaymentError('tx-id', invoice, Error('reply timeout')), 'offline-payer'),
  };
}
function noSuccessEffects(f) {
  assert.equal(f.state.advances.length, 0, 'aborted accepted hold must not kick advanceWrap');
  assert.equal(f.state.writes.length, 0, 'unresolved hold must not finalize payer transaction');
  assert.deepEqual(f.state.forbiddenCalls, []);
}
for (const wrapStatus of cancellationStates) {
  test(`${wrapStatus}: late accepted unpaid hold is not settlement proof`, async () => {
    const f = fixture({ wrapStatus });
    assert.equal(await f.proof(), null); noSuccessEffects(f);
  });
  test(`${wrapStatus}: resolver preserves pending payer and never advances`, async () => {
    const f = fixture({ wrapStatus });
    assert.equal((await f.resolve()).status, 'pending');
    assert.equal(f.state.tx.status, 'pending'); assert.ok(f.state.outgoingLookups > 0); noSuccessEffects(f);
  });
  test(`${wrapStatus}: cancellation winning during live lookup defeats stale created proof`, async () => {
    let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    const f = fixture({ lookup: async () => { entered(); return new Promise(resolve => { release = resolve; }); } });
    const result = f.proof(); await started;
    f.state.row.wrapStatus = wrapStatus;
    release({ paymentHash: hash, state: 'accepted', paid: false });
    assert.equal(await result, null); noSuccessEffects(f);
  });
  test(`${wrapStatus}: paidAt is authoritative even with unavailable wallet`, async () => {
    const f = fixture({ wrapStatus, paidAt: new Date(), lookupError: true });
    assert.equal(await f.proof(), hash); assert.equal(f.state.lookups, 0); assert.equal(f.state.writes.length, 0);
  });
  for (const hold of [{ holdState: 'settled' }, { holdState: 'accepted', holdPaid: true }]) {
    test(`${wrapStatus}: live paid evidence wins (${JSON.stringify(hold)})`, async () => {
      const f = fixture({ wrapStatus, ...hold, rereadError: true });
      assert.equal(await f.proof(), hash); assert.equal(f.state.advances.length, 0);
    });
  }
  test(`${wrapStatus}: paying wallet paid evidence still completes with actual fees`, async () => {
    const f = fixture({ wrapStatus, outgoingState: 'settled', outgoingPaid: true });
    const result = await f.resolve();
    assert.equal(result.status, 'completed'); assert.equal(result.feeSats, 2);
    assert.equal(f.state.outgoingLookups, 1); assert.equal(f.state.tx.status, 'completed');
    assert.equal(f.state.tx.feeSats, 2); assert.equal(f.state.advances.length, 0);
  });
  test(`${wrapStatus}: paying wallet definitive failed evidence still fails`, async () => {
    const f = fixture({ wrapStatus, outgoingState: 'failed' });
    assert.equal((await f.resolve()).status, 'failed'); assert.equal(f.state.tx.status, 'failed');
    assert.equal(f.state.advances.length, 0);
  });
}
for (const wrapStatus of ['accepted', 'forwarding', 'forwarded', 'settled']) {
  test(`${wrapStatus}: existing DB success fast path unchanged`, async () => {
    const f = fixture({ wrapStatus, lookupError: true });
    assert.equal(await f.proof(), hash); assert.equal(f.state.lookups, 0);
  });
}
test('created: accepted hold remains unproven until forwarding ownership is won', async () => {
  const f = fixture(); assert.equal(await f.proof(), null); assert.equal(f.state.advances.length, 1);
  f.state.row.wrapStatus='cancel_pending';
  assert.equal(await f.proof(), null, 'a cancellation winning the asynchronous advance cannot inherit payer success');
});
test('created: live paid hold still succeeds and kicks wrap without fallible reread', async () => {
  const f = fixture({ holdState: 'settled', rereadError: true });
  assert.equal(await f.proof(), hash); assert.equal(f.state.advances.length, 1);
});
for (const holdState of ['pending', 'failed', 'cancelled', 'unknown']) {
  test(`${holdState}: unpaid wallet hold does not prove success or failure`, async () => {
    const f = fixture({ wrapStatus: 'cancel_pending', holdState });
    assert.equal((await f.resolve()).status, 'pending'); noSuccessEffects(f);
  });
}
test('wallet lookup errors remain unresolved, not definitive failure', async () => {
  const f = fixture({ wrapStatus: 'cancel_pending', lookupError: true, outgoingError: true });
  assert.equal((await f.resolve()).status, 'pending'); noSuccessEffects(f);
});
test('failed wallet state does not prove success merely from paid flag', async () => {
  const f = fixture({ wrapStatus: 'cancel_pending', holdState: 'failed', holdPaid: true });
  assert.equal(await f.proof(), null); noSuccessEffects(f);
});
test('fresh DB paid truth wins cancellation during accepted lookup', async () => {
  const f = fixture({ lookup: async state => { state.row.wrapStatus = 'cancel_pending'; state.row.paidAt = new Date(); return { state: 'accepted', paid: false }; } });
  assert.equal(await f.proof(), hash); assert.equal(f.state.advances.length, 0);
});
test('fresh settled DB truth wins during accepted lookup', async () => {
  const f = fixture({ lookup: async state => { state.row.wrapStatus = 'settled'; return { state: 'accepted', paid: false }; } });
  assert.equal(await f.proof(), hash); assert.equal(f.state.advances.length, 0);
});
test('accepted lookup followed by DB reread error is unresolved', async () => {
  const f = fixture({ rereadError: true }); assert.equal(await f.proof(), null); noSuccessEffects(f);
});
test('accepted lookup followed by invoice deletion is unresolved', async () => {
  const f = fixture({ lookup: async state => { state.row = null; return { state: 'accepted', paid: false }; } });
  assert.equal(await f.proof(), null); noSuccessEffects(f);
});
test('missing hash, missing invoice, unpaid direct invoice and missing platform have no proof', async () => {
  for (const mode of ['hash', 'row', 'direct', 'platform']) {
    const f = fixture({ noPlatform: mode === 'platform' });
    if (mode === 'row') f.state.row = null;
    if (mode === 'direct') f.state.row.wrapStatus = null;
    assert.equal(await f.api.checkOwnSettlementProof(mode === 'hash' ? null : hash), null); noSuccessEffects(f);
  }
});
