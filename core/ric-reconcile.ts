// Runtime orchestration around the unchanged bitPOS money path.
// Network uncertainty is never permission to cancel, fail, or repeat a payment.
import { NWCClient } from '@getalby/sdk';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, pool, pendingInvoicesTable } from './db/index.js';
import { advanceWrap, type WrapRow } from './money/holdWrap.js';
import { settleInvoiceByPaymentHash } from './money/invoiceMonitor.js';
import { finalizePendingSend } from './money/feeEngine.js';
import { getAccountNwcUrl, PLATFORM_NWC_URL, relayInCooldown } from './money/nwc.js';
import { decrypt } from './money/encrypt.js';
import { emitAccountEvent } from './events.js';
import { logger } from './money/logger.js';

type Invoice = typeof pendingInvoicesTable.$inferSelect;
type Raw = {type?:string;state?:string;payment_hash?:string;preimage?:string;settled_at?:number;amount?:number;fees_paid?:number};
export type RicInvoiceResult = {status:string;paymentHash:string;dispatched?:boolean;doNotRetry?:boolean;cleanupPending?:boolean};
const directExpired = new Set<string>();
const validHash = (hash:string) => /^[0-9a-f]{64}$/.test(hash);
const pending = (hash:string):RicInvoiceResult => ({status:'pending',paymentHash:hash,doNotRetry:true});
function proofPaid(raw:Raw):boolean {
  const preimage = typeof raw.preimage==='string' && /^[0-9a-f]{64}$/i.test(raw.preimage) &&
    createHash('sha256').update(Buffer.from(raw.preimage,'hex')).digest('hex')===raw.payment_hash;
  return raw.state==='settled' || !!preimage || (typeof raw.settled_at==='number' && raw.settled_at>0);
}
function unpaidTerminal(raw:Raw):boolean { return !proofPaid(raw) && ['expired','cancelled','canceled','failed'].includes(raw.state??''); }
function incoming(raw:Raw,hash:string):boolean { return raw.type==='incoming' && raw.payment_hash===hash; }
// Bind the unsupported-cancel fallback to a hold we minted, not a direct or
// legacy same-hash invoice. The persisted preimage is never sent to the wallet.
function mintedHold(row:Invoice):boolean {
  return !!row.holdPreimage && /^[0-9a-f]{64}$/i.test(row.holdPreimage) &&
    createHash('sha256').update(Buffer.from(row.holdPreimage,'hex')).digest('hex')===row.paymentHash &&
    !!row.merchantPaymentHash && validHash(row.merchantPaymentHash) && row.merchantPaymentHash!==row.paymentHash;
}
function rememberDirectExpiry(hash:string) { if(directExpired.size>=1024)directExpired.delete(directExpired.values().next().value!);directExpired.add(hash); }
async function bounded<T>(client:NWCClient,work:()=>Promise<T>):Promise<T> {
  let timer:NodeJS.Timeout|undefined;
  try { return await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{client.close();reject(Error('Wallet observation timed out'));},12000);timer.unref();})]); }
  finally { if(timer)clearTimeout(timer); }
}
async function lookup(client:NWCClient,hash:string):Promise<Raw|undefined> {
  try { return await bounded(client,()=>client.lookupInvoice({payment_hash:hash})); }
  catch(err) { if((err as {code?:string}).code==='NOT_FOUND')return undefined;throw err; }
}
// Walk by ACTUAL received count, not requested page size. Some wallets cap 100
// to 50. Only a complete declared total or a subsequent empty page proves absence.
export async function outgoingEvidence(client:NWCClient,hash:string,from:number):Promise<{complete:boolean;match?:Raw}> {
  const direct=await lookup(client,hash);
  if(direct && direct.payment_hash!==hash)return {complete:false};
  if(direct?.type==='outgoing' && direct.payment_hash===hash)return {complete:true,match:direct};
  let offset=0;const seen=new Set<string>();let previousTotal:number|undefined;
  for(let page=0;page<20;page++) {
    const result=await bounded(client,()=>client.listTransactions({from,offset,limit:100,type:'outgoing',unpaid:true}));
    const entries=result.transactions as Raw[];
    if(!Array.isArray(entries))return {complete:false};
    const total=Number.isSafeInteger(result.total_count)&&result.total_count>=0?result.total_count:undefined;
    if(previousTotal!==undefined && total!==undefined && total!==previousTotal)return {complete:false};
    if(total!==undefined)previousTotal=total;
    if(entries.length===0)return {complete:total===undefined || offset===total};
    for(const row of entries) {
      if(row.type!=='outgoing' || !row.payment_hash || seen.has(row.payment_hash))return {complete:false};
      seen.add(row.payment_hash);
      if(row.payment_hash===hash)return {complete:true,match:row};
    }
    offset+=entries.length;
    if(total!==undefined && offset===total)return {complete:true};
    if(total!==undefined && offset>total)return {complete:false};
  }
  return {complete:false};
}
async function readInvoice(hash:string):Promise<Invoice|undefined> {
  return (await db.select().from(pendingInvoicesTable).where(eq(pendingInvoicesTable.paymentHash,hash)))[0];
}
export function ricInvoiceView(row:Invoice):RicInvoiceResult {
  const paymentHash=row.paymentHash;
  if(row.paidAt || row.wrapStatus==='settled')return {status:'paid',paymentHash};
  if(row.wrapStatus==='cancelled')return {status:'cancelled',paymentHash,dispatched:false};
  // Checkout is irrevocably aborted; the wallet invoice/HTLC is NOT terminal.
  // No forward can claim this state. Keep it in the cleanup sweep until proof.
  if(row.wrapStatus==='cancel_pending')return {status:'cancelled',paymentHash,dispatched:false,cleanupPending:true};
  if(!row.wrapStatus && directExpired.has(paymentHash))return {status:'expired',paymentHash,dispatched:false};
  if(['accepted','forwarding','forwarded'].includes(row.wrapStatus??''))return {status:row.wrapStatus!,paymentHash,dispatched:true,doNotRetry:true};
  return pending(paymentHash);
}
async function markCancelled(row:Invoice):Promise<void> {
  const r=await pool.query("UPDATE pending_invoices SET wrap_status='cancelled',wrap_updated_at=now() WHERE id=$1 AND paid_at IS NULL AND wrap_status IN ('created','cancelling','cancel_pending') RETURNING id",[row.id]);
  if(r.rowCount) {
    const {recordPaymentEvent}=await import('./money/paymentLog.js');
    recordPaymentEvent({paymentId:row.id,accountId:row.accountId,kind:'wrap',event:'wrap.expired_reconciled',status:'info',paymentHash:row.paymentHash,message:'Unpaid terminal hold confirmed; no outgoing liability. Checkout closed.'});
  }
}
async function inspectInvoice(hash:string):Promise<RicInvoiceResult> {
  const row=await readInvoice(hash);
  if(!row)return {status:'not_found',paymentHash:hash};
  const view=ricInvoiceView(row);
  if(['paid','cancelled','expired'].includes(view.status) && !view.cleanupPending)return view;
  const unknown=()=>view.cleanupPending?view:pending(hash);
  if(relayInCooldown())return unknown();
  const url=row.wrapStatus?PLATFORM_NWC_URL:(row.nwcUrlEncrypted?decrypt(row.nwcUrlEncrypted):undefined);
  if(!url)return unknown();
  const client=new NWCClient({nostrWalletConnectUrl:url});
  try {
    const hold=await lookup(client,hash);
    if(!hold || !incoming(hold,hash))return unknown();
    if(!row.wrapStatus) {
      if(proofPaid(hold))await settleInvoiceByPaymentHash(hash,new Date());
      else if(unpaidTerminal(hold))rememberDirectExpiry(hash);
      return ricInvoiceView((await readInvoice(hash))!);
    }
    const held=hold.state==='accepted' && !proofPaid(hold);
    if(row.wrapStatus==='created' && hold.state==='pending' && !proofPaid(hold))return pending(hash);
    const cancelling=row.wrapStatus==='cancelling' || row.wrapStatus==='cancel_pending';
    // Do not let a later outgoing-read failure hide known first-leg payment
    // behind the durable-checkout fallback. This anomaly needs reconciliation.
    if(cancelling && proofPaid(hold))return pending(hash);
    const needsOtherLeg=cancelling || unpaidTerminal(hold) || proofPaid(hold);
    let outgoing:{complete:boolean;match?:Raw}|undefined;
    if(needsOtherLeg) {
      if(!row.merchantPaymentHash)return pending(hash);
      outgoing=await outgoingEvidence(client,row.merchantPaymentHash,Math.floor(row.createdAt.getTime()/1000)-300);
      if(!outgoing.complete)return pending(hash);
    }
    const noLiability=outgoing?.complete && (!outgoing.match || (outgoing.match.state==='failed' && !proofPaid(outgoing.match)));
    if(cancelling) {
      // Cancellation ownership is permanent: even late acceptance must never
      // revive created/accepted or enter advanceWrap. Paid/liability wins.
      if(proofPaid(hold) || !noLiability)return pending(hash);
      if(unpaidTerminal(hold))await markCancelled(row);
      else if(held || hold.state==='pending') {
        let notFound=false;
        try {await bounded(client,()=>client.cancelHoldInvoice({payment_hash:hash}));}
        catch(err) {
          // Alby only cancels ACCEPTED holds. NOT_FOUND alone is never proof
          // of absence, refund, or even an unsupported pending cancellation.
          if((err as {code?:string})?.code!=='NOT_FOUND')throw err;
          notFound=true;
        }
        const after=await lookup(client,hash);
        if(!after || !incoming(after,hash))return unknown();
        if(proofPaid(after))return pending(hash);
        const unsupportedPending=row.wrapStatus==='cancelling' && hold.state==='pending' &&
          notFound && after.state==='pending' && mintedHold(row);
        if(unpaidTerminal(after) || unsupportedPending) {
          // Recheck after the wallet round trip; a newly visible outgoing
          // payment must not be hidden by our earlier complete history read.
          const latest=await outgoingEvidence(client,row.merchantPaymentHash!,Math.floor(row.createdAt.getTime()/1000)-300);
          if(!latest.complete || (latest.match && !(latest.match.state==='failed' && !proofPaid(latest.match))))return pending(hash);
          if(unpaidTerminal(after))await markCancelled(row);
          else {
            // Only the durable cancelling owner may become a tombstone. A
            // stale created/accepted advance loses its CAS before pay_invoice.
            const aborted=await pool.query("UPDATE pending_invoices SET wrap_status='cancel_pending',wrap_updated_at=now() WHERE id=$1 AND paid_at IS NULL AND wrap_status='cancelling' RETURNING id",[row.id]);
            if(aborted.rowCount) {
              const {recordPaymentEvent}=await import('./money/paymentLog.js');
              recordPaymentEvent({paymentId:row.id,accountId:row.accountId,kind:'wrap',event:'wrap.cancel_pending',status:'info',paymentHash:hash,message:'Checkout aborted; forwarding permanently disabled. Wallet hold cleanup pending.'});
            }
          }
        }
      }
      return ricInvoiceView((await readInvoice(hash))!);
    }
    if(row.wrapStatus==='created' && unpaidTerminal(hold)) {
      if(noLiability)await markCancelled(row);
      return ricInvoiceView((await readInvoice(hash))!);
    }
    // A settled first leg alone is not evidence the merchant was paid.
    if(proofPaid(hold) && !(outgoing?.match && proofPaid(outgoing.match)))return pending(hash);
    if(held || proofPaid(hold) || ['accepted','forwarding','forwarded'].includes(row.wrapStatus)) {
      if(unpaidTerminal(hold))return pending(hash);
      const status=await advanceWrap(row as WrapRow);
      const refreshed=await readInvoice(hash);
      if(status==='settled' && refreshed?.paidAt)emitAccountEvent(row.accountId,'payment',{paymentHash:hash,status:'paid',amountSats:row.amountSats,feeSats:row.feeSats??0});
      if(refreshed)return ricInvoiceView(refreshed);
    }
    return pending(hash);
  } finally {client.close();}
}
const inFlight=new Map<string,Promise<RicInvoiceResult>>();
const lastAttempt=new Map<string,number>();
const queue=new Set<string>();let active=0;
const MAX_RECOVERY_CONCURRENCY=1;
const MIN_RECOVERY_INTERVAL_MS=15_000;
export function reconcileRicInvoiceNow(hash:string):Promise<RicInvoiceResult> {
  if(!validHash(hash))return Promise.resolve({status:'not_found',paymentHash:hash});
  const existing=inFlight.get(hash);if(existing)return existing;
  const work=inspectInvoice(hash).catch(async err=>{
    logger.warn({paymentHash:hash,errorClass:err instanceof Error?err.name:'lookup'},'RIC invoice status unknown; retained for reconciliation');
    // A failed wallet read cannot undo a durable checkout abort. Never infer
    // one from a failed read, and let a concurrently paid DB row take priority.
    try {const row=await readInvoice(hash);if(row && (row.paidAt || row.wrapStatus==='cancel_pending'))return ricInvoiceView(row);} catch { /* DB uncertainty remains pending. */ }
    return pending(hash);
  }).finally(()=>inFlight.delete(hash));
  inFlight.set(hash,work);return work;
}
function drain() {
  while(active<MAX_RECOVERY_CONCURRENCY && queue.size) {
    const hash=queue.values().next().value!;queue.delete(hash);active++;
    lastAttempt.delete(hash);lastAttempt.set(hash,Date.now());
    if(lastAttempt.size>2048)lastAttempt.delete(lastAttempt.keys().next().value!);
    void reconcileRicInvoiceNow(hash).finally(()=>{active--;drain();});
  }
}
export function enqueueRicInvoice(hash:string):void {
  if(!validHash(hash) || inFlight.has(hash) || queue.size>=128 || Date.now()-(lastAttempt.get(hash)??0)<MIN_RECOVERY_INTERVAL_MS)return;
  queue.add(hash);drain();
}
export async function cancelRicInvoice(accountId:string,hash:string):Promise<RicInvoiceResult> {
  const row=validHash(hash)?await readInvoice(hash):undefined;
  if(!row || row.accountId!==accountId)return {status:'not_found',paymentHash:hash};
  if(row.wrapStatus==='created')await pool.query("UPDATE pending_invoices SET wrap_status='cancelling',wrap_updated_at=now() WHERE id=$1 AND account_id=$2 AND paid_at IS NULL AND wrap_status='created'",[row.id,accountId]);
  let timer:NodeJS.Timeout|undefined;
  try {return await Promise.race([reconcileRicInvoiceNow(hash),new Promise<RicInvoiceResult>(resolve=>{timer=setTimeout(()=>resolve(pending(hash)),1200);timer.unref();})]);}
  finally {if(timer)clearTimeout(timer);}
}
let interval:NodeJS.Timeout|undefined;let sweeping=false;let cursor='';
export function startRicReconciler():()=>void {
  if(interval)return ()=>{};
  const sweep=async()=>{
    if(sweeping || relayInCooldown())return;sweeping=true;
    try {
      const r=await pool.query<{payment_hash:string;id:string}>("SELECT id,payment_hash FROM pending_invoices WHERE paid_at IS NULL AND (wrap_status IN ('created','cancelling','cancel_pending','accepted','forwarding','forwarded','needs_reconciliation') OR (wrap_status IS NULL AND created_at>now()-interval '24 hours')) AND id::text>$1 ORDER BY id::text LIMIT 20",[cursor]);
      cursor=r.rows.length===20?r.rows[r.rows.length-1].id:'';
      for(const row of r.rows)if(!directExpired.has(row.payment_hash))enqueueRicInvoice(row.payment_hash);
    } catch(err) {logger.warn({errorClass:err instanceof Error?err.name:'db'},'RIC reconciliation sweep unavailable');}
    finally{sweeping=false;}
  };
  void sweep();interval=setInterval(()=>void sweep(),15000);interval.unref();
  return ()=>{if(interval)clearInterval(interval);interval=undefined;};
}
// Standalone generic pending sends: proof-only recovery. No age-based failure,
// no short-page inference, and no repeat pay_invoice. Checkout sends use their
// separately pinned payer snapshots in ric-payment-store.
export async function reconcileRicPendingSends():Promise<void> {
  const pendingRows=await pool.query<{id:string;account_id:string;payment_hash:string;created_at:Date}>("SELECT t.id,t.account_id,t.payment_hash,t.created_at FROM transactions t WHERE t.status='pending' AND t.direction='out' AND t.type='send' AND t.created_at<now()-interval '8 seconds' AND t.payment_hash IS NOT NULL AND NOT EXISTS(SELECT 1 FROM ric_send_checkouts c WHERE c.account_id=t.account_id AND c.payment_hash=t.payment_hash) ORDER BY t.created_at LIMIT 10");
  for(const row of pendingRows.rows) {
    if(relayInCooldown())return;
    const own=await readInvoice(row.payment_hash);
    if(own?.paidAt) {await finalizePendingSend(row.id,{status:'completed',paymentHash:row.payment_hash});continue;}
    const nwc=await getAccountNwcUrl(row.account_id);if(!nwc)continue;
    const client=new NWCClient({nostrWalletConnectUrl:nwc});
    try {
      const proof=await outgoingEvidence(client,row.payment_hash,Math.floor(row.created_at.getTime()/1000)-300);
      if(proof.match && proofPaid(proof.match))await finalizePendingSend(row.id,{status:'completed',paymentHash:row.payment_hash,feeSats:Math.ceil((proof.match.fees_paid??0)/1000)});
      else if(proof.match?.state==='failed')await finalizePendingSend(row.id,{status:'failed',reason:'Wallet reported payment failed'});
    } catch { /* Unknown remains pending. */ } finally {client.close();}
  }
}
