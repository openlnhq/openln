// Execute the real admin handler and RIC view in an isolated VM.
// The operator helper is owned/tested separately. No DB, wallets or app bootstrap.
// Run: node --test tests/admin-payment-cancel.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import ts from 'typescript';
import * as crypto from 'node:crypto';

const sources = Object.fromEntries(['admin/adminPayments', 'ric-reconcile'].map(name => [name,
  ts.transpileModule(readFileSync(new URL(`../core/${name}.ts`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText]));
const id = '11111111-1111-4111-8111-111111111111';
const owner = '22222222-2222-4222-8222-222222222222';
const admin = { id: '33333333-3333-4333-8333-333333333333', handle: 'treasury-admin', createdAt: '2026-01-01' };
const preimage = '11'.repeat(32);
const hash = crypto.createHash('sha256').update(Buffer.from(preimage, 'hex')).digest('hex');
const merchant = '22'.repeat(32);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const clone = value => structuredClone(value);
const cleanupMessage = 'Checkout cancelled. RIC can continue. Wallet hold cleanup remains pending; this is not a refund confirmation.';

function fixture(options = {}) {
  const row = { id, accountId: owner, paymentHash: hash, merchantPaymentHash: merchant,
    holdPreimage: preimage, preimage: null, merchantBolt11: 'fixture-merchant', bolt11: 'fixture-hold',
    amountSats: 100, feeSats: 2, wrapStatus: 'created', paidAt: null, ricExpiryConfirmedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'), expiresAt: new Date('2099-01-01T00:00:00Z'),
    wrapUpdatedAt: null, nwcUrlEncrypted: 'fixture-encrypted', memo: 'Fixture only', ...options.row };
  const f = { row, events: [], queries: [], helperCalls: [], walletCalls: 0,
    result: { status: 'cancelled', paymentHash: hash, dispatched: false, cleanupPending: true }, ...options };
  f.row = row;
  const names = ['pendingInvoicesTable', 'transactionsTable', 'paymentEventsTable', 'accountsTable', 'entitiesTable'];
  const tables = Object.fromEntries(names.map(name => [name, new Proxy({ name }, {
    get: (target, key) => key === 'name' ? target.name : { table: name, key },
  })]));
  const data = () => ({ pendingInvoicesTable: f.missing ? [] : [f.row, ...(f.extraRows ?? [])],
    transactionsTable: f.transactions ?? [], paymentEventsTable: f.events,
    accountsTable: [{ id: owner, entityId: owner, businessName: 'Fixture merchant' }],
    entitiesTable: [{ id: owner, handle: 'fixture-owner' }] });
  const value = (column, record) => column?.table ? record[column.table]?.[column.key] : column;
  const predicates = {
    eq: (column, expected) => {
      // Match PostgreSQL's UUID constraint, catching UUID OR hash queries.
      if (['id', 'accountId', 'entityId'].includes(column.key) && typeof expected === 'string' && !uuid.test(expected)) {
        throw Error('invalid input syntax for type uuid');
      }
      return record => value(column, record) === value(expected, record);
    },
    and: (...conditions) => record => conditions.filter(Boolean).every(p => p(record)),
    or: (...conditions) => record => conditions.filter(Boolean).some(p => p(record)),
    isNull: column => record => value(column, record) == null,
    isNotNull: column => record => value(column, record) != null,
    inArray: (column, values) => record => values.includes(value(column, record)),
    desc: column => column,
    ilike: (column, pattern) => record => String(value(column, record) ?? '').toLowerCase().includes(pattern.replaceAll('%', '').toLowerCase()),
    sql: (parts, ...columns) => record => {
      const text = parts.join('?');
      if (text === 'true') return true;
      if (text === '? is not null') return value(columns[0], record) != null;
      throw Error(`Unexpected fixture SQL expression: ${text}`);
    },
  };
  const db = { select: selection => {
    let table, predicate = () => true, count = Infinity, offset = 0;
    const joins = [];
    const query = {
      from: t => { table = t; return query; },
      where: p => { predicate = p; return query; },
      limit: n => { count = n; return query; },
      offset: n => { offset = n; return query; },
      orderBy: () => query,
      leftJoin: (t, p) => { joins.push([t, p, false]); return query; },
      innerJoin: (t, p) => { joins.push([t, p, true]); return query; },
      then: (resolve, reject) => Promise.resolve().then(() => {
        f.queries.push(table.name);
        let records = data()[table.name].map(r => ({ [table.name]: clone(r) }));
        for (const [other, on, inner] of joins) records = records.flatMap(record => {
          const matches = data()[other.name].map(r => ({ ...record, [other.name]: clone(r) })).filter(on);
          return matches.length ? matches : inner ? [] : [record];
        });
        return records.filter(predicate).slice(offset, offset + count).map(record => selection
          ? Object.fromEntries(Object.entries(selection).map(([key, column]) => [key,
            typeof column === 'function' ? column(record) : value(column, record)]))
          : record[table.name]);
      }).then(resolve, reject),
    };
    return query;
  } };
  const cache = {};
  const forbidden = () => { throw Error('Forbidden fixture operation'); };
  const load = name => {
    if (cache[name]) return cache[name];
    const module = { exports: {} }; cache[name] = module.exports;
    const require = path => {
      if (path === 'node:crypto') return crypto;
      if (path === '@getalby/sdk') return { NWCClient: forbidden };
      if (path === 'drizzle-orm') return predicates;
      if (path.endsWith('/db/index.js')) return { db, ...tables };
      if (path.endsWith('/ric-reconcile.js')) return load('ric-reconcile');
      if (path === './ricCancel.js') return { adminCancelRicInvoice: async (accountId, paymentHash, details) => {
        f.helperCalls.push({ accountId, paymentHash, ...clone(details) });
        if (f.helperError) throw Error('Fixture failure contains private wallet material');
        await f.onCancel?.();
        if (f.result.status === 'cancelled' && !f.row.paidAt) f.row.wrapStatus = f.result.cleanupPending ? 'cancel_pending' : 'cancelled';
        if (f.result.status === 'expired') f.row.ricExpiryConfirmedAt = new Date();
        return clone(f.result);
      } };
      if (path.endsWith('/paymentLog.js')) return { recordPaymentEventSync: async event => f.events.push(clone(event)) };
      if (path.endsWith('/holdWrap.js')) return { advanceWrap: forbidden };
      if (path.endsWith('/invoiceMonitor.js')) return { settleInvoiceByPaymentHash: forbidden };
      if (path.endsWith('/feeEngine.js')) return { finalizePendingSend: forbidden, checkOwnSettlementProof: forbidden };
      if (path.endsWith('/nwc.js')) return { PLATFORM_NWC_URL: 'fixture.invalid',
        lookupInvoice: async () => { f.walletCalls++; throw Error('Fixture wallet unavailable'); }, getBalance: forbidden };
      if (path.endsWith('/encrypt.js')) return { decrypt: forbidden };
      if (path.endsWith('/logger.js')) return { logger: { info() {}, warn() {}, error() {} } };
      if (path.endsWith('/events.js')) return { emitAccountEvent: forbidden };
      if (path.endsWith('/lnAddress.js')) return {};
      throw Error(`Forbidden dependency: ${path}`);
    };
    vm.runInNewContext(`(function(require,module,exports){${sources[name]}\n})`, {
      Buffer, console, setTimeout, clearTimeout, setInterval, clearInterval, URLSearchParams,
      process: { env: { ADMIN_HANDLES: admin.handle, ADMIN_SECRET: 'fixture-admin-token' } },
    }, { filename: `${name}.ts` })(require, module, module.exports);
    return module.exports;
  };
  f.api = load('admin/adminPayments');
  f.request = async (path = `${id}/cancel`, options = {}) => {
    const req = Readable.from([options.raw ?? JSON.stringify(options.body ?? { reason: 'Failed checkout at counter', paymentHash: hash })]);
    req.method = options.method ?? 'POST';
    req.headers = { 'content-type': 'application/json', ...options.headers };
    let statusCode, response;
    const res = { writeHead: code => { statusCode = code; }, end: text => { response = JSON.parse(text); } };
    await f.api.handleAdminPaymentsRoute(req, res, new URL(`/api/admin/payments${path ? '/' + path : ''}`, 'http://fixture.invalid'),
      Object.hasOwn(options, 'session') ? options.session : admin);
    return { statusCode, body: response };
  };
  return f;
}

test('admin cancellation delegates bound invoice, actor and reason without duplicating helper audit', async () => {
  const f = fixture();
  const result = await f.request();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.status, 'cancelled');
  assert.equal(result.body.paymentHash, hash);
  assert.equal(result.body.cleanupPending, true);
  assert.equal(result.body.message, cleanupMessage);
  assert.equal(f.row.wrapStatus, 'cancel_pending');
  assert.deepEqual(f.helperCalls, [{ accountId: owner, paymentHash: hash,
    actor: `session:${admin.id}:${admin.handle}`, reason: 'Failed checkout at counter' }]);
  assert.equal(f.events.length, 0, 'operator helper owns atomic audit');
  assert.ok(!JSON.stringify(result).includes(preimage));
  assert.ok(!JSON.stringify(result).includes('fixture-admin-token'));
});

for (const [name, request] of [
  ['non-UUID invoice ID', { path: 'not-an-id/cancel' }],
  ['hash in UUID path', { path: `${hash}/cancel` }],
  ['malformed URI encoding', { path: '%E0%A4%A/cancel' }],
  ['malformed JSON', { raw: '{' }],
  ['null body', { raw: 'null' }],
  ['array body', { raw: '[]' }],
  ['missing reason', { body: { paymentHash: hash } }],
  ['blank reason', { body: { reason: ' \n ', paymentHash: hash } }],
  ['non-string reason', { body: { reason: 123, paymentHash: hash } }],
  ['oversize reason', { body: { reason: 'x'.repeat(501), paymentHash: hash } }],
  ['missing confirmation', { body: { reason: 'Cancel failed checkout' } }],
  ['invalid confirmation', { body: { reason: 'Cancel failed checkout', paymentHash: 'bad' } }],
  ['uppercase confirmation', { body: { reason: 'Cancel failed checkout', paymentHash: hash.toUpperCase() } }],
  ['whitespace confirmation', { body: { reason: 'Cancel failed checkout', paymentHash: ` ${hash}` } }],
]) test(`invalid cancellation ${name} returns 400 before DB or helper access`, async () => {
  const f = fixture();
  const result = await f.request(request.path, request);
  assert.equal(result.statusCode, 400);
  assert.equal(f.queries.length, 0);
  assert.equal(f.helperCalls.length, 0);
});

test('valid but mismatched confirmation cannot cancel the selected invoice', async () => {
  const f = fixture();
  const result = await f.request(undefined, { body: { reason: 'Cancel failed checkout', paymentHash: merchant } });
  assert.equal(result.statusCode, 409);
  assert.equal(f.helperCalls.length, 0);
  assert.equal(f.row.wrapStatus, 'created');
});

test('reason at the limit is preserved exactly for the helper audit', async () => {
  const f = fixture(), reason = ' ' + 'x'.repeat(498) + ' ';
  assert.equal((await f.request(undefined, { body: { reason, paymentHash: hash } })).statusCode, 200);
  assert.equal(f.helperCalls[0].reason, reason);
});

test('missing invoice returns 404 without helper access', async () => {
  const f = fixture({ missing: true });
  assert.equal((await f.request()).statusCode, 404);
  assert.equal(f.helperCalls.length, 0);
});

for (const [name, options, expected] of [
  ['unauthenticated', { session: undefined }, 401],
  ['non-admin session', { session: { ...admin, handle: 'ordinary-user' } }, 403],
  ['wrong admin secret', { session: undefined, headers: { 'x-admin-secret': 'wrong' } }, 401],
]) test(`${name} cannot reach cancellation or invoice reads`, async () => {
  const f = fixture();
  assert.equal((await f.request(undefined, options)).statusCode, expected);
  assert.equal(f.queries.length, 0);
  assert.equal(f.helperCalls.length, 0);
});

test('admin secret authorization attributes the credential type, not its value', async () => {
  const f = fixture();
  assert.equal((await f.request(undefined, { session: undefined, headers: { 'x-admin-secret': 'fixture-admin-token' } })).statusCode, 200);
  assert.equal(f.helperCalls[0].actor, 'admin_secret');
});

for (const [status, expected] of [['pending', 202], ['paid', 409], ['cancelled', 200], ['expired', 200], ['not_found', 404]]) {
  test(`helper ${status} produces truthful HTTP ${expected}`, async () => {
    const f = fixture({ result: { status, paymentHash: hash, ...(status === 'pending' ? { doNotRetry: true } : {}) } });
    const response = await f.request();
    assert.equal(response.statusCode, expected);
    assert.equal(response.body.status, status);
    assert.equal(response.body.paymentHash, hash);
    assert.equal(typeof response.body.message, 'string');
    if (status === 'pending') assert.equal(response.body.doNotRetry, true);
  });
}

test('concurrent persisted payment wins over stale helper cancellation response', async () => {
  const f = fixture();
  f.onCancel = () => { f.row.paidAt = new Date(); };
  const response = await f.request();
  assert.equal(response.statusCode, 409);
  assert.equal(response.body.status, 'paid');
  assert.notEqual(response.body.cleanupPending, true);
});

test('helper failure does not leak private wallet error material', async () => {
  const f = fixture({ helperError: true });
  const response = await f.request();
  assert.equal(response.statusCode, 500);
  assert.ok(!JSON.stringify(response).includes('private wallet material'));
});

for (const [wrapStatus, canCancel, checkoutStatus] of [
  [null, true, 'pending'], ['created', true, 'pending'], ['cancelling', true, 'pending'],
  ['cancel_pending', true, 'cancelled'], ['accepted', false, 'accepted'],
  ['forwarding', false, 'forwarding'], ['forwarded', false, 'forwarded'],
  ['needs_reconciliation', false, 'pending'], ['settled', false, 'paid'], ['cancelled', false, 'cancelled'],
]) test(`DB-only detail exposes cancellation capability for ${wrapStatus ?? 'direct'}`, async () => {
  const f = fixture({ row: { wrapStatus } });
  const response = await f.request(`${id}?live=0`, { method: 'GET' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.actions.canCancelPayment, canCancel);
  assert.equal(response.body.checkoutStatus, checkoutStatus);
  assert.equal(response.body.live, null);
  assert.equal(f.walletCalls, 0);
  assert.ok(!JSON.stringify(response).includes(preimage));
  assert.ok(!JSON.stringify(response).includes('fixture-encrypted'));
});

for (const field of ['paidAt', 'ricExpiryConfirmedAt']) test(`${field} disables manual cancellation`, async () => {
  const f = fixture({ row: { wrapStatus: null, [field]: new Date() } });
  const response = await f.request(`${id}?live=0`, { method: 'GET' });
  assert.equal(response.body.actions.canCancelPayment, false);
});

for (const reference of [hash, merchant]) test('hash detail lookup never sends a hash to a UUID column: ' + reference, async () => {
  const f = fixture();
  const response = await f.request(`${reference}?live=0`, { method: 'GET' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.invoice.id, id);
  assert.equal(f.walletCalls, 0);
});

for (const reference of ['bad', '%E0%A4%A']) test('malformed detail reference is 400: ' + reference, async () => {
  const f = fixture();
  assert.equal((await f.request(`${reference}?live=0`, { method: 'GET' })).statusCode, 400);
  assert.equal(f.queries.length, 0);
});
