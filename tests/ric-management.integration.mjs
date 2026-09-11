import test, {after, before} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createHash, randomBytes} from 'node:crypto';
import {readFile, mkdtemp, copyFile, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import pg from 'pg';

const dbUrl = new URL(process.env.DATABASE_URL ?? '');
if (!['localhost', '127.0.0.1', '[::1]'].includes(dbUrl.hostname) || !dbUrl.pathname.startsWith('/openln_qa_')) throw Error('Local scratch DB required');
process.env.DOMAIN = 'ric.test.invalid';
const {pool} = await import('../dist/core/db/index.js');
const sql = new pg.Client({connectionString: process.env.DATABASE_URL});
let handlers, server, base;
const accounts = [];
const tokens = [];
const token = () => randomBytes(32).toString('hex');
async function call(path, {method = 'GET', bearer, body} = {}) {
  return fetch(base + path, {method, headers: {...(bearer ? {Authorization: `Bearer ${bearer}`} : {}), ...(body !== undefined ? {'Content-Type': 'application/json'} : {})}, ...(body !== undefined ? {body: JSON.stringify(body)} : {})});
}
before(async () => {
  await sql.connect();
  // Dynamic load lets the first RED assertion name the missing feature.
  try { handlers = await import(pathToFileURL(new URL('../dist/plugins/ric-management.js', import.meta.url).pathname)); }
  catch (e) { if (e.code !== 'ERR_MODULE_NOT_FOUND') throw e; }
  if (!handlers) return;
  server = createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://untrusted-host.invalid');
      // Session identity is supplied by the parent only after real auth.
      const owner = req.headers.authorization === 'Bearer fixture-session' && accounts[0] ? {id: accounts[0].id, authType: 'session'} : undefined;
      if (await handlers.handleRicManagementRoute(req, res, u, owner)) return;
      res.writeHead(404); res.end();
    } catch { res.writeHead(500); res.end('test route error'); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  for (const a of accounts) {
    await sql.query('DELETE FROM device_tokens WHERE account_id=$1', [a.id]);
    await sql.query('DELETE FROM accounts WHERE id=$1', [a.id]);
    await sql.query('DELETE FROM entities WHERE id=$1', [a.entityId]);
  }
  await sql.end();
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await pool.end();
});

test('verified release has a content-addressed URL, explicit wire length and public HEAD', async () => {
  assert.equal(typeof handlers?.handleRicManagementRoute, 'function', 'RIC management route must exist');
  assert.equal(typeof handlers.handleRicFirmwareRoute, 'function', 'legacy firmware route hook must exist');
  const e = (await sql.query("INSERT INTO entities(handle,pin_hash) VALUES($1,'password-login') RETURNING id", ['qa_ric_' + randomBytes(6).toString('hex')])).rows[0];
  const a = (await sql.query("INSERT INTO accounts(entity_id,wallet_mode) VALUES($1,'unset') RETURNING id", [e.id])).rows[0];
  accounts.push({id: a.id, entityId: e.id});
  const raw = token();
  const d = (await sql.query('INSERT INTO device_tokens(account_id,token,label) VALUES($1,$2,$3) RETURNING id', [a.id, raw, 'Release test RIC'])).rows[0];
  tokens.push({id: d.id, raw});
  const r = await call('/api/firmware/posbox-version', {bearer: raw});
  assert.equal(r.status, 200);
  const text = await r.text(); const m = JSON.parse(text);
  assert.deepEqual(Object.keys(m).slice(0, 2), ['version', 'url']);
  assert.equal(Number(r.headers.get('content-length')), Buffer.byteLength(text));
  assert.equal(r.headers.get('connection'), 'close');
  assert.match(r.headers.get('cache-control'), /no-store/);
  assert.match(r.headers.get('cache-control'), /no-transform/);
  const app = await readFile('firmware/ric-ota.bin');
  const sha = createHash('sha256').update(app).digest('hex');
  assert.equal(m.sha256, sha); assert.equal(m.bytes, app.length);
  assert.equal(m.board, 'esp32-2432s028r'); assert.equal(m.partitionLayout, 'ric-ab-v1');
  assert.equal(m.version, JSON.parse(await readFile('firmware/manifest.json', 'utf8')).version);
  assert.equal(m.url, `https://ric.test.invalid/api/firmware/ric/${sha}.bin`);
  const head = await call('/api/firmware/posbox-version', {method: 'HEAD', bearer: raw});
  assert.equal(head.status, 200); assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(text)); assert.equal(await head.text(), '');
  const legacy = await call('/api/firmware/posbox-ota.bin', {method: 'HEAD'});
  assert.equal(legacy.status, 200); assert.equal(Number(legacy.headers.get('content-length')), app.length); assert.match(legacy.headers.get('cache-control'), /no-store/);
  for (const method of ['GET', 'HEAD']) {
    const b = await call(new URL(m.url).pathname, {method});
    assert.equal(b.status, 200); assert.equal(Number(b.headers.get('content-length')), app.length);
    assert.equal(b.headers.get('content-type'), 'application/octet-stream');
    assert.equal(b.headers.get('content-encoding'), null);
    assert.match(b.headers.get('cache-control'), /immutable/); assert.match(b.headers.get('cache-control'), /no-transform/);
    assert.equal(b.headers.get('etag'), `"${sha}"`);
    const bytes = Buffer.from(await b.arrayBuffer()); assert.deepEqual(bytes, method === 'HEAD' ? Buffer.alloc(0) : app);
  }
  const wrong = await call('/api/firmware/ric/' + '0'.repeat(64) + '.bin'); assert.equal(wrong.status, 404);
  const anonymous = await call('/api/firmware/posbox-version'); assert.equal(anonymous.status, 401);
});

test('device hello and status persist token-scoped metadata; owner listing excludes secrets and other accounts', async () => {
  const hello = {firmwareVersion: '1.0.2', board: 'esp32-2432s028r', mac: 'A0:B1:C2:D3:E4:F5', partitionLayout: 'ric-ab-v1', bootId: 'boot-fixture-1', uptimeMs: 8000, runningPartition: 'app0', ota: {state: 'checking', targetVersion: '1.0.3'}};
  const r = await call('/api/ric/hello', {method: 'POST', bearer: tokens[0].raw, body: hello});
  assert.equal(r.status, 200, 'device boot handshake must exist');
  assert.deepEqual(await r.json(), {status: 'ok', deviceId: tokens[0].id, accountId: accounts[0].id});
  const first = (await sql.query('SELECT * FROM ric_device_telemetry WHERE device_token_id=$1', [tokens[0].id])).rows[0];
  assert.equal(first.firmware_version, '1.0.2'); assert.equal(first.boot_id, hello.bootId);
  assert.equal(Number(first.uptime_ms), 8000); assert.equal(first.ota_state, 'checking');
  const s = await call('/api/ric/status', {method: 'POST', bearer: tokens[0].raw, body: {uptimeMs: 10000, ota: {state: 'failed', code: -32512, targetVersion: '1.0.3'}}});
  assert.equal(s.status, 200);
  const again = await call('/api/ric/status', {method: 'POST', bearer: tokens[0].raw, body: {uptimeMs: 12000}}); assert.equal(again.status, 200);
  const row = (await sql.query('SELECT * FROM ric_device_telemetry WHERE device_token_id=$1', [tokens[0].id])).rows[0];
  assert.equal(row.firmware_version, '1.0.2'); assert.equal(row.ota_state, 'failed'); assert.equal(row.ota_code, '-32512'); assert.equal(row.ota_target_version, '1.0.3');
  assert.equal(Number(row.uptime_ms), 12000); assert.ok(row.last_seen_at); assert.ok(row.last_hello_at);
  const lastUsed = (await sql.query('SELECT last_used_at FROM device_tokens WHERE id=$1', [tokens[0].id])).rows[0]; assert.ok(lastUsed.last_used_at);
  const e = (await sql.query("INSERT INTO entities(handle,pin_hash) VALUES($1,'password-login') RETURNING id", ['qa_ric_' + randomBytes(6).toString('hex')])).rows[0];
  const a = (await sql.query("INSERT INTO accounts(entity_id,wallet_mode) VALUES($1,'unset') RETURNING id", [e.id])).rows[0]; accounts.push({id: a.id, entityId: e.id});
  const raw = token(); const d = (await sql.query('INSERT INTO device_tokens(account_id,token,label) VALUES($1,$2,$3) RETURNING id', [a.id, raw, 'Other owner'])).rows[0]; tokens.push({id: d.id, raw});
  assert.equal((await call('/api/ric/hello', {method: 'POST', bearer: raw, body: {...hello, bootId: 'other-owner'}})).status, 200);
  const list = await call('/api/ric/devices', {bearer: 'fixture-session'}); assert.equal(list.status, 200);
  const text = await list.text(); const {devices} = JSON.parse(text);
  assert.equal(devices.length, 1); assert.equal(devices[0].deviceId, tokens[0].id);
  assert.equal(devices[0].firmwareVersion, '1.0.2'); assert.equal(devices[0].ota.state, 'failed'); assert.equal(devices[0].ota.code, '-32512');
  assert.ok(!text.includes(tokens[0].raw) && !text.includes(raw) && !text.includes(d.id), 'owner projection must not leak raw tokens or another tenant');
  assert.equal((await call('/api/ric/devices', {bearer: tokens[0].raw})).status, 403, 'device token cannot read owner inventory');
  assert.equal((await call('/api/ric/hello', {method: 'POST', bearer: 'fixture-session', body: hello})).status, 401, 'browser session is not device evidence');
  await sql.query('UPDATE device_tokens SET revoked_at=now() WHERE id=$1', [tokens[1].id]);
  assert.equal((await call('/api/ric/hello', {method: 'POST', bearer: tokens[1].raw, body: hello})).status, 401);
  assert.equal((await call('/api/ric/status', {method: 'POST', bearer: tokens[1].raw, body: {uptimeMs: 1}})).status, 401);
});

test('invalid input and untrusted identities cannot change telemetry or expose credentials', async () => {
  const snapshot = (await sql.query('SELECT * FROM ric_device_telemetry WHERE device_token_id=$1', [tokens[0].id])).rows[0];
  for (const body of [{uptimeMs: -1}, {uptimeMs: 1.5}, {board: 'esp32-s3'}, {partitionLayout: 'single-app'}, {bootId: 'x'.repeat(65)}, {token: tokens[0].raw}, {accountId: accounts[1].id}, {ota: {state: 'failed', message: tokens[0].raw}}, {firmwareVersion: 'garbage'}, {runningPartition: 'app2'}]) {
    const r = await call('/api/ric/status', {method: 'POST', bearer: tokens[0].raw, body});
    assert.equal(r.status, 400); assert.deepEqual(await r.json(), {error: 'Invalid device telemetry'});
  }
  const after = (await sql.query('SELECT * FROM ric_device_telemetry WHERE device_token_id=$1', [tokens[0].id])).rows[0]; assert.deepEqual(after, snapshot);
  for (const raw of [undefined, '0'.repeat(64), tokens[0].raw.toUpperCase(), tokens[0].raw + 'x', tokens[0].raw + '.junk']) {
    const r = await call('/api/ric/status', {method: 'POST', bearer: raw, body: {uptimeMs: 9999}}); assert.equal(r.status, 401);
  }
  assert.equal((await call('/api/ric/hello', {method: 'POST', bearer: tokens[0].raw, body: {}})).status, 400);
  assert.equal((await call('/api/ric/hello', {bearer: tokens[0].raw})).status, 405);
  assert.equal((await call('/api/ric/devices')).status, 403);
  const malformed = await fetch(base + '/api/ric/status', {method: 'POST', headers: {Authorization: 'Bearer ' + tokens[0].raw}, body: '{'});
  assert.equal(malformed.status, 400);
});

test('release reader refuses metadata drift, corrupt images and wrong slots', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ric-release-test-'));
  const names = ['manifest.json', 'ric-version.json', 'posbox-latest.bin', 'ric-ota.bin'];
  const reset = async () => { for (const name of names) await copyFile(join('firmware', name), join(dir, name)); };
  try {
    await reset(); await handlers.readRicRelease(dir);
    const manifest = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8'));
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({...manifest, bytes: manifest.bytes + 1}));
    await assert.rejects(handlers.readRicRelease(dir), /release manifest/);
    await reset(); await writeFile(join(dir, 'ric-version.json'), JSON.stringify({version: '9.8.7'}));
    await assert.rejects(handlers.readRicRelease(dir), /release manifest/);
    await reset(); const image = await readFile(join(dir, 'ric-ota.bin')); image[100] ^= 1; await writeFile(join(dir, 'ric-ota.bin'), image);
    await assert.rejects(handlers.readRicRelease(dir), /application image/);
    await reset(); const factory = await readFile(join(dir, 'posbox-latest.bin')); factory.writeUInt32LE(0xe000, 0x8000 + 32 + 4);
    await writeFile(join(dir, 'posbox-latest.bin'), factory);
    await writeFile(join(dir, 'manifest.json'), JSON.stringify({...manifest, sha256: createHash('sha256').update(factory).digest('hex')}));
    await assert.rejects(handlers.readRicRelease(dir), /partition layout/);
  } finally { await rm(dir, {recursive: true, force: true}); }
});
