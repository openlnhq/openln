// Real local PostgreSQL and the compiled reconciler. Every wallet/money boundary
// is replaced before importing it. No app bootstrap, real credentials or sockets.
// npm run build && DATABASE_URL=postgresql://postgres@127.0.0.1:5544/openln_qa_ric_recovery node --experimental-test-module-mocks --test tests/ric-direct-expiry.integration.mjs
import test, {mock, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import pg from 'pg';
import {expiryInvoice} from './helpers/ric-expiry-invoice.mjs';

const url = new URL(process.env.DATABASE_URL || '');
if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || !url.pathname.startsWith('/openln_qa_')) throw Error('Local scratch DB required');
const ownWallet = 'offline-own-wallet';
const responses = new Map(), calls = [];
let settled = 0, cancelled = 0, sql, pool, account, lookupHook;
class Wallet {
  constructor({nostrWalletConnectUrl}) { this.wallet = nostrWalletConnectUrl; }
  close() {}
  async lookupInvoice({payment_hash: hash}) {
    calls.push({wallet: this.wallet, hash});
    await lookupHook?.(hash);
    const raw = responses.get(hash);
    if (raw instanceof Error) throw raw;
    if (!raw) throw Object.assign(Error('No record'), {code:'NOT_FOUND'});
    return structuredClone(raw);
  }
  async listTransactions() { throw Error('Direct receiving has no outgoing wallet leg'); }
  async cancelHoldInvoice() { cancelled++; throw Error('Direct invoice must never cancel a hold'); }
  async payInvoice() { throw Error('FORBIDDEN PAYMENT'); }
}
mock.module('@getalby/sdk', {namedExports:{NWCClient:Wallet}});
mock.module('../dist/core/money/holdWrap.js', {namedExports:{advanceWrap:async()=>{throw Error('FORBIDDEN WRAP');}}});
mock.module('../dist/core/money/invoiceMonitor.js', {namedExports:{settleInvoiceByPaymentHash:async(hash)=>{
  settled++;
  await sql.query('UPDATE pending_invoices SET paid_at=now() WHERE payment_hash=$1', [hash]);
}}});
mock.module('../dist/core/money/feeEngine.js', {namedExports:{finalizePendingSend:async()=>{throw Error('FORBIDDEN SEND');}}});
mock.module('../dist/core/money/nwc.js', {namedExports:{PLATFORM_NWC_URL:'offline-platform-wallet',relayInCooldown:()=>false,getAccountNwcUrl:async()=>{throw Error('Must use the invoice wallet snapshot');}}});
mock.module('../dist/core/money/encrypt.js', {namedExports:{decrypt:encrypted=>{assert.equal(encrypted, ownWallet);return encrypted;}}});
const fresh = () => import('../dist/core/ric-reconcile.js?restart=' + randomUUID());
before(async()=>{
  sql = new pg.Client({connectionString:process.env.DATABASE_URL});await sql.connect();
  ({pool}=await import('../dist/core/db/index.js'));
  const entity=randomUUID();account=randomUUID();
  await sql.query("INSERT INTO entities(id,handle,pin_hash) VALUES($1,$2,'password-login')", [entity,'qa_direct_'+entity]);
  await sql.query('INSERT INTO accounts(id,entity_id) VALUES($1,$2)', [account,entity]);
});
after(async()=>{await sql?.end();await pool?.end();});
async function seed(options={}) {
  const invoice=await expiryInvoice(options), id=randomUUID(), hash=invoice.payment_hash;
  await sql.query('INSERT INTO pending_invoices(id,account_id,payment_hash,bolt11,amount_sats,nwc_url_encrypted,expires_at,created_at) VALUES($1,$2,$3,$4,100,$5,$6,$7)', [id,account,hash,invoice.invoice,ownWallet,new Date(invoice.expiresAt*1000),new Date(invoice.createdAt*1000)]);
  responses.set(hash,{type:'incoming',payment_hash:hash,state:'expired'});
  return {id,hash,invoice};
}

test('expired signed direct invoice plus fresh own-wallet pending proof retires without amount field', async()=>{
  const x=await seed({createdAt:Math.floor(Date.now()/1000)-4*86400,expiry:3600});
  // Exact shape observed on the stuck bb5d48 checkout. The wallet's created_at
  // may describe its record rather than this BOLT11 and amount is omitted.
  responses.set(x.hash,{type:'incoming',payment_hash:x.hash,state:'pending',settled_at:null,expires_at:x.invoice.expiresAt,created_at:1788785328});
  await sql.query('UPDATE pending_invoices SET expires_at=$2 WHERE id=$1',[x.id,new Date(x.invoice.expiresAt*1000+1259)]);
  const api=await fresh(), result=await api.reconcileRicInvoiceNow(x.hash);
  assert.equal(result.status,'expired','signed invoice expiry plus fresh unpaid own-wallet observation must retire a direct checkout');
  assert.equal(result.dispatched,false);assert.equal(settled,0);assert.equal(cancelled,0);
  const proof=(await sql.query('SELECT ric_expiry_confirmed_at,paid_at,wrap_status FROM pending_invoices WHERE id=$1',[x.id])).rows[0];
  assert.ok(proof.ric_expiry_confirmed_at);assert.equal(proof.paid_at,null);assert.equal(proof.wrap_status,null);
  const story=(await sql.query("SELECT detail FROM payment_events WHERE payment_hash=$1 AND event='invoice.expired_reconciled'",[x.hash])).rows;
  assert.equal(story.length,1);assert.equal(story[0].detail.walletState,'pending');
  assert.equal(story[0].detail.invoiceExpiresAt,x.invoice.expiresAt);
  assert.equal(story[0].detail.walletExpiresAt,x.invoice.expiresAt);
  responses.set(x.hash,Error('Offline after restart'));
  assert.equal((await (await fresh()).reconcileRicInvoiceNow(x.hash)).status,'expired');
});

test('background recovery finds unpaid direct invoices older than 24 hours', async(t)=>{
  t.mock.timers.enable({apis:['setInterval']});
  const x=await seed({createdAt:Math.floor(Date.now()/1000)-4*86400,expiry:3600});
  responses.set(x.hash,{type:'incoming',payment_hash:x.hash,state:'pending',settled_at:null,expires_at:x.invoice.expiresAt});
  const api=await fresh(), stop=api.startRicReconciler();
  try {
    let row;
    const attempts=Number((await sql.query('SELECT count(*) AS n FROM pending_invoices')).rows[0].n)+2;
    for(let i=0;i<attempts;i++) {
      row=(await sql.query('SELECT ric_expiry_confirmed_at FROM pending_invoices WHERE id=$1',[x.id])).rows[0];
      if(row.ric_expiry_confirmed_at)break;
      t.mock.timers.tick(15000);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.ok(row.ric_expiry_confirmed_at,'old direct checkout must not age out of recovery');
  } finally {stop();}
});

for(const scenario of ['not-found','offline','wrong-hash','missing-type','outgoing','accepted','unknown-state','paid-flag','settled-flag','invalid-time','infinite-time','bad-preimage','amount-mismatch','amount-null','amount-string','wallet-expiry-missing','wallet-expiry-mismatch','wallet-expiry-future','wallet-expiry-string','invalid-bolt11','mixed-case','hash-mismatch-bolt11','duplicate-expiry','db-expiry-future','has-hold','has-merchant']) {
  test(`expired direct ${scenario} remains unknown, not expired or paid`,async()=>{
    const x=await seed({createdAt:Math.floor(Date.now()/1000)-4*86400,expiry:3600,...(scenario==='duplicate-expiry'?{extraTags:[['x',[1]]]}:{})});
    const raw={type:'incoming',payment_hash:x.hash,state:'pending',settled_at:null,expires_at:x.invoice.expiresAt};
    if(scenario==='wrong-hash')raw.payment_hash='00'.repeat(32);
    if(scenario==='missing-type')delete raw.type;
    if(scenario==='outgoing')raw.type='outgoing';
    if(scenario==='accepted')raw.state='accepted';
    if(scenario==='unknown-state')raw.state='unknown';
    if(scenario==='paid-flag')raw.paid=true;
    if(scenario==='settled-flag')raw.settled=true;
    if(scenario==='invalid-time')raw.settled_at='123';
    if(scenario==='infinite-time')raw.settled_at=Infinity;
    if(scenario==='bad-preimage')raw.preimage='00'.repeat(32);
    if(scenario==='amount-mismatch')raw.amount=999;
    if(scenario==='amount-null')raw.amount=null;
    if(scenario==='amount-string')raw.amount='100000';
    if(scenario==='wallet-expiry-missing')delete raw.expires_at;
    if(scenario==='wallet-expiry-mismatch')raw.expires_at--;
    if(scenario==='wallet-expiry-future')raw.expires_at=Math.floor(Date.now()/1000)+3600;
    if(scenario==='wallet-expiry-string')raw.expires_at=String(raw.expires_at);
    responses.set(x.hash,scenario==='not-found'?Object.assign(Error('NOT_FOUND'),{code:'NOT_FOUND'}):scenario==='offline'?Error('offline'):raw);
    if(scenario==='invalid-bolt11')await sql.query('UPDATE pending_invoices SET bolt11=$2 WHERE id=$1',[x.id,x.invoice.invoice.slice(0,-1)]);
    if(scenario==='mixed-case')await sql.query('UPDATE pending_invoices SET bolt11=$2 WHERE id=$1',[x.id,'LN'+x.invoice.invoice.slice(2)]);
    if(scenario==='hash-mismatch-bolt11')await sql.query('UPDATE pending_invoices SET bolt11=$2 WHERE id=$1',[x.id,(await expiryInvoice({createdAt:x.invoice.createdAt,expiry:3600})).invoice]);
    if(scenario==='db-expiry-future')await sql.query("UPDATE pending_invoices SET expires_at=now()+interval '1 hour' WHERE id=$1",[x.id]);
    if(scenario==='has-hold')await sql.query('UPDATE pending_invoices SET hold_preimage=$2 WHERE id=$1',[x.id,x.invoice.preimage]);
    if(scenario==='has-merchant')await sql.query('UPDATE pending_invoices SET merchant_payment_hash=$2 WHERE id=$1',[x.id,'12'.repeat(32)]);
    const before=settled,api=await fresh(),result=await api.reconcileRicInvoiceNow(x.hash);
    assert.equal(result.status,'pending');assert.equal(result.doNotRetry,true);assert.equal(settled,before);
    const row=(await sql.query('SELECT ric_expiry_confirmed_at,paid_at FROM pending_invoices WHERE id=$1',[x.id])).rows[0];
    assert.equal(row.ric_expiry_confirmed_at,null);assert.equal(row.paid_at,null);
  });
}

for(const state of ['pending','completed'])test(`direct expiry cannot hide ${state} local outgoing liability`,async()=>{
  const x=await seed({createdAt:Math.floor(Date.now()/1000)-4*86400,expiry:3600});
  responses.set(x.hash,{type:'incoming',payment_hash:x.hash,state:'pending',expires_at:x.invoice.expiresAt});
  await sql.query("INSERT INTO transactions(account_id,direction,type,status,amount_sats,payment_hash) VALUES($1,'out','send',$2,100,$3)",[account,state,x.hash]);
  const result=await (await fresh()).reconcileRicInvoiceNow(x.hash);
  assert.equal(result.status,'pending','known local outgoing liability must prevent expiry terminalization');
});

test('one old sweep observation cannot queue a backlog ahead of an active checkout',async()=>{
  for(let i=0;i<22;i++) {
    const x=await seed({createdAt:Math.floor(Date.now()/1000)-4*86400,expiry:3600});
    responses.set(x.hash,Error('offline old wallet'));
  }
  const active=await seed();responses.set(active.hash,{type:'incoming',payment_hash:active.hash,state:'pending'});
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);
  const start=calls.length;lookupHook=async()=>{entered();await gate;};
  const api=await fresh(),stop=api.startRicReconciler();
  try {
    await started;api.enqueueRicInvoice(active.hash);release();
    for(let i=0;i<100&&!calls.slice(start).some(c=>c.hash===active.hash);i++)await new Promise(resolve=>setTimeout(resolve,10));
    assert.equal(calls.slice(start).findIndex(c=>c.hash===active.hash),1,'active checkout must be observed immediately after the already-running old lookup');
  } finally {release();lookupHook=undefined;stop();}
});

test('direct terminal proof survives a new module instance and offline wallet', async()=>{
  const x=await seed(), first=await fresh();
  assert.equal((await first.reconcileRicInvoiceNow(x.hash)).status,'expired');
  assert.equal(calls.at(-1).wallet,ownWallet);
  const observations=calls.length;
  responses.set(x.hash,Error('Wallet offline after restart'));
  const restarted=await fresh();
  const {db,pendingInvoicesTable}=await import('../dist/core/db/index.js');
  const {eq}=await import('drizzle-orm');
  const [persisted]=await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash,x.hash));
  assert.equal(restarted.ricInvoiceView(persisted).status,'expired','first cached status after restart must be terminal without queue or wallet work');
  const result=await restarted.reconcileRicInvoiceNow(x.hash);
  assert.equal(result.status,'expired','durable exact-hash proof must survive a process/module restart');
  assert.equal(result.dispatched,false);
  assert.equal(calls.length,observations,'known terminal proof must not need a new wallet connection');
  assert.equal(settled,0);assert.equal(cancelled,0);
  const row=(await sql.query('SELECT paid_at,wrap_status FROM pending_invoices WHERE id=$1',[x.id])).rows[0];
  assert.equal(row.paid_at,null);assert.equal(row.wrap_status,null,'a direct invoice must never be turned into a wrap');
});
