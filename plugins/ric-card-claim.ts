import { pool } from '../core/db/index.js';
import { extractPaymentHash } from '../core/money/lnAddress.js';
// Serialize the check/reservation, not the network. Claim survives crash and
// cannot disappear on a wall-clock timeout. No payment is implemented here.
export async function claimCardPayment(cardId:string,accountId:string,invoice:string,amount:number):Promise<boolean> {
  const hash=extractPaymentHash(invoice);const client=await pool.connect();
  try {
    await client.query('BEGIN');
    const card=(await client.query('SELECT daily_limit_sats,per_tap_limit_sats,status,pin_locked_at FROM cards WHERE id=$1 FOR UPDATE',[cardId])).rows[0];
    if(!card || card.status!=='active' || card.pin_locked_at || amount>Number(card.per_tap_limit_sats)) {await client.query('ROLLBACK');return false;}
    await client.query("DELETE FROM ric_card_claims c WHERE c.card_id=$1 AND EXISTS(SELECT 1 FROM transactions t WHERE t.card_id=c.card_id AND t.account_id=c.account_id AND t.payment_hash=c.payment_hash AND t.direction='out' AND t.status IN ('completed','failed'))",[cardId]);
    const active=(await client.query("SELECT 1 FROM ric_card_claims WHERE card_id=$1 UNION ALL SELECT 1 FROM transactions WHERE card_id=$1 AND direction='out' AND status='pending' LIMIT 1",[cardId])).rows.length>0;
    const spent=(await client.query("SELECT coalesce(sum(amount_sats),0) AS total FROM transactions WHERE card_id=$1 AND direction='out' AND status='completed' AND created_at >= date_trunc('day',now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'",[cardId])).rows[0];
    if(active || Number(spent.total)+amount>Number(card.daily_limit_sats)) {await client.query('ROLLBACK');return false;}
    await client.query('INSERT INTO ric_card_claims(card_id,account_id,payment_hash,amount_sats) VALUES($1,$2,$3,$4)',[cardId,accountId,hash,amount]);
    await client.query('COMMIT');return true;
  } catch(err) {await client.query('ROLLBACK');throw err;} finally {client.release();}
}
