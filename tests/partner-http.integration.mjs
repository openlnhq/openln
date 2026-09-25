import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Route-level tests for the partner portal API (mirrors ric-management.integration.mjs).
const dbUrl = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) || !dbUrl.pathname.startsWith('/openln_qa_')) throw Error('Local scratch DB required (openln_qa_*)');
process.env.DOMAIN = 'partner.test.invalid';

const { pool } = await import('../dist/core/db/index.js');
const { createPartner, handlePartnerRoute } = await import('../dist/plugins/partner.js');
const sql = new pg.Client({ connectionString: process.env.DATABASE_URL });
let server, base;

const call = (path, { method = 'GET', bearer, body } = {}) =>
  fetch(base + path, {
    method,
    headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });

before(async () => {
  await sql.connect();
  server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://untrusted.invalid');
      if (await handlePartnerRoute(req, res, u)) return;
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end(); }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await sql.end();
  if (server) { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
  await pool.end();
});

test('partner HTTP: login issues a token; dashboard requires it and is partner-scoped', async () => {
  const handle = 'qa-http-' + randomBytes(4).toString('hex');
  const p = await createPartner('QA HTTP Partner', handle, 'QA', 'qa-password-123456');
  const login = await call('/api/partner/login', { method: 'POST', body: { handle, password: 'qa-password-123456' } });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  assert.ok(token);
  assert.equal((await call('/api/partner/login', { method: 'POST', body: { handle, password: 'wrong-password-11' } })).status, 401);
  assert.equal((await call(`/api/partner/${p.id}/dashboard`)).status, 401, 'no token -> 401');
  const dash = await call(`/api/partner/${p.id}/dashboard`, { bearer: token });
  assert.equal(dash.status, 200);
  const d = await dash.json();
  assert.equal(d.partner.handle, handle);
  assert.equal(d.balance.earnedSats, 0);
  assert.equal(d.balance.minPayoutSats, 1000);
  assert.equal(d.partner.lightningAddress, null);
  assert.ok(Array.isArray(d.earnings) && Array.isArray(d.payouts) && Array.isArray(d.devices));
  const h2 = 'qa-http2-' + randomBytes(4).toString('hex');
  const p2 = await createPartner('QA HTTP Partner 2', h2, 'QA', 'qa-password-123456');
  const t2 = (await (await call('/api/partner/login', { method: 'POST', body: { handle: h2, password: 'qa-password-123456' } })).json()).token;
  assert.equal((await call(`/api/partner/${p.id}/dashboard`, { bearer: t2 })).status, 401, 'another partner cannot read this dashboard');
  assert.equal((await call(`/api/partner/${p2.id}/claim-code`, { method: 'POST', bearer: t2 })).status, 201, 'own claim code issuance works');
});

test('partner HTTP: payout address validation and payout request guards', async () => {
  const handle = 'qa-http-' + randomBytes(4).toString('hex');
  const p = await createPartner('QA HTTP Payouts', handle, 'QA', 'qa-password-123456');
  const { token } = await (await call('/api/partner/login', { method: 'POST', body: { handle, password: 'qa-password-123456' } })).json();
  const bad = await call(`/api/partner/${p.id}/payout-address`, { method: 'PUT', bearer: token, body: { address: 'not-an-address' } });
  assert.equal(bad.status, 400);
  assert.equal((await call(`/api/partner/${p.id}/payouts`, { method: 'POST' })).status, 401, 'payout request needs the partner token');
  const noAddr = await call(`/api/partner/${p.id}/payouts`, { method: 'POST', bearer: token });
  assert.equal(noAddr.status, 400);
  assert.match((await noAddr.json()).error, /payout address/i);
  await sql.query('UPDATE partner_accounts SET lightning_address=$1 WHERE id=$2', ['qa@partner.test.invalid', p.id]);
  const below = await call(`/api/partner/${p.id}/payouts`, { method: 'POST', bearer: token });
  assert.equal(below.status, 400);
  assert.match((await below.json()).error, /minimum/i);
});
