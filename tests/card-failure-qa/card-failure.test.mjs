import test, {before, after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import {SourceTextModule, SyntheticModule, createContext} from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {drizzle} from 'drizzle-orm/pglite';
import * as orm from 'drizzle-orm';
import {pgTable, uuid, text, integer, timestamp} from 'drizzle-orm/pg-core';

// Entire PostgreSQL database is ephemeral WASM memory; no production connection.
const pg = new PGlite();
const cardsTable=pgTable('cards',{id:uuid().primaryKey(),accountId:uuid('account_id'),status:text(),name:text(),note:text(),pendingK1:text('pending_k1'),pendingK1ExpiresAt:timestamp('pending_k1_expires_at',{withTimezone:true}),perTapLimitSats:integer('per_tap_limit_sats'),dailyLimitSats:integer('daily_limit_sats'),pinHash:text('pin_hash'),pinLimitMsats:integer('pin_limit_msats'),counter:integer(),pinLockedAt:timestamp('pin_locked_at',{withTimezone:true}),pinFailCount:integer('pin_fail_count')});
const transactionsTable=pgTable('transactions',{id:uuid().defaultRandom().primaryKey(),accountId:uuid('account_id'),direction:text(),type:text(),amountSats:integer('amount_sats'),feeSats:integer('fee_sats'),counterpartLnAddress:text('counterpart_ln_address'),bolt11:text(),paymentHash:text('payment_hash'),status:text(),memo:text(),cardId:uuid('card_id'),failureReason:text('failure_reason'),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow()});
const pendingInvoicesTable=pgTable('pending_invoices',{id:uuid().defaultRandom().primaryKey(),accountId:uuid('account_id'),paymentHash:text('payment_hash'),bolt11:text(),wrapStatus:text('wrap_status'),paidAt:timestamp('paid_at',{withTimezone:true}),createdAt:timestamp('created_at',{withTimezone:true}).defaultNow()});
const db=drizzle(pg);const query=(sql,params)=>pg.query(sql,params);
const pool={query,connect:async()=>({query,release(){}})};
const card='11111111-1111-4111-8111-111111111111', holder='22222222-2222-4222-8222-222222222222', merchant='33333333-3333-4333-8333-333333333333';
const hash='a'.repeat(64), k1='b'.repeat(64), invoice='ln-fixture-'+hash;
const logger={info(){},warn(){},error(){}};
let pay,settlements=0,actual;
const context=createContext({console,Buffer,URL,Date,Error,Promise,setTimeout:(fn,ms,...args)=>{const timer=setTimeout(fn,ms,...args);timer.unref=()=>timer;return timer;},clearTimeout});
const modules=new Map();
async function synthetic(key,exports){if(modules.has(key))return modules.get(key);const mod=new SyntheticModule(Object.keys(exports),function(){for(const [key,value] of Object.entries(exports))this.setExport(key,value);},{context});modules.set(key,mod);return mod;}
async function readSource(name){const paths={server:'core/server', 'card-tap':'plugins/card-tap', 'ric-card-claim':'plugins/ric-card-claim', feeEngine:'core/money/feeEngine', 'ric-reconcile':'core/ric-reconcile'};try{return await readFile(new URL('../../'+paths[name]+'.ts',import.meta.url),'utf8');}catch(err){if(err.code!=='ENOENT')throw err;return readFile(new URL('../../'+name+'.ts',import.meta.url),'utf8');}}
async function source(name){if(modules.has(name))return modules.get(name);const code=stripTypeScriptTypes(await readSource(name));const mod=new SourceTextModule(code,{context,identifier:name});modules.set(name,mod);await mod.link(async spec=>{
 if(spec==='drizzle-orm')return synthetic(spec,orm);
 if(spec.endsWith('/db/index.js'))return synthetic('db',{db,pool,cardsTable,transactionsTable,pendingInvoicesTable});
 if(spec.endsWith('/logger.js'))return synthetic('logger',{logger});
 if(spec.endsWith('/nwc.js'))return synthetic('nwc',{getAccountNwcUrl:async()=> 'offline-wallet',payInvoice:async(...args)=>pay(...args),isAmbiguousPayError:err=>/reply timeout|publish timeout|timeout waiting for|no response from wallet/i.test(err.message),PLATFORM_NWC_URL:'',makeInvoice(){throw Error('unexpected mint')},lookupInvoice(){throw Error('unexpected lookup')},lookupOutgoingPayment(){throw Error('unexpected lookup')}});
 if(spec.endsWith('/paymentLog.js'))return synthetic('paymentLog',{recordPaymentEvent(){}});
 if(spec.endsWith('/lnAddress.js'))return synthetic('lnAddress',{extractPaymentHash:pr=>pr===invoice?hash:'d'.repeat(64)});
 if(spec.endsWith('/holdWrap.js'))return synthetic('holdWrap',{advanceWrap(){throw Error('unexpected forwarding')}});
 if(spec.endsWith('/feeEngine.js')){const real=await source('feeEngine');await real.evaluate();return synthetic('feeExport',{...real.namespace,resolveAmbiguousPayment:async()=>({status:'pending'})});}
 if(spec.endsWith('/invoiceMonitor.js'))return synthetic('monitor',{settleInvoiceByPaymentHash:async()=>{settlements++;}});
 if(spec.endsWith('/card-pin.js'))return synthetic('pin',{verifyCardPin:async()=>true});
 if(spec.endsWith('/boltcard.js'))return synthetic('boltcard',{parseBolt11AmountSats:()=>100,decryptSunP(){},verifySunC(){},generateK1(){}});
 if(spec.endsWith('/encrypt.js'))return synthetic('encrypt',{decrypt:x=>x});
 if(spec.endsWith('/domain.js'))return synthetic('domain',{DOMAIN:'offline.invalid'});
 if(spec==='./ric-card-claim.js')return source('ric-card-claim');
 throw Error('Unmocked dependency '+spec);
 });return mod;}
async function reset(){await pg.exec('TRUNCATE cards, transactions, pending_invoices, ric_card_claims');await query("INSERT INTO cards VALUES($1,$2,'active',null,null,$3,now()+interval '10 minutes',10000,100000,null,null,1,null,0)",[card,holder,k1]);await query("INSERT INTO pending_invoices(account_id,payment_hash,bolt11,wrap_status) VALUES($1,$2,$3,'created')",[merchant,hash,invoice]);settlements=0;pay=async()=>{throw Error('Insufficient balance')};}
async function callback(){let result;const req={method:'GET'};const res={writeHead(){},end(v){result=JSON.parse(v)}};await actual.handleCardTapRoute(req,res,new URL('https://offline.invalid/card/'+card+'/callback?'+new URLSearchParams({k1,pr:invoice})));return result;}
async function poll(){assert.equal(typeof actual.getRicCardFailure,'function','durable failure status hook must exist');return actual.getRicCardFailure(merchant,hash);}
async function eventually(fn){for(let n=0;n<100;n++){const x=await fn();if(x)return x;await new Promise(r=>setTimeout(r,5));}assert.fail('background work did not finalize');}
const typed={status:'ERROR',code:'INSUFFICIENT_BALANCE',paymentFailed:true,dispatched:true,k1,reason:'Insufficient balance'};
before(async()=>{await pg.exec(`CREATE TABLE cards(id uuid PRIMARY KEY,account_id uuid,status text,name text,note text,pending_k1 text,pending_k1_expires_at timestamptz,per_tap_limit_sats int,daily_limit_sats int,pin_hash text,pin_limit_msats int,counter int,pin_locked_at timestamptz,pin_fail_count int);
 CREATE TABLE transactions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,direction text,type text,amount_sats int,fee_sats int,counterpart_ln_address text,bolt11 text,payment_hash text,status text,memo text,card_id uuid,failure_reason text,created_at timestamptz DEFAULT now());
 CREATE TABLE pending_invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),account_id uuid,payment_hash text UNIQUE,bolt11 text,wrap_status text,paid_at timestamptz,created_at timestamptz DEFAULT now());
 CREATE TABLE ric_card_claims(card_id uuid PRIMARY KEY,account_id uuid,payment_hash text,amount_sats int,created_at timestamptz DEFAULT now());`);const mod=await source('card-tap');await mod.evaluate();actual=mod.namespace;});
after(()=>pg.close());
test('actual callback + feeEngine: authoritative insufficient balance has typed k1-bound dispatched failure',async()=>{await reset();assert.deepEqual(await callback(),typed);assert.equal((await query('SELECT status FROM transactions')).rows[0].status,'failed');assert.equal(settlements,0);});
test('deadline OK followed by late rejection remains durably observable without response delivery',async()=>{await reset();let reject;pay=()=>new Promise((_,r)=>{reject=r});assert.deepEqual(await callback(),{status:'OK'});assert.equal(await poll(),undefined);reject(Error('Insufficient balance'));await eventually(async()=>(await query('SELECT status FROM transactions')).rows[0]?.status==='failed');const view=await poll();assert.equal(view.status,'card_failed');assert.equal(view.paymentHash,hash);assert.equal(view.code,'INSUFFICIENT_BALANCE');assert.equal(view.paymentFailed,true);assert.equal(view.dispatched,true);assert.equal(settlements,0);});
test('lost immediate response is recoverable from the persisted transaction alone',async()=>{await reset();await callback();assert.equal((await poll()).status,'card_failed');assert.equal(await actual.getRicCardFailure(holder,hash),undefined);assert.equal(await actual.getRicCardFailure(merchant,'c'.repeat(64)),undefined);});
test('ambiguous reply timeout remains OK and pending with no failure proof',async()=>{await reset();pay=async()=>{throw Error('reply timeout: insufficient balance not confirmed')};assert.deepEqual(await callback(),{status:'OK'});assert.equal((await query('SELECT status FROM transactions')).rows[0].status,'pending');assert.equal(await poll(),undefined);});
test('arbitrary insufficient-related messages or timeouts are not typed',async()=>{for(const err of [Error('insufficient information from wallet'),Error('timeout')]){await reset();pay=async()=>{throw err};const result=await callback();assert.equal(result.paymentFailed,undefined);assert.equal(await poll(),undefined);}});
test('settlement winning CAS defeats a late definitive-looking rejection',async()=>{await reset();pay=async()=>{await query("UPDATE transactions SET status='completed'");throw Error('Insufficient balance')};assert.equal((await callback()).paymentFailed,undefined);assert.equal(await poll(),undefined);});
test('failure finalization DB error cannot mint a failure proof',async()=>{await reset();pay=async()=>{await pg.exec(`CREATE FUNCTION reject_failed() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.status='failed' THEN RAISE EXCEPTION 'offline injected storage failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_failed BEFORE UPDATE ON transactions FOR EACH ROW EXECUTE FUNCTION reject_failed();`);throw Error('Insufficient balance')};try{assert.equal((await callback()).paymentFailed,undefined);assert.equal(await poll(),undefined);}finally{await pg.exec('DROP TRIGGER reject_failed ON transactions; DROP FUNCTION reject_failed()');}});
test('paid, accepted, forwarding, forwarded, reconciliation, and cancelled precedence survives stale failed row',async()=>{for(const state of ['settled','accepted','forwarding','forwarded','needs_reconciliation','cancelled','cancel_pending']){await reset();await callback();await query('UPDATE pending_invoices SET wrap_status=$1',[state]);assert.equal(await poll(),undefined,state);}await reset();await callback();await query('UPDATE pending_invoices SET paid_at=now()');assert.equal(await poll(),undefined);});
test('another outgoing attempt (failed, pending or completed) prevents reusing historical failure',async()=>{for(const state of ['failed','pending','completed']){await reset();await callback();await query("INSERT INTO transactions(account_id,payment_hash,bolt11,card_id,direction,type,status,failure_reason) VALUES($1,$2,$3,$4,'out','send',$5,'Insufficient balance')",[holder,hash,invoice,card,state]);assert.equal(await poll(),undefined,state);}});
test('a new durable claim before its transaction insertion suppresses old failure',async()=>{await reset();await callback();await query("UPDATE ric_card_claims SET created_at=(SELECT created_at+interval '1 second' FROM transactions LIMIT 1)");assert.equal(await poll(),undefined);});
test('hash collision/mismatched invoice and pre-invoice historical transaction never prove failure',async()=>{await reset();await callback();await query("UPDATE pending_invoices SET bolt11='different invoice'");assert.equal(await poll(),undefined);await query("UPDATE pending_invoices SET bolt11=$1,created_at=now()+interval '1 second'",[invoice]);assert.equal(await poll(),undefined);});
test('successful payment preserves OK and fast-path settlement',async()=>{await reset();pay=async()=>({paymentHash:hash,feesPaidSats:0});assert.deepEqual(await callback(),{status:'OK'});assert.equal(settlements,1);assert.equal(await poll(),undefined);});

test('fresh callback module recovers failure without any in-memory callback or event state',async()=>{await reset();await callback();modules.delete('card-tap');const fresh=await source('card-tap');await fresh.evaluate();actual=fresh.namespace;assert.equal((await poll()).status,'card_failed');});
test('late successful payment cannot become a balance failure',async()=>{await reset();let resolve;pay=()=>new Promise(r=>{resolve=r});assert.deepEqual(await callback(),{status:'OK'});assert.equal(await poll(),undefined);resolve({paymentHash:hash,feesPaidSats:0});await eventually(async()=>(await query('SELECT status FROM transactions')).rows[0]?.status==='completed');assert.equal(await poll(),undefined);});
test('proof read failure fails closed and preserves pending recovery',async()=>{await reset();await callback();const original=pool.query;pool.query=async()=>{throw Error('offline read failure')};try{assert.equal(await poll(),undefined);}finally{pool.query=original;}});

test('actual server status block enforces auth/ownership, exposes durable error, and preserves terminal/forward views',async()=>{
 await reset();await callback();
 // Execute the production route and production view, not a regex assertion or
 // a reimplementation. Other server routes/listeners never run in this fixture.
 const server=stripTypeScriptTypes(await readSource('server'));const begin=server.indexOf('    const posStatus =');const end=server.indexOf('    // LNURL-pay endpoints',begin);assert.ok(begin>=0&&end>begin);
 const reconcile=await readSource('ric-reconcile');const a=reconcile.indexOf('export function ricInvoiceView('),b=reconcile.indexOf('\nasync function markCancelled',a);assert.ok(a>=0&&b>a);
 const pendingLine=reconcile.split('\n').find(line=>line.startsWith('const pending ='));
 const viewCode=stripTypeScriptTypes(pendingLine+'\n'+reconcile.slice(a,b).replace('export function','function'));
 const view=Function('directExpired',viewCode+'\nreturn ricInvoiceView;')(new Set());
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const route=new AsyncFunction('req','res','u','currentAccount','db','pendingInvoicesTable','eq','enqueueRicInvoice','ricInvoiceView','getRicCardFailure','json',server.slice(begin,end));
 async function request(owner){let out;await route({method:'GET'},{},new URL('https://offline.invalid/api/pos/invoice/'+hash+'/status'),owner&&{id:owner},db,pendingInvoicesTable,orm.eq,()=>{},view,actual.getRicCardFailure,(_res,code,body)=>{out={code,body:JSON.parse(JSON.stringify(body))}});return out;}
 assert.equal((await request(null)).code,401);assert.equal((await request(holder)).code,404);
 const failed=await request(merchant);assert.equal(failed.code,200);assert.deepEqual(failed.body,{status:'card_failed',paymentHash:hash,code:'INSUFFICIENT_BALANCE',paymentFailed:true,dispatched:true,reason:'Insufficient balance',feeSats:0});
 for(const [state,expected] of [['accepted','accepted'],['forwarding','forwarding'],['forwarded','forwarded'],['settled','paid'],['cancelled','cancelled'],['cancel_pending','cancelled']]){await query('UPDATE pending_invoices SET wrap_status=$1',[state]);const r=await request(merchant);assert.equal(r.body.status,expected);assert.equal(r.body.paymentFailed,undefined);}
});
