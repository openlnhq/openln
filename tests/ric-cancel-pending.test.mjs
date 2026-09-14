// Isolated execution of REAL TypeScript modules. No app bootstrap, .env, DB,
// SDK, relays or payments: the VM require allowlist rejects every unknown import.
// Run: node --test tests/ric-cancel-pending.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import * as crypto from 'node:crypto';
import vm from 'node:vm';
import ts from 'typescript';
const sources = Object.fromEntries(['ric-reconcile','money/holdWrap','money/invoiceMonitor'].map(name => [name,
  ts.transpileModule(readFileSync(new URL(`../core/${name}.ts`,import.meta.url),'utf8'), {
    compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},
  }).outputText]));
const preimage='11'.repeat(32), hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');
const merchant='22'.repeat(32), account='fixture-owner';
const notFound=()=>Object.assign(Error('NOT_FOUND'),{code:'NOT_FOUND'});
const clone=x=>structuredClone(x);
function fixture(options={}) {
  const f={row:{id:'fixture-id',accountId:account,paymentHash:hash,merchantPaymentHash:merchant,
    holdPreimage:preimage,merchantBolt11:'fixture-merchant',bolt11:'fixture-hold',amountSats:100,
    feeSats:2,wrapStatus:'created',paidAt:null,createdAt:new Date('2026-01-01T00:00:00Z'),
    expiresAt:new Date('2099-01-01T00:00:00Z'),...options.row},
    hold:{type:'incoming',payment_hash:hash,state:'pending'},outgoing:undefined,
    cancelMode:'not-found',calls:{cancel:0,pay:0,settle:0,ledger:0,holdLookup:0,list:0},
    sql:[],events:[],cooldown:false,...options};
  // Keep the full default row when only overriding row fields.
  f.row={id:'fixture-id',accountId:account,paymentHash:hash,merchantPaymentHash:merchant,
    holdPreimage:preimage,merchantBolt11:'fixture-merchant',bolt11:'fixture-hold',amountSats:100,
    feeSats:2,wrapStatus:'created',paidAt:null,createdAt:new Date('2026-01-01T00:00:00Z'),
    expiresAt:new Date('2099-01-01T00:00:00Z'),...options.row};
  const table=new Proxy({}, {get:(_,k)=>k});
  const predicates={eq:(k,v)=>r=>r[k]===v,inArray:(k,vs)=>r=>vs.includes(r[k]),
    isNull:k=>r=>r[k]==null,and:(...ps)=>r=>ps.every(p=>p(r))};
  const select=selection=>({from:()=>({where:predicate=>{
    const rows=predicate(f.row)?[selection?Object.fromEntries(Object.entries(selection).map(([k,v])=>[k,f.row[v]])):clone(f.row)]:[];
    return Object.assign(Promise.resolve(rows),{limit:async n=>rows.slice(0,n)});
  }})});
  const db={select,update:()=>({set:values=>({where:predicate=>({returning:async()=>{
    if(!predicate(f.row))return [];Object.assign(f.row,values);return [clone(f.row)];
  }})})}),insert:()=>({values:async()=>{f.calls.ledger++;}})};
  db.transaction=async fn=>fn(db);
  const pool={query:async(sql,args=[])=>{
    f.sql.push(sql);await f.beforeSql?.(sql,args);
    if(sql.startsWith('SELECT id,payment_hash')) {
      const states=sql.match(/wrap_status IN \(([^)]+)\)/)[1].match(/'([^']+)'/g).map(s=>s.slice(1,-1));
      return {rows:!f.row.paidAt&&states.includes(f.row.wrapStatus)?[{id:f.row.id,payment_hash:hash}]:[],rowCount:0};
    }
    assert.ok(sql.startsWith('UPDATE pending_invoices SET wrap_status='),`Unexpected SQL: ${sql}`);
    const target=sql.match(/SET wrap_status='([^']+)'/)[1],where=sql.split(' WHERE ')[1];
    const from=where.match(/wrap_status IN \(([^)]+)\)/)?.[1].match(/'([^']+)'/g).map(s=>s.slice(1,-1))
      ?? [where.match(/wrap_status='([^']+)'/)?.[1]];
    const eligible=f.row.id===args[0]&&(!where.includes('account_id=$2')||f.row.accountId===args[1])
      &&(!where.includes('paid_at IS NULL')||!f.row.paidAt)&&from.includes(f.row.wrapStatus)
      &&!f.failCas?.(target);
    if(eligible)f.row.wrapStatus=target;
    return {rowCount:eligible?1:0,rows:eligible?[{id:f.row.id}]:[]};
  }};
  class Wallet {
    close(){}
    async lookupInvoice({payment_hash:h}) {
      if(h===hash){f.calls.holdLookup++;await f.beforeHoldLookup?.();if(f.lookupError)throw f.lookupError;if(!f.hold)throw notFound();return clone(f.hold);}
      assert.equal(h,merchant);if(f.outgoingError)throw f.outgoingError;if(!f.outgoing)throw notFound();return clone(f.outgoing);
    }
    async listTransactions(params){f.calls.list++;if(f.listError)throw f.listError;return f.listResponse?.(params)??{transactions:[],total_count:0};}
    async cancelHoldInvoice({payment_hash:h}) {
      assert.equal(h,hash);assert.ok(['cancelling','cancel_pending'].includes(f.row.wrapStatus));
      f.calls.cancel++;await f.onCancel?.();
      if(f.cancelMode==='not-found')throw notFound();
      if(f.cancelMode==='error')throw Object.assign(Error('timeout'),{code:'TIMEOUT'});
      if(f.cancelMode==='terminal')f.hold={...f.hold,state:'expired'};
      return {};
    }
  }
  const nwc={PLATFORM_NWC_URL:'fixture.invalid',relayInCooldown:()=>f.cooldown,
    lookupInvoice:async h=>new Wallet().lookupInvoice({payment_hash:h}),
    payInvoice:async()=>{f.calls.pay++;throw Error('FORBIDDEN PAYMENT');},
    settleHoldInvoice:async()=>{f.calls.settle++;throw Error('FORBIDDEN SETTLEMENT');},
    cancelHoldInvoice:async h=>new Wallet().cancelHoldInvoice({payment_hash:h}),
    paymentHashFromPreimage:p=>createHash('sha256').update(Buffer.from(p,'hex')).digest('hex')};
  const logs={recordPaymentEvent:e=>f.events.push(e)};
  const logger={info(){},warn(){},error(){},debug(){}};
  const cache={};
  const load=name=>{
    if(cache[name])return cache[name];
    const module={exports:{}};cache[name]=module.exports;
    const require=path=>{
      if(path==='node:crypto'||path==='crypto')return crypto;
      if(path==='@getalby/sdk')return {NWCClient:Wallet};
      if(path==='drizzle-orm')return predicates;
      if(path.endsWith('/db/index.js'))return {db,pool,pendingInvoicesTable:table,transactionsTable:table};
      if(path.endsWith('/holdWrap.js'))return load('money/holdWrap');
      if(path.endsWith('/invoiceMonitor.js'))return load('money/invoiceMonitor');
      if(path.endsWith('/nwc.js'))return nwc;
      if(path.endsWith('/paymentLog.js'))return logs;
      if(path.endsWith('/logger.js'))return {logger};
      if(path.endsWith('/feeEngine.js'))return {finalizePendingSend:async()=>{throw Error('Forbidden send finalization');}};
      if(path.endsWith('/encrypt.js'))return {decrypt:()=>{throw Error('No credentials');}};
      if(path.endsWith('/events.js'))return {emitAccountEvent:()=>{}};
      if(path==='node-cron'||path.endsWith('/lnAddress.js')||path.endsWith('/shopOrderAutoSettle.js'))return {};
      throw Error(`Forbidden dependency: ${path}`);
    };
    vm.runInNewContext(`(function(require,module,exports){${sources[name]}\n})`,
      {Buffer,console,setTimeout,clearTimeout,setInterval,clearInterval}, {filename:name+'.ts'})(require,module,module.exports);
    return module.exports;
  };
  f.restart=()=>{for(const name of Object.keys(cache))delete cache[name];f.api=load('ric-reconcile');f.wrap=load('money/holdWrap');f.monitor=load('money/invoiceMonitor');};
  f.restart();return f;
}
const cancel=f=>f.api.cancelRicInvoice(account,hash);
const reconcile=f=>f.api.reconcileRicInvoiceNow(hash);
function noMoney(f){assert.equal(f.calls.pay,0);assert.equal(f.calls.settle,0);assert.equal(f.calls.ledger,0);}
function closed(result){assert.equal(result.status,'cancelled');assert.equal(result.dispatched,false);assert.equal(result.cleanupPending,true);}
function uncertain(result){assert.notEqual(result.status,'cancelled');assert.notEqual(result.dispatched,false);}

test('pending hold + exact NOT_FOUND becomes durable checkout abort, not terminal wallet ledger',async()=>{
  const f=fixture();closed(await cancel(f));assert.equal(f.row.wrapStatus,'cancel_pending');
  assert.equal(f.hold.state,'pending');assert.equal(f.row.paidAt,null);noMoney(f);
  assert.ok(f.sql.some(s=>s.includes("wrap_status='cancelling'")));
  assert.equal(f.events.filter(e=>e.event==='wrap.expired_reconciled').length,0);
});
test('fresh module instance and DB read retain tombstone without wallet availability',async()=>{
  const f=fixture();closed(await cancel(f));f.restart();f.lookupError=Error('offline');
  closed(f.api.ricInvoiceView(clone(f.row)));closed(await reconcile(f));
  f.cooldown=true;closed(await cancel(f));assert.equal(f.row.wrapStatus,'cancel_pending');noMoney(f);
});
test('late accepted tombstone retries cancellation, never revival; terminal proof finishes cleanup',async()=>{
  const f=fixture({row:{wrapStatus:'cancel_pending'}});f.hold.state='accepted';
  f.cancelMode='ack';closed(await reconcile(f));assert.equal(f.calls.cancel,1);
  assert.equal(f.row.wrapStatus,'cancel_pending');f.restart();f.cancelMode='terminal';
  assert.equal((await reconcile(f)).status,'cancelled');assert.equal(f.calls.cancel,2);
  assert.equal(f.row.wrapStatus,'cancelled');assert.equal(f.api.ricInvoiceView(f.row).cleanupPending,undefined);noMoney(f);
});
test('accepted while still cancelling is cancelled, never revived to created',async()=>{
  const f=fixture({row:{wrapStatus:'cancelling'},cancelMode:'ack'});f.hold.state='accepted';
  uncertain(await reconcile(f));assert.equal(f.row.wrapStatus,'cancelling');assert.equal(f.calls.cancel,1);
  f.cancelMode='terminal';assert.equal((await reconcile(f)).status,'cancelled');noMoney(f);
});
test('background sweep selects old tombstones and cancels late accepted HTLC',async()=>{
  const f=fixture({row:{wrapStatus:'cancel_pending'},cancelMode:'terminal'});f.hold.state='accepted';
  const stop=f.api.startRicReconciler();
  try{for(let n=0;n<30&&f.row.wrapStatus!=='cancelled';n++)await new Promise(r=>setImmediate(r));
    assert.equal(f.calls.cancel,1);assert.equal(f.row.wrapStatus,'cancelled');noMoney(f);
  }finally{stop();}
});
for(const state of ['pending','accepted','mystery','settled'])test(`outgoing ${state} forbids checkout cancellation`,async()=>{
  const f=fixture({outgoing:{type:'outgoing',payment_hash:merchant,state}});
  uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'cancelling');assert.equal(f.calls.cancel,0);noMoney(f);
});
for(const scenario of ['incomplete','duplicate','changing-total','list-error','outgoing-error','mismatch-outgoing'])test(`${scenario} evidence fails closed`,async()=>{
  const f=fixture();
  const entry={type:'outgoing',payment_hash:'33'.repeat(32),state:'failed'};
  if(scenario==='incomplete')f.listResponse=()=>({transactions:[],total_count:1});
  if(scenario==='duplicate')f.listResponse=()=>({transactions:[entry],total_count:2});
  if(scenario==='changing-total')f.listResponse=({offset})=>({transactions:offset?[]:[entry],total_count:offset?3:2});
  if(scenario==='list-error')f.listError=Error('offline');
  if(scenario==='outgoing-error')f.outgoingError=Error('offline');
  if(scenario==='mismatch-outgoing')f.outgoing={type:'outgoing',payment_hash:'44'.repeat(32),state:'failed'};
  uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'cancelling');assert.equal(f.calls.cancel,0);noMoney(f);
});
for(const scenario of ['missing','mismatch','outgoing-type','unknown','settled','timestamp','preimage','lookup-error'])test(`incoming ${scenario} never falsely cancelled`,async()=>{
  const f=fixture();
  if(scenario==='missing')f.hold=undefined;
  if(scenario==='mismatch')f.hold.payment_hash='44'.repeat(32);
  if(scenario==='outgoing-type')f.hold.type='outgoing';
  if(scenario==='unknown')f.hold.state='mystery';
  if(scenario==='settled')f.hold.state='settled';
  if(scenario==='timestamp')f.hold.settled_at=123;
  if(scenario==='preimage')f.hold.preimage=preimage;
  if(scenario==='lookup-error')f.lookupError=Error('offline');
  uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'cancelling');assert.equal(f.calls.cancel,0);noMoney(f);
});
for(const scenario of ['missing','mismatch','same-merchant-hash','invalid-merchant-hash'])test(`unproven hold binding ${scenario} forbids tombstone`,async()=>{
  const f=fixture();
  if(scenario==='missing')f.row.holdPreimage=null;
  if(scenario==='mismatch')f.row.holdPreimage='55'.repeat(32);
  if(scenario==='same-merchant-hash')f.row.merchantPaymentHash=hash;
  if(scenario==='invalid-merchant-hash')f.row.merchantPaymentHash='bad';
  uncertain(await cancel(f));assert.notEqual(f.row.wrapStatus,'cancel_pending');noMoney(f);
});
for(const mode of ['ack','error'])test(`wallet ${mode} with still-pending hold is not tombstone proof`,async()=>{
  const f=fixture({cancelMode:mode});uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'cancelling');noMoney(f);
});
for(const after of ['missing','mismatch','accepted','paid','read-error'])test(`NOT_FOUND readback ${after} is not pending-hold proof`,async()=>{
  const f=fixture({onCancel:()=>{
    if(after==='missing')f.hold=undefined;
    if(after==='mismatch')f.hold.payment_hash='44'.repeat(32);
    if(after==='accepted')f.hold.state='accepted';
    if(after==='paid')f.hold.settled_at=123;
    if(after==='read-error')f.lookupError=Error('offline');
  }});
  uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'cancelling');noMoney(f);
});
for(const target of ['cancelling','cancel_pending'])test(`failed ${target} CAS cannot manufacture cancellation`,async()=>{
  const f=fixture({failCas:to=>to===target});uncertain(await cancel(f));
  assert.notEqual(f.row.wrapStatus,'cancel_pending');noMoney(f);
});
test('paid_at racing tombstone CAS always wins',async()=>{
  const f=fixture({beforeSql:sql=>{if(sql.startsWith("UPDATE pending_invoices SET wrap_status='cancel_pending'"))f.row.paidAt=new Date();}});
  assert.equal((await cancel(f)).status,'paid');assert.equal(f.row.wrapStatus,'cancelling');noMoney(f);
});
test('outgoing liability appears during cancellation: no terminalization or tombstone',async()=>{
  const f=fixture({onCancel:()=>{f.outgoing={type:'outgoing',payment_hash:merchant,state:'pending'};}});
  uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'cancelling');noMoney(f);
});
test('failed outgoing with paid evidence remains liability',async()=>{
  const f=fixture({outgoing:{type:'outgoing',payment_hash:merchant,state:'failed',settled_at:123}});
  uncertain(await cancel(f));assert.equal(f.calls.cancel,0);noMoney(f);
});
test('definitively failed unpaid outgoing permits tombstone',async()=>{
  const f=fixture({outgoing:{type:'outgoing',payment_hash:merchant,state:'failed'}});
  closed(await cancel(f));noMoney(f);
});
test('terminal wallet readback after NOT_FOUND closes only terminal ledger',async()=>{
  const f=fixture({onCancel:()=>{f.hold.state='expired';}});
  assert.equal((await cancel(f)).status,'cancelled');assert.equal(f.row.wrapStatus,'cancelled');noMoney(f);
});
test('paid row and wrong owner never cancel',async()=>{
  const f=fixture({row:{paidAt:new Date(),wrapStatus:'cancel_pending'}});
  assert.equal((await f.api.cancelRicInvoice('other',hash)).status,'not_found');
  assert.equal((await cancel(f)).status,'paid');assert.equal(f.calls.cancel,0);noMoney(f);
});
for(const state of ['cancelling','cancel_pending','cancelled'])test(`actual wrap engine and notification entry point cannot advance ${state}`,async()=>{
  const f=fixture({row:{wrapStatus:state}});f.hold.state='accepted';
  assert.equal(await f.wrap.advanceWrap(clone(f.row)),state);
  assert.equal(await f.monitor.settleInvoiceByPaymentHash(hash,new Date()),false);
  await new Promise(r=>setImmediate(r));assert.equal(f.row.wrapStatus,state);noMoney(f);
});
for(const stale of ['created','accepted'])test(`stale ${stale} advance loses CAS to tombstone; no pay or settle`,async()=>{
  const f=fixture({row:{wrapStatus:'cancel_pending'}});f.hold.state='accepted';
  await f.wrap.advanceWrap({...clone(f.row),wrapStatus:stale});
  assert.equal(f.row.wrapStatus,'cancel_pending');noMoney(f);
});
test('concurrent created advance loses to cancellation claim before wallet read returns',async()=>{
  const f=fixture();let resume,entered;
  const started=new Promise(r=>entered=r),gate=new Promise(r=>resume=r);
  f.beforeHoldLookup=async()=>{if(f.calls.holdLookup===1){entered();await gate;}};
  const advance=f.wrap.advanceWrap(clone(f.row));await started;
  closed(await cancel(f));f.hold.state='accepted';resume();await advance;
  assert.equal(f.row.wrapStatus,'cancel_pending');noMoney(f);
});
test('acceptance CAS winning before cancel preserves forward ownership',async()=>{
  const f=fixture({beforeSql:sql=>{if(sql.includes("SET wrap_status='cancelling'"))f.row.wrapStatus='accepted';}});
  // Pending wallet observation stops actual forward here; cancellation cannot
  // overwrite the winner's accepted state or present a cancelled checkout.
  f.outgoingError=Error('offline');f.hold.state='mystery';
  // Avoid advancing this already-owned row: simulate unavailable relay.
  f.cooldown=true;uncertain(await cancel(f));assert.equal(f.row.wrapStatus,'accepted');noMoney(f);
});
for(const state of ['settled','pending','unknown'])test(`tombstone with newly observed ${state} liability is retained, never wallet-cancelled`,async()=>{
  const f=fixture({row:{wrapStatus:'cancel_pending'},outgoing:{type:'outgoing',payment_hash:merchant,state}});f.hold.state='accepted';
  uncertain(await reconcile(f));assert.equal(f.row.wrapStatus,'cancel_pending');assert.equal(f.calls.cancel,0);noMoney(f);
});
test('tombstone paid incoming is not reported as cancelled by live reconciliation',async()=>{
  const f=fixture({row:{wrapStatus:'cancel_pending'}});f.hold.state='settled';
  uncertain(await reconcile(f));assert.equal(f.calls.cancel,0);noMoney(f);
});
test('known paid incoming wins even when outgoing evidence lookup fails',async()=>{
  const f=fixture({row:{wrapStatus:'cancel_pending'},outgoingError:Error('offline')});f.hold.state='settled';
  uncertain(await reconcile(f));assert.equal(f.calls.cancel,0);noMoney(f);
});
