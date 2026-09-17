// Explicit operator checkout abort. This is not a payment-failure or refund claim.
import {createHash} from 'node:crypto';
import {pool} from '../db/index.js';
import {cancelRicInvoice, enqueueRicInvoice, type RicInvoiceResult} from '../ric-reconcile.js';

type Operator = {actor:string;reason:string};
export async function adminCancelRicInvoice(accountId:string,hash:string,operator:Operator):Promise<RicInvoiceResult> {
  const pending = ():RicInvoiceResult => ({status:'pending',paymentHash:hash,doNotRetry:true});
  if(!/^[0-9a-f]{64}$/.test(hash))return {status:'not_found',paymentHash:hash};
  if(!operator?.actor?.trim() || !operator?.reason?.trim() || operator.reason.length>500)return pending();
  const client=await pool.connect();let direct=false,aborted=false;
  try {
    await client.query('BEGIN');
    const row=(await client.query('SELECT * FROM pending_invoices WHERE account_id=$1 AND payment_hash=$2 FOR UPDATE',[accountId,hash])).rows[0];
    if(!row){await client.query('ROLLBACK');return {status:'not_found',paymentHash:hash};}
    if(row.paid_at || row.wrap_status==='settled') {await client.query('ROLLBACK');return {status:'paid',paymentHash:hash};}
    if(row.wrap_status==='cancelled' || row.ric_expiry_confirmed_at) {
      await client.query('ROLLBACK');return {status:row.wrap_status==='cancelled'?'cancelled':'expired',paymentHash:hash,dispatched:false};
    }
    if(row.wrap_status==='cancel_pending') {
      await client.query('ROLLBACK');return {status:'cancelled',paymentHash:hash,dispatched:false,cleanupPending:true};
    }
    if(!row.wrap_status) {
      direct=true;
      await client.query("INSERT INTO payment_events(payment_id,account_id,kind,event,status,payment_hash,message,detail) VALUES($1,$2,'admin','admin.cancel_requested','info',$3,'Operator requested direct-invoice cancellation; wallet proof is still required.',$4::jsonb)",[row.id,accountId,hash,JSON.stringify({actor:operator.actor,reason:operator.reason.trim(),before:null})]);
    } else {
      // All platform forwards claim accepted/forwarding in this same row first.
      // Holding this row lock and winning this CAS irrevocably disables forwarding.
      // Do not manufacture a terminal Lightning state: cleanup remains queued.
      const minted=typeof row.hold_preimage==='string' && /^[0-9a-f]{64}$/i.test(row.hold_preimage) && createHash('sha256').update(Buffer.from(row.hold_preimage,'hex')).digest('hex')===hash && /^[0-9a-f]{64}$/.test(row.merchant_payment_hash??'') && row.merchant_payment_hash!==hash;
      if(!minted || row.preimage || !['created','cancelling'].includes(row.wrap_status)) {await client.query('ROLLBACK');return pending();}
      const changed=await client.query("UPDATE pending_invoices i SET wrap_status='cancel_pending',wrap_updated_at=now() WHERE i.id=$1 AND i.account_id=$2 AND i.payment_hash=$3 AND i.paid_at IS NULL AND i.wrap_status IN ('created','cancelling') AND (i.preimage IS NULL OR i.preimage='') AND NOT EXISTS(SELECT 1 FROM transactions t WHERE t.payment_hash IN (i.payment_hash,i.merchant_payment_hash) AND t.direction='out' AND t.status<>'failed') RETURNING id",[row.id,accountId,hash]);
      if(!changed.rowCount){await client.query('ROLLBACK');return pending();}
      await client.query("INSERT INTO payment_events(payment_id,account_id,kind,event,status,payment_hash,message,detail) VALUES($1,$2,'admin','admin.cancel_requested','info',$3,'Operator cancelled the checkout and permanently disabled forwarding. Wallet hold cleanup remains pending; no refund is asserted.',$4::jsonb)",[row.id,accountId,hash,JSON.stringify({actor:operator.actor,reason:operator.reason.trim(),before:row.wrap_status,after:'cancel_pending',cleanupPending:true})]);
      aborted=true;
    }
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;}
  finally {client.release();}
  if(aborted) {enqueueRicInvoice(hash);return {status:'cancelled',paymentHash:hash,dispatched:false,cleanupPending:true};}
  return direct ? cancelRicInvoice(accountId,hash) : pending();
}
