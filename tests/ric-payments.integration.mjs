import test,{before,after,mock} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {pathToFileURL} from 'node:url';
import pg from 'pg';
import bcrypt from 'bcryptjs';
import {OfflineNWCClient,walletFixture,invoiceFixture} from './helpers/ric-wallet.mjs';
import {sunParams} from './helpers/sun.mjs';

if(!process.env.DATABASE_URL||!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
if(!process.env.SESSION_SECRET)throw Error('Explicit QA SESSION_SECRET required');
// Injection is explicit and test-only. Actual routes, feeEngine, ledger, crypto,
// auth, and PostgreSQL are exercised; only the SDK wallet boundary is replaced.
mock.module('@getalby/sdk',{namedExports:{NWCClient:OfflineNWCClient}});
const dist=process.env.RIC_TEST_DIST?pathToFileURL(process.env.RIC_TEST_DIST.replace(/\/$/,'')+'/'):new URL('../dist/',import.meta.url);
const load=p=>import(new URL(p,dist));
const {handlePosboxRoute}=await load('plugins/posbox.js');
const {handleCardTapRoute}=await load('plugins/card-tap.js');
const {AuthService}=await load('core/auth/service.js');
const {encrypt}=await load('core/money/encrypt.js');
const {pool}=await load('core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});
const auth=new AuthService();let base,server,merchant,holder,token,otherToken,card;
const key1='11'.repeat(16),key2='22'.repeat(16);
const nwc='nostr+walletconnect://'+'a'.repeat(64)+'?relay=wss%3A%2F%2Foffline.invalid&secret='+'b'.repeat(64);
async function call(path,{body,authToken=token}={}){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(authToken?{authorization:'Bearer '+authToken}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {code:r.status,data:await r.json()};}
async function create(amountSats=100,requestId){const r=await call('/api/pos/withdraw',{body:{amountSats,pin:'123456',...(requestId?{requestId}:{})}});assert.equal(r.code,200,JSON.stringify(r.data));return r.data;}
async function callback(k1,invoice){return call('/api/pos/withdraw/callback?'+new URLSearchParams({k1,pr:invoice}),{authToken:null});}
function cardUrl(counter=1){return 'https://offline.invalid/card/'+card+'?'+new URLSearchParams(sunParams(key1,key2,counter));}
async function send(k1,extra={}){return call('/api/pos/send-to-card',{body:{k1,cardUrl:cardUrl(),amountSats:100,pin:'123456',...extra}});}
async function eventually(fn,predicate,timeout=3000){const end=Date.now()+timeout;for(;;){const value=await fn();if(predicate(value))return value;if(Date.now()>end)throw Error('Timed out waiting for fixture state: '+JSON.stringify(value));await new Promise(r=>setTimeout(r,20));}}
function gate(){let resolve;const promise=new Promise(r=>{resolve=r});return {promise,resolve};}

before(async()=>{
 await sql.connect();
 async function account(label){const eid=randomUUID(),id=randomUUID(),dt=randomBytes(32).toString('hex');await sql.query('INSERT INTO entities(id,handle,pin_hash) VALUES($1,$2,$3)',[eid,'qa_ricpay_'+label+'_'+randomBytes(5).toString('hex'),await bcrypt.hash('123456',4)]);await sql.query("INSERT INTO accounts(id,entity_id,currency,wallet_mode,custom_nwc_url) VALUES($1,$2,'sats','custom',$3)",[id,eid,encrypt(nwc+(label==='holder'?'&lud16=holder@offline.invalid':''))]);await sql.query('INSERT INTO device_tokens(account_id,token,label) VALUES($1,$2,$3)',[id,dt,'RIC QA']);return {id,token:dt};}
 const a=await account('merchant'),b=await account('holder');merchant=a.id;holder=b.id;token=a.token;otherToken=b.token;
 card=randomUUID();await sql.query('INSERT INTO cards(id,account_id,aes_key_0,aes_key_1,aes_key_2,aes_key_3,aes_key_4) VALUES($1,$2,$3,$4,$5,$3,$3)',[card,holder,encrypt('33'.repeat(16)),encrypt(key1),encrypt(key2)]);
 server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://localhost');const bearer=String(req.headers.authorization||'').replace(/^Bearer /,'');const account=bearer?await auth.authenticate(bearer):undefined;if(await handlePosboxRoute(req,res,u,account?{...account,authType:'device'}:undefined))return;if(await handleCardTapRoute(req,res,u))return;res.writeHead(404,{'content-type':'application/json'});res.end('{}');}catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:e.message}));}});
 server.listen(0,'127.0.0.1');await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
});
after(async()=>{server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await sql.end();await pool.end();});

test('withdrawal rejects an oversized signed invoice before wallet dispatch',async()=>{
 walletFixture.reset();const {k1}=await create(100);const invoice=await invoiceFixture(1000);
 const result=await callback(k1,invoice.invoice);
 assert.equal(walletFixture.pays.length,0,'Merchant authorized 100 sats, not the 1000-sat invoice');
 assert.equal(result.data.status,'ERROR');
});

test('one checkout admits one QR invoice under concurrent callbacks',async()=>{
 walletFixture.reset();const {k1}=await create();const a=await invoiceFixture(),b=await invoiceFixture();const hold=gate();
 walletFixture.pay=async f=>{await hold.promise;return {preimage:f.preimage,fees_paid:0};};
 const requests=[callback(k1,a.invoice),callback(k1,b.invoice)];
 await eventually(async()=>walletFixture.pays.length,n=>n>=1);await new Promise(r=>setTimeout(r,50));const calls=walletFixture.pays.length;hold.resolve();await Promise.all(requests);
 assert.equal(calls,1,'Two valid different invoices cannot both claim the same withdrawal');
});

test('repeated wrong merchant send PINs are throttled before further attempts',async()=>{
 const statuses=[];
 for(let i=0;i<7;i++) statuses.push((await call('/api/pos/withdraw',{body:{amountSats:100,pin:'000000'}})).code);
 assert.ok(statuses.includes(429),'SEND PIN brute force must be bounded');
 await sql.query('DELETE FROM ric_send_pin_attempts WHERE account_id=$1',[merchant]);
});

test('checkout identity is 64-hex, creation replay is stable, authorization lasts 600 seconds',async()=>{
 const requestId=randomBytes(32).toString('hex');const first=await create(100,requestId);const second=await create(100,requestId);
 assert.match(first.k1,/^[0-9a-f]{64}$/);assert.equal(first.k1,second.k1);assert.equal(first.expiresAt,second.expiresAt);
 const row=(await sql.query('SELECT extract(epoch from expires_at-created_at) AS ttl FROM ric_send_checkouts WHERE k1=$1',[first.k1])).rows[0];assert.equal(Number(row.ttl),600);
 assert.equal((await call('/api/pos/withdraw',{body:{requestId,amountSats:101,pin:'123456'}})).code,409);
});

test('NFC retransmission binds one recipient invoice and one receipt',async()=>{
 walletFixture.reset();const {k1}=await create();const first=await send(k1),retry=await send(k1);
 assert.equal(first.code,200,JSON.stringify(first));assert.equal(first.data.status,'OK');assert.equal(retry.data.status,'OK');
 assert.equal(walletFixture.mints.length,1);assert.equal(walletFixture.pays.length,1);
 const row=(await sql.query('SELECT * FROM ric_send_checkouts WHERE k1=$1',[k1])).rows[0];assert.equal(row.state,'paid');assert.ok(row.receipt_tx_id);
 assert.equal((await sql.query('SELECT count(*) FROM transactions WHERE account_id=$1 AND direction=\'in\' AND payment_hash=$2',[holder,row.payment_hash])).rows[0].count,'1');
});

test('NFC and QR compete for one checkout, never two sends',async()=>{
 walletFixture.reset();const {k1}=await create();const hold=gate();walletFixture.mint=async p=>{await hold.promise;return invoiceFixture(p.amount/1000);};
 const nfc=send(k1);await eventually(async()=>walletFixture.mints.length,n=>n===1);
 const qr=await callback(k1,(await invoiceFixture()).invoice);assert.equal(qr.data.status,'ERROR');hold.resolve();await nfc;
 assert.equal(walletFixture.pays.length,1);
});

test('cancelling an unused or preparing checkout revokes QR and prevents a late worker pay',async()=>{
 walletFixture.reset();const {k1}=await create();const hold=gate();walletFixture.mint=async p=>{await hold.promise;return invoiceFixture(p.amount/1000);};
 const nfc=send(k1);await eventually(async()=>walletFixture.mints.length,n=>n===1);
 const cancelled=await call('/api/pos/withdraw/'+k1+'/cancel',{body:{}});assert.equal(cancelled.code,200);assert.equal(cancelled.data.status,'cancelled');hold.resolve();await nfc;
 assert.equal((await callback(k1,(await invoiceFixture()).invoice)).data.status,'ERROR');assert.equal(walletFixture.pays.length,0);
 assert.equal((await call('/api/pos/withdraw/'+k1+'/cancel',{body:{}})).data.status,'cancelled');
});

test('ambiguous NFC response is pending and cannot be cancelled or expired after dispatch',async()=>{
 walletFixture.reset();const {k1}=await create();walletFixture.pay=async()=>{throw Error('reply timeout');};
 const response=await send(k1);assert.equal(response.code,202);assert.equal(response.data.status,'pending');assert.equal(response.data.k1,k1);assert.equal(response.data.doNotRetry,true);
 await sql.query("UPDATE ric_send_checkouts SET expires_at=now()-interval '1 minute' WHERE k1=$1",[k1]);
 const state=await call('/api/pos/withdraw/'+k1+'/status');assert.equal(state.data.status,'pending');assert.equal(state.data.dispatched,true);
 const cancellation=await call('/api/pos/withdraw/'+k1+'/cancel',{body:{}});assert.equal(cancellation.code,409);assert.equal(cancellation.data.status,'pending');
 assert.equal((await send(k1)).code,202);assert.equal(walletFixture.mints.length,1);assert.equal(walletFixture.pays.length,1);
});

test('ambiguous QR response is accepted, duplicate invoice does not dispatch again',async()=>{
 walletFixture.reset();const {k1}=await create();const invoice=await invoiceFixture();walletFixture.pay=async()=>{throw Error('reply timeout');};
 const response=await callback(k1,invoice.invoice);assert.equal(response.data.status,'OK');assert.equal((await callback(k1,invoice.invoice)).data.status,'OK');assert.equal(walletFixture.pays.length,1);
 const status=await call('/api/pos/withdraw/'+k1+'/status');assert.equal(status.data.status,'pending');
});

test('slow wallet response is bounded and reports pending instead of paid',async()=>{
 walletFixture.reset();const {k1}=await create();const hold=gate();walletFixture.pay=async f=>{await hold.promise;return {preimage:f.preimage,fees_paid:0};};
 const start=performance.now();const result=await send(k1);const elapsed=performance.now()-start;
 try{assert.equal(result.code,202);assert.equal(result.data.status,'pending');assert.ok(elapsed<1900,'NFC response took '+elapsed+' ms');}finally{hold.resolve();}
 await eventually(()=>call('/api/pos/withdraw/'+k1+'/status'),r=>r.data.status==='paid');
});

test('legacy NFC without checkout fails before invoice creation and avoids PIN re-prompt text',async()=>{
 walletFixture.reset();const result=await send(undefined);assert.equal(result.code,400);assert.equal(result.data.code,'SEND_CHECKOUT_REQUIRED');assert.doesNotMatch(result.data.error,/pin/i);assert.equal(walletFixture.mints.length,0);assert.equal(walletFixture.pays.length,0);
});

test('cross-account checkout access and invalid card SUN never authorize money',async()=>{
 walletFixture.reset();const {k1}=await create();assert.equal((await call('/api/pos/withdraw/'+k1+'/status',{authToken:otherToken})).code,404);assert.equal((await call('/api/pos/withdraw/'+k1+'/cancel',{body:{},authToken:otherToken})).code,404);
 const invalid=cardUrl().replace(/c=[0-9a-f]+/,'c='+'0'.repeat(16));assert.equal((await send(k1,{cardUrl:invalid})).code,400);assert.equal((await send(k1,{pin:'1357'})).code,401);
 assert.equal(walletFixture.mints.length,0);assert.equal(walletFixture.pays.length,0);
});

test('pre-dispatch wallet decryption failure must not acknowledge an accepted LNURL send',async()=>{
 walletFixture.reset();const {k1}=await create();await sql.query("UPDATE ric_send_checkouts SET payer_nwc_encrypted='invalid-fixture' WHERE k1=$1",[k1]);
 const result=await callback(k1,(await invoiceFixture()).invoice);assert.equal(result.data.status,'ERROR');assert.equal(walletFixture.pays.length,0);
});

test('card missing and wrong PIN rearm one challenge and emit only structured pre-dispatch codes',async()=>{
 walletFixture.reset();await sql.query('UPDATE cards SET pin_hash=$2,pin_fail_count=0,pin_locked_at=NULL,counter=0 WHERE id=$1',[card,await bcrypt.hash('1357',4)]);
 const tapUrl=new URL(cardUrl(1));const tap=await call(tapUrl.pathname+tapUrl.search,{authToken:null});const invoice=await invoiceFixture();const path='/card/'+card+'/callback?'+new URLSearchParams({k1:tap.data.k1,pr:invoice.invoice});
 const missing=await call(path,{authToken:null});assert.equal(missing.data.code,'PIN_REQUIRED');assert.equal(missing.data.dispatched,false);
 const wrong=await call(path+'&pin=0000',{authToken:null});assert.equal(wrong.data.code,'PIN_INVALID');assert.equal(wrong.data.dispatched,false);assert.equal(walletFixture.pays.length,0);
 const row=(await sql.query('SELECT pending_k1,pin_fail_count FROM cards WHERE id=$1',[card])).rows[0];assert.equal(row.pending_k1,tap.data.k1);assert.equal(row.pin_fail_count,1);
 const correct=await call(path+'&pin=1357',{authToken:null});assert.equal(correct.data.status,'OK');assert.equal(walletFixture.pays.length,1);
});

test('separate challenges cannot race a card daily limit while the first payment is unresolved',async()=>{
 walletFixture.reset();await sql.query('UPDATE cards SET pin_hash=NULL,pin_fail_count=0,pin_locked_at=NULL,counter=0,daily_limit_sats=1000,per_tap_limit_sats=1000 WHERE id=$1',[card]);
 const hold=gate();walletFixture.pay=async f=>{await hold.promise;return {preimage:f.preimage,fees_paid:0};};
 const tap1=new URL(cardUrl(1));const first=await call(tap1.pathname+tap1.search,{authToken:null});const inv1=await invoiceFixture(600);
 const pendingCall=call('/card/'+card+'/callback?'+new URLSearchParams({k1:first.data.k1,pr:inv1.invoice}),{authToken:null});
 await eventually(async()=>walletFixture.pays.length,n=>n===1);
 const tap2=new URL(cardUrl(2));const second=await call(tap2.pathname+tap2.search,{authToken:null});const inv2=await invoiceFixture(600);
 const result=await call('/card/'+card+'/callback?'+new URLSearchParams({k1:second.data.k1,pr:inv2.invoice}),{authToken:null});
 try{assert.equal(result.data.status,'ERROR');assert.equal(walletFixture.pays.length,1);}finally{hold.resolve();await pendingCall;}
 await sql.query('UPDATE cards SET daily_limit_sats=100000 WHERE id=$1',[card]);
});

test('card payment dispatch owns a durable per-card reservation until ledger proof resolves it',async()=>{
 walletFixture.reset();await sql.query('UPDATE cards SET pin_hash=NULL,pin_fail_count=0,pin_locked_at=NULL,counter=0 WHERE id=$1',[card]);
 const hold=gate();walletFixture.pay=async f=>{await hold.promise;return {preimage:f.preimage,fees_paid:0};};
 const tapUrl=new URL(cardUrl(1));const tap=await call(tapUrl.pathname+tapUrl.search,{authToken:null});const invoice=await invoiceFixture();
 const pendingCall=call('/card/'+card+'/callback?'+new URLSearchParams({k1:tap.data.k1,pr:invoice.invoice}),{authToken:null});
 await eventually(async()=>walletFixture.pays.length,n=>n===1);
 try{const r=await sql.query('SELECT payment_hash FROM ric_card_claims WHERE card_id=$1',[card]);assert.equal(r.rows[0]?.payment_hash,invoice.payment_hash);}finally{hold.resolve();await pendingCall;}
});

test('an old unresolved card payment still blocks a new tap',async()=>{
 walletFixture.reset();await sql.query('UPDATE cards SET pin_hash=NULL,pin_fail_count=0,pin_locked_at=NULL,counter=0 WHERE id=$1',[card]);
 const old=await invoiceFixture();await sql.query("INSERT INTO transactions(account_id,card_id,direction,type,status,amount_sats,bolt11,payment_hash,created_at) VALUES($1,$2,'out','send','pending',100,$3,$4,now()-interval '2 days')",[holder,card,old.invoice,old.payment_hash]);
 const tapUrl=new URL(cardUrl(1));const tap=await call(tapUrl.pathname+tapUrl.search,{authToken:null});const invoice=await invoiceFixture();
 await call('/card/'+card+'/callback?'+new URLSearchParams({k1:tap.data.k1,pr:invoice.invoice}),{authToken:null});
 assert.equal(walletFixture.pays.length,0,'Age is not proof that a prior payment failed');
 await sql.query("UPDATE transactions SET status='failed' WHERE card_id=$1 AND payment_hash=$2",[card,old.payment_hash]);
});

test('validated card callback acknowledges a slow dispatched payment within two seconds',async()=>{
 walletFixture.reset();await sql.query('UPDATE cards SET pin_hash=NULL,pin_fail_count=0,pin_locked_at=NULL,counter=0 WHERE id=$1',[card]);
 const tapUrl=new URL(cardUrl(1));const tap=await call(tapUrl.pathname+tapUrl.search,{authToken:null});const invoice=await invoiceFixture();const hold=gate();walletFixture.pay=async f=>{await hold.promise;return {preimage:f.preimage,fees_paid:0};};
 const start=performance.now();const result=await call('/card/'+card+'/callback?'+new URLSearchParams({k1:tap.data.k1,pr:invoice.invoice}),{authToken:null});const elapsed=performance.now()-start;
 try{assert.equal(result.data.status,'OK');assert.ok(elapsed<1900,'Card ACK took '+elapsed+' ms');}finally{hold.resolve();}
 await eventually(()=>sql.query('SELECT status FROM transactions WHERE card_id=$1 AND payment_hash=$2',[card,invoice.payment_hash]),r=>r.rows[0]?.status==='completed');
});
