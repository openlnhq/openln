import test,{mock,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
const u=new URL(process.env.DATABASE_URL||'');if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.startsWith('/openln_qa_'))throw Error('Local scratch only');
let lookups=0,resolveLookup;const gate=new Promise(r=>resolveLookup=r);
class Wallet{close(){}async lookupInvoice(){lookups++;await gate;throw Error('offline observation unavailable');}}
mock.module('@getalby/sdk',{namedExports:{NWCClient:Wallet}});
process.env.PORT='0';process.env.RIC_RECONCILE_ENABLED='0';
process.env.ALBY_NWC_URL='nostr+walletconnect://'+'1'.repeat(64)+'?relay=wss://offline.invalid&secret='+'2'.repeat(64);
const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});let base,token,hash;
before(async()=>{await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;const eid=randomUUID(),aid=randomUUID();token=randomBytes(32).toString('hex');hash=randomBytes(32).toString('hex');await sql.query("INSERT INTO entities(id,handle,pin_hash) VALUES($1,$2,'password-login')",[eid,'qa_route_'+eid]);await sql.query('INSERT INTO accounts(id,entity_id) VALUES($1,$2)',[aid,eid]);await sql.query("INSERT INTO device_tokens(account_id,token,label) VALUES($1,$2,'QA')",[aid,token]);await sql.query("INSERT INTO pending_invoices(account_id,payment_hash,bolt11,amount_sats,wrap_status,expires_at) VALUES($1,$2,'fixture',100,'created',now()+interval '15 minutes')",[aid,hash]);});
after(async()=>{resolveLookup();await new Promise(r=>setTimeout(r,30));server.closeAllConnections();await new Promise(r=>server.close(r));await sql.end();await pool.end();});
test('actual device status route returns cached pending while wallet lookup is blocked',async()=>{const start=performance.now();const r=await fetch(base+'/api/pos/invoice/'+hash+'/status',{headers:{authorization:'Bearer '+token}});assert.equal(r.status,200);const body=await r.text();assert.equal(JSON.parse(body).status,'pending');assert.equal(JSON.parse(body).paymentHash,hash);assert.equal(Number(r.headers.get('content-length')),Buffer.byteLength(body));assert.ok(performance.now()-start<500,'UI status must not await Lightning');await new Promise(resolve=>setTimeout(resolve,30));assert.ok(lookups>0,'queued observation should start asynchronously');});
test('device cancellation route is reachable but never claims cancellation from a stalled observation',async()=>{const r=await fetch(base+'/api/pos/invoice/'+hash+'/cancel',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});assert.equal(r.status,200);const result=await r.json();assert.equal(result.status,'pending');assert.equal(result.doNotRetry,true);});
test('actual RIC Cancel immediately closes its own minted unpaid checkout without waiting for wallet cleanup',async()=>{
 const aid=(await sql.query('SELECT account_id FROM device_tokens WHERE token=$1',[token])).rows[0].account_id;
 const pre=randomBytes(32).toString('hex'),ph=createHash('sha256').update(Buffer.from(pre,'hex')).digest('hex');
 await sql.query("INSERT INTO pending_invoices(account_id,payment_hash,bolt11,amount_sats,wrap_status,hold_preimage,merchant_payment_hash,merchant_bolt11,expires_at)VALUES($1,$2,'offline-fixture',39,'created',$3,$4,'offline-merchant',now()+interval '15 minutes')",[aid,ph,pre,randomBytes(32).toString('hex')]);
 const at=performance.now();const r=await fetch(base+'/api/pos/invoice/'+ph+'/cancel',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:'{}'});
 assert.equal(r.status,200);const out=await r.json();assert.equal(out.status,'cancelled');assert.equal(out.dispatched,false);assert.equal(out.cleanupPending,true);assert.ok(performance.now()-at<500,'terminal must not wait on external wallet');
 const row=(await sql.query('SELECT wrap_status,paid_at FROM pending_invoices WHERE payment_hash=$1',[ph])).rows[0];assert.equal(row.wrap_status,'cancel_pending');assert.equal(row.paid_at,null);
 const next=await fetch(base+'/api/pos/invoice/'+ph+'/status',{headers:{authorization:'Bearer '+token}});assert.equal((await next.json()).status,'cancelled');
});
