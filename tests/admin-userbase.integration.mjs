import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
process.env.PORT='0';
const SUF=randomBytes(4).toString('hex');
const ADMIN_SECRET='qa-userbase-'+SUF;
const ADMIN_HANDLE='qa_admin_'+SUF;
process.env.ADMIN_SECRET=ADMIN_SECRET;
process.env.ADMIN_HANDLES=ADMIN_HANDLE;
process.env.SESSION_SECRET='qa-ub-session-'+SUF;
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});
let base,a,b,c,aHandle,connNwc,connLn,dOnline,dStale,dRevoked,cardActive;
async function call(path,method='GET',body,token,extra={}){const useTok=token===undefined?a?.token:token;const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(useTok?{Authorization:'Bearer '+useTok}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});let data=null;try{data=await r.json()}catch{}return{status:r.status,data}}
async function reg(handle){const h=handle||('qa_ub_'+randomBytes(5).toString('hex'));const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:h,password:randomBytes(20).toString('hex')})});assert.equal(r.status,201);return r.json()}
const adm=(path,method='GET',body,token)=>call(path,method,body,token,{'X-Admin-Secret':ADMIN_SECRET});

before(async()=>{
  await sql.connect();
  if(!server.listening)await once(server,'listening');
  base='http://127.0.0.1:'+server.address().port;
  a=await reg();b=await reg();c=await reg(ADMIN_HANDLE);
  aHandle=(await sql.query('SELECT e.handle FROM entities e JOIN accounts ac ON ac.entity_id=e.id WHERE ac.id=$1',[a.account.id])).rows[0].handle;
  const eA=(await sql.query('SELECT entity_id FROM accounts WHERE id=$1',[a.account.id])).rows[0].entity_id;
  // wallets: one NWC (garbage ciphertext so no live read), one lnaddress (receive-only)
  connNwc=(await sql.query("INSERT INTO account_connections(account_id,kind,label,nwc_url_encrypted) VALUES($1,'nwc','QA reading wallet','not-real-ciphertext') RETURNING id",[a.account.id])).rows[0].id;
  connLn=(await sql.query("INSERT INTO account_connections(account_id,kind,label,lightning_address) VALUES($1,'lnaddress','QA address','qa@example.com') RETURNING id",[a.account.id])).rows[0].id;
  // RIC fleet: fresh+online, stale, revoked-but-fresh
  dOnline=(await sql.query("INSERT INTO device_tokens(account_id,token,label,mac,last_used_at) VALUES($1,$2,'QA RIC front','AA:BB:CC:00:00:01',now()) RETURNING id",[a.account.id,randomBytes(24).toString('hex')])).rows[0].id;
  await sql.query("INSERT INTO ric_device_telemetry(device_token_id,firmware_version,board,boot_id,uptime_ms,running_partition,rssi,reset_reason,boot_count,wifi_drops,wifi_drops_total,ota_state,last_seen_at,last_hello_at) VALUES($1,'1.2.5','GX7170','qa-boot-1',3600000,'app0',-58,'brownout',42,1,7,'idle',now(),now())",[dOnline]);
  dStale=(await sql.query("INSERT INTO device_tokens(account_id,token,label,mac,last_used_at) VALUES($1,$2,'QA RIC back','AA:BB:CC:00:00:02',now()-interval '50 minutes') RETURNING id",[a.account.id,randomBytes(24).toString('hex')])).rows[0].id;
  await sql.query("INSERT INTO ric_device_telemetry(device_token_id,firmware_version,boot_id,last_seen_at) VALUES($1,'1.2.4','qa-boot-2',now()-interval '50 minutes')",[dStale]);
  dRevoked=(await sql.query("INSERT INTO device_tokens(account_id,token,label,mac,last_used_at,revoked_at) VALUES($1,$2,'QA RIC spare','AA:BB:CC:00:00:03',now(),now()) RETURNING id",[a.account.id,randomBytes(24).toString('hex')])).rows[0].id;
  // cards: one active (recently used), one frozen
  cardActive=(await sql.query("INSERT INTO cards(account_id,aes_key_0,aes_key_1,aes_key_2,aes_key_3,aes_key_4,name,uid,status,last_used_at) VALUES($1,'k','k','k','k','k','QA White','04AABBCCDD01','active',now()) RETURNING id",[a.account.id])).rows[0].id;
  await sql.query("INSERT INTO cards(account_id,aes_key_0,aes_key_1,aes_key_2,aes_key_3,aes_key_4,name,uid,status) VALUES($1,'k','k','k','k','k','QA Black','04AABBCCDD02','frozen')",[a.account.id]);
  // ledger: two completed sales in, one failed send out
  await sql.query("INSERT INTO transactions(account_id,direction,type,status,amount_sats,memo,origin,created_at) VALUES($1,'in','receive','completed',1500,'QA sale 1','ric',now()-interval '2 hours')",[a.account.id]);
  await sql.query("INSERT INTO transactions(account_id,direction,type,status,amount_sats,memo,origin,created_at) VALUES($1,'in','receive','completed',2500,'QA sale 2','ric',now()-interval '1 hour')",[a.account.id]);
  await sql.query("INSERT INTO transactions(account_id,direction,type,status,amount_sats,memo,origin,created_at) VALUES($1,'out','send','failed',300,'QA failed send','app',now()-interval '30 minutes')",[a.account.id]);
  // wraps: one settled, one open
  await sql.query("INSERT INTO pending_invoices(account_id,bolt11,payment_hash,amount_sats,wrap_status,origin,expires_at,paid_at,created_at) VALUES($1,'lnbc1qa-wrap1',$2,4200,'settled','ric',now()+interval '15 minutes',now()-interval '10 minutes',now()-interval '20 minutes')",[a.account.id,'qa-wrap-hash-'+SUF+'-1']);
  await sql.query("INSERT INTO pending_invoices(account_id,bolt11,payment_hash,amount_sats,wrap_status,origin,expires_at,created_at) VALUES($1,'lnbc1qa-wrap2',$2,800,'created','ric',now()+interval '15 minutes',now()-interval '5 minutes')",[a.account.id,'qa-wrap-hash-'+SUF+'-2']);
  // telegram support link
  await sql.query("INSERT INTO telegram_links(entity_id,telegram_user_id,username,first_name) VALUES($1,$2,'qa_ub_tg','QA User')",[eA,700000000+parseInt(SUF,16)%100000000]);
});

after(async()=>{
  // The ledger is deliberately append-only (transactions_no_delete trigger):
  // keep the seeded account as a disposable fixture in the scratch DB, exactly
  // like cards.integration.mjs. Accounts with no ledger rows are cleaned up.
  for(const acc of [b,c]){if(!acc)continue;try{const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[acc.account.id])).rows[0];if(e)await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id])}catch{}}
  await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();
});

test('userbase routes are admin-gated: no session 403, plain session 403, secret or allowlisted session 200',async()=>{
  assert.equal((await call('/api/admin/userbase','GET',undefined,null)).status,403);
  assert.equal((await call('/api/admin/userbase','GET',undefined,b.token)).status,403);
  assert.equal((await adm('/api/admin/userbase','GET',undefined,null)).status,200);
  assert.equal((await call('/api/admin/userbase','GET',undefined,c.token)).status,200);
  assert.equal((await adm('/api/admin/userbase','POST',{})).status,405);
});

test('list returns every account with wallet/RIC/card/payment/support rollups',async()=>{
  const r=await adm('/api/admin/userbase');
  assert.equal(r.status,200);
  assert.ok(r.data.total>=3);
  const row=r.data.accounts.find(x=>x.id===a.account.id);
  assert.ok(row,'seeded account visible');
  assert.equal(row.handle,aHandle);
  assert.equal(row.wallets.count,2);
  assert.equal(row.wallets.kinds.nwc,1);
  assert.equal(row.wallets.kinds.lnaddress,1);
  assert.equal(row.ric.total,3);
  assert.equal(row.ric.active,2);
  assert.equal(row.ric.revoked,1);
  assert.equal(row.ric.online,1);
  assert.equal(row.cards.total,2);
  assert.equal(row.cards.active,1);
  assert.equal(row.cards.frozen,1);
  assert.equal(row.payments.inCount,2);
  assert.equal(row.payments.inVolumeSats,4000);
  assert.equal(row.payments.outVolumeSats,0);
  assert.equal(row.payments.failedCount,1);
  assert.equal(row.payments.wrapsSettled,1);
  assert.equal(row.payments.wrapsSettledSats,4200);
  assert.equal(row.payments.wrapsOpen,1);
  assert.equal(row.support.linked,true);
  assert.equal(row.support.username,'qa_ub_tg');
  // a clean account (b) shows zeros, not nulls
  const rowB=r.data.accounts.find(x=>x.id===b.account.id);
  assert.equal(rowB.wallets.count,0);
  assert.equal(rowB.ric.total,0);
  assert.equal(rowB.cards.total,0);
  assert.equal(rowB.payments.inVolumeSats,0);
  assert.equal(rowB.support.linked,false);
  // no ciphertext or secret fields anywhere in the payload
  assert.ok(!JSON.stringify(r.data).includes('Encrypted'));
});

test('handle search filters and counts',async()=>{
  const r=await adm('/api/admin/userbase?q='+encodeURIComponent(aHandle));
  assert.equal(r.status,200);
  assert.equal(r.data.total,1);
  assert.equal(r.data.accounts[0].id,a.account.id);
  const none=await adm('/api/admin/userbase?q=qa_nomatch_'+SUF);
  assert.equal(none.data.total,0);
  assert.deepEqual(none.data.accounts,[]);
});

test('detail bundles connections, fleet telemetry, cards, ledger and wraps',async()=>{
  const d=await adm('/api/admin/userbase/'+a.account.id);
  assert.equal(d.status,200);
  const acc=d.data.account;
  assert.equal(d.data.connections.length,2);
  assert.equal(d.data.connections.find(x=>x.id===connNwc).hasStoredKey,true);
  assert.equal(d.data.connections.find(x=>x.id===connNwc).kind,'nwc');
  assert.equal(d.data.connections.find(x=>x.id===connLn).lightningAddress,'qa@example.com');
  assert.equal(d.data.devices.length,3);
  const on=d.data.devices.find(x=>x.id===dOnline);
  assert.equal(on.online,true);
  assert.equal(on.firmwareVersion,'1.2.5');
  assert.equal(on.bootId,'qa-boot-1');
  assert.equal(Number(on.uptimeMs),3600000);
  assert.equal(on.runningPartition,'app0');
  assert.equal(on.rssi,-58);
  assert.equal(on.resetReason,'brownout');
  assert.equal(Number(on.bootCount),42);
  assert.equal(Number(on.wifiDrops),1);
  assert.equal(Number(on.wifiDropsTotal),7);
  assert.ok(on.bootedAtApprox,'approximate boot wall-clock derivable from uptime');
  const st=d.data.devices.find(x=>x.id===dStale);
  assert.equal(st.online,false);
  assert.equal(st.rssi,null);
  assert.equal(st.resetReason,null);
  assert.equal(st.bootedAtApprox,null);
  const rv=d.data.devices.find(x=>x.id===dRevoked);
  assert.equal(rv.online,false);
  assert.ok(rv.revokedAt);
  assert.equal(acc.ric.online,1);
  assert.equal(d.data.cards.length,2);
  assert.equal(d.data.cards.find(x=>x.id===cardActive).lastUsedAt!==null,true);
  assert.equal(d.data.transactions.length,3);
  const sale=d.data.transactions.find(x=>x.memo==='QA sale 2');
  assert.equal(Number(sale.amountSats),2500);
  assert.equal(sale.direction,'in');
  assert.equal(d.data.wraps.length,2);
  assert.equal(d.data.wraps.filter(x=>x.wrapStatus==='settled').length,1);
  assert.equal(d.data.security.totpEnabled,false);
  assert.equal(acc.support.linked,true);
  assert.ok(!JSON.stringify(d.data).includes('Encrypted'));
  assert.equal((await adm('/api/admin/userbase/00000000-0000-0000-0000-000000000000')).status,404);
  assert.equal((await adm('/api/admin/userbase/not-a-uuid')).status,404);
});

test('app-boot activity POST records timezone, real client IP and user agent',async()=>{
  assert.equal((await call('/api/activity','POST',{timezone:'Asia/Bangkok'},null)).status,401);
  const p=await call('/api/activity','POST',{timezone:'Asia/Bangkok'},a.token,{'X-Forwarded-For':'9.9.9.9, 1.2.3.4','User-Agent':'qa-agent/1'});
  assert.equal(p.status,200);
  let d=await adm('/api/admin/userbase/'+a.account.id);
  assert.equal(d.data.account.activity.lastIp,'1.2.3.4');
  assert.equal(d.data.account.activity.lastTimezone,'Asia/Bangkok');
  assert.equal(d.data.account.activity.userAgent,'qa-agent/1');
  assert.ok(d.data.account.activity.lastSeenAt);
  assert.ok(d.data.account.activity.firstSeenAt);
  // garbage timezone is rejected and does not overwrite the recorded one
  assert.equal((await call('/api/activity','POST',{timezone:'<script>alert(1)</script>'},a.token)).status,200);
  d=await adm('/api/admin/userbase/'+a.account.id);
  assert.equal(d.data.account.activity.lastTimezone,'Asia/Bangkok');
});

test('balance reads degrade gracefully per connection',async()=>{
  const bal=await adm('/api/admin/userbase/'+a.account.id+'/balances');
  assert.equal(bal.status,200);
  assert.equal(bal.data.results.length,2);
  const nwc=bal.data.results.find(x=>x.kind==='nwc');
  assert.equal(nwc.ok,false);
  assert.ok(nwc.error);
  const ln=bal.data.results.find(x=>x.kind==='lnaddress');
  assert.equal(ln.ok,false);
  assert.ok(ln.error);
  const batch=await adm('/api/admin/userbase/balances?ids='+a.account.id);
  assert.equal(batch.status,200);
  assert.equal(batch.data.results.length,1);
  assert.equal(batch.data.results[0].ok,false);
  assert.equal((await adm('/api/admin/userbase/balances?ids=nope')).status,400);
  assert.equal((await call('/api/admin/userbase/balances?ids='+a.account.id,'GET',undefined,null)).status,403);
});
