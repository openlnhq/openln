import test,{mock,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes,createHash} from 'node:crypto';
import pg from 'pg';
const u=new URL(process.env.DATABASE_URL||'');
if(!['localhost','127.0.0.1'].includes(u.hostname)||!u.pathname.startsWith('/openln_qa_'))throw Error('Local scratch database required');
let observations=0,db,pool,account,helper;
mock.module('../dist/core/ric-reconcile.js',{namedExports:{cancelRicInvoice:async(account,hash)=>{observations++;return {status:'pending',paymentHash:hash,doNotRetry:true};},enqueueRicInvoice:()=>{observations++;}}});
before(async()=>{db=new pg.Client({connectionString:process.env.DATABASE_URL});await db.connect();({pool}=await import('../dist/core/db/index.js'));const e=randomUUID();account=randomUUID();await db.query("INSERT INTO entities(id,handle,pin_hash)VALUES($1,$2,'password-login')",[e,'qa_admin_cancel_'+e]);await db.query('INSERT INTO accounts(id,entity_id)VALUES($1,$2)',[account,e]);try{helper=await import('../dist/core/admin/ricCancel.js');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}});
after(async()=>{await db?.end();await pool?.end();});
async function seed(state='created') {const id=randomUUID(),pre=randomBytes(32).toString('hex'),hash=createHash('sha256').update(Buffer.from(pre,'hex')).digest('hex'),merchant=randomBytes(32).toString('hex');await db.query("INSERT INTO pending_invoices(id,account_id,payment_hash,bolt11,amount_sats,expires_at,wrap_status,hold_preimage,merchant_payment_hash,merchant_bolt11)VALUES($1,$2,$3,'test invoice',39,now()+interval '15 minutes',$4,$5,$6,'test merchant invoice')",[id,account,hash,state,pre,merchant]);return {id,hash,merchant};}
const action={actor:'admin:kongzi',reason:'User requested cancellation of stuck checkout'};
test('manual operator cancellation releases created hold checkout without claiming wallet refund',async()=>{
 assert.equal(typeof helper?.adminCancelRicInvoice,'function','Treasury needs a real manual cancellation helper');
 const x=await seed();const out=await helper.adminCancelRicInvoice(account,x.hash,action);assert.equal(out.status,'cancelled');assert.equal(out.dispatched,false);assert.equal(out.cleanupPending,true);
 const r=(await db.query('SELECT wrap_status,paid_at FROM pending_invoices WHERE id=$1',[x.id])).rows[0];assert.equal(r.wrap_status,'cancel_pending');assert.equal(r.paid_at,null);
 const events=(await db.query("SELECT detail,event FROM payment_events WHERE payment_hash=$1 AND event='admin.cancel_requested'",[x.hash])).rows;assert.equal(events.length,1);assert.equal(events[0].detail.actor,action.actor);assert.equal(events[0].detail.reason,action.reason);
 const again=await helper.adminCancelRicInvoice(account,x.hash,action);assert.equal(again.status,'cancelled');assert.equal((await db.query("SELECT count(*)::int n FROM payment_events WHERE payment_hash=$1 AND event='admin.cancel_requested'",[x.hash])).rows[0].n,1);
});
for(const state of ['accepted','forwarding','forwarded','settled','needs_reconciliation'])test(`manual cancellation cannot erase ${state} money state`,async()=>{
 assert.ok(helper?.adminCancelRicInvoice);const x=await seed(state);const out=await helper.adminCancelRicInvoice(account,x.hash,action);assert.notEqual(out.status,'cancelled');assert.equal((await db.query('SELECT wrap_status FROM pending_invoices WHERE id=$1',[x.id])).rows[0].wrap_status,state);
});
test('wrong owner, settlement, outgoing liability, malformed hold and missing reason cannot release',async()=>{
 assert.ok(helper?.adminCancelRicInvoice);
 for(const scenario of ['owner','paid','outgoing','bad-hold','reason']){
 const x=await seed();if(scenario==='paid')await db.query('UPDATE pending_invoices SET paid_at=now() WHERE id=$1',[x.id]);
 if(scenario==='outgoing')await db.query("INSERT INTO transactions(account_id,direction,type,status,amount_sats,payment_hash)VALUES($1,'out','send','pending',38,$2)",[account,x.merchant]);
 if(scenario==='bad-hold')await db.query("UPDATE pending_invoices SET hold_preimage='bad' WHERE id=$1",[x.id]);
 const out=await helper.adminCancelRicInvoice(scenario==='owner'?randomUUID():account,x.hash,scenario==='reason'?{...action,reason:''}:action);
 assert.notEqual(out.status,'cancelled',scenario);assert.equal((await db.query('SELECT wrap_status FROM pending_invoices WHERE id=$1',[x.id])).rows[0].wrap_status,'created',scenario);
 }
});
