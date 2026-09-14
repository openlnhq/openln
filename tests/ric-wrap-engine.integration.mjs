import test,{mock,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import pg from 'pg';
import {invoiceFixture} from './helpers/ric-wallet.mjs';
const u=new URL(process.env.DATABASE_URL||'');if(!['127.0.0.1','localhost'].includes(u.hostname)||!u.pathname.startsWith('/openln_qa_'))throw Error('Local scratch DB only');
const platform='nostr+walletconnect://'+'1'.repeat(64)+'?relay=wss://fixture.invalid&secret='+'2'.repeat(64);process.env.ALBY_NWC_URL=platform;
const incoming=new Map(),outgoing=new Map();let pays=0,cancels=0,settles=0,invoice;
class Wallet {
 constructor(){}close(){}async getWalletServiceInfo(){return {capabilities:['pay_invoice','lookup_invoice','settle_hold_invoice'],encryptions:['nip04'],notifications:[]};}
 async lookupInvoice({payment_hash}){const v=incoming.get(payment_hash)||outgoing.get(payment_hash);if(!v)throw Object.assign(Error('Not found'),{code:'NOT_FOUND'});return v;}
 async listTransactions({offset=0}){const rows=[...outgoing.values()];return {transactions:rows.slice(offset,offset+50),total_count:rows.length};}
 async payInvoice({invoice:bolt}){assert.equal(bolt,invoice.invoice);pays++;outgoing.set(invoice.payment_hash,{type:'outgoing',payment_hash:invoice.payment_hash,state:'settled',preimage:invoice.preimage,settled_at:Math.floor(Date.now()/1000)});return {preimage:invoice.preimage,fees_paid:0};}
 async settleHoldInvoice({preimage}){settles++;const hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');incoming.set(hash,{type:'incoming',payment_hash:hash,state:'settled',preimage,settled_at:Math.floor(Date.now()/1000)});return {};}
 async cancelHoldInvoice(){cancels++;throw Error('Must not cancel held funds in this test');}
}
mock.module('@getalby/sdk',{namedExports:{NWCClient:Wallet}});
const {reconcileRicInvoiceNow,cancelRicInvoice}=await import('../dist/core/ric-reconcile.js');const {pool}=await import('../dist/core/db/index.js');const sql=new pg.Client({connectionString:process.env.DATABASE_URL});let account;
before(async()=>{await sql.connect();const eid=randomUUID();account=randomUUID();await sql.query("INSERT INTO entities(id,handle,pin_hash) VALUES($1,$2,'password-login')",[eid,'qa_wrap_'+eid]);await sql.query('INSERT INTO accounts(id,entity_id) VALUES($1,$2)',[account,eid]);});
after(async()=>{await sql.end();await pool.end();});
async function seed(){invoice=await invoiceFixture(98);const preimage=createHash('sha256').update(randomUUID()).digest('hex'),hash=createHash('sha256').update(Buffer.from(preimage,'hex')).digest('hex');await sql.query("INSERT INTO pending_invoices(account_id,payment_hash,bolt11,amount_sats,fee_sats,wrap_status,hold_preimage,merchant_payment_hash,merchant_bolt11,expires_at,wrap_updated_at) VALUES($1,$2,'offline-hold',100,2,'created',$3,$4,$5,now()+interval '15 minutes',now())",[account,hash,preimage,invoice.payment_hash,invoice.invoice]);incoming.set(hash,{type:'incoming',payment_hash:hash,state:'accepted',amount:100000});return hash;}
test('real bitPOS engine with concurrent reconcile callers forwards once then captures hold and records exactly one receive',async()=>{const hash=await seed();const results=await Promise.all(Array.from({length:12},()=>reconcileRicInvoiceNow(hash)));assert.ok(results.every(x=>x.status==='paid'));assert.equal(pays,1);assert.equal(settles,1);assert.equal(cancels,0);const tx=await sql.query("SELECT amount_sats,fee_sats FROM transactions WHERE account_id=$1 AND payment_hash=$2 AND direction='in'",[account,hash]);assert.equal(tx.rows.length,1);assert.equal(Number(tx.rows[0].amount_sats),98);assert.equal(Number(tx.rows[0].fee_sats),2);});
test('cancel racing a held customer payment does not cancel funds and still permits one safe forward',async()=>{const hash=await seed();const before=pays;const r=await cancelRicInvoice(account,hash);assert.equal(r.status,'pending');await reconcileRicInvoiceNow(hash);assert.equal(pays,before+1);assert.equal(cancels,0);assert.equal((await sql.query('SELECT wrap_status FROM pending_invoices WHERE payment_hash=$1',[hash])).rows[0].wrap_status,'settled');});
