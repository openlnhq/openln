import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
import bcrypt from 'bcryptjs';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
process.env.PORT='0';
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});
let base,a,device;
async function call(path,body,token=a?.token){const r=await fetch(base+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json().catch(()=>({}))}}
async function devCall(path,body,dt=device){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+dt},body:JSON.stringify(body)});return {status:r.status,data:await r.json()}}
before(async()=>{await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;let r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_sendpin_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});assert.equal(r.status,201);a=await r.json();r=await fetch(base+'/api/accounts/'+a.account.id+'/device-tokens',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+a.token},body:JSON.stringify({label:'Send PIN test RIC'})});device=(await r.json()).token;});
after(async()=>{if(a){await sql.query('DELETE FROM pending_invoices WHERE account_id=$1',[a.account.id]);await sql.query('DELETE FROM device_tokens WHERE account_id=$1',[a.account.id]);const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[a.account.id])).rows[0];await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id])}await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});

test('fresh account has no send PIN; device send is refused with a non-looping error',async()=>{
  const g=await call('/api/account/send-pin');assert.equal(g.status,200);assert.equal(g.data.set,false);
  const d=await devCall('/api/pos/withdraw',{amountSats:100,pin:'123456'});
  assert.equal(d.status,403);
  assert.ok(!/pin/i.test(d.data.error),'firmware re-prompts on PIN-ish errors; the unset-PIN message must not loop the device: '+d.data.error);
});

test('set requires exactly 6 digits; a set PIN must be confirmed to change',async()=>{
  for(const bad of [{newPin:'12345'},{newPin:'12345a'},{newPin:''}])assert.equal((await call('/api/account/send-pin',bad)).status,400,'must reject: '+JSON.stringify(bad));
  assert.equal((await call('/api/account/send-pin',{newPin:'123456'})).status,200);
  assert.equal((await call('/api/account/send-pin')).data.set,true);
  assert.equal((await call('/api/account/send-pin',{newPin:'654321'})).status,400,'current PIN required');
  assert.equal((await call('/api/account/send-pin',{newPin:'654321',currentPin:'000000'})).status,401,'wrong current PIN rejected');
  assert.equal((await call('/api/account/send-pin',{newPin:'654321',currentPin:'123456'})).status,200);
});

test('device send verifies the merchant send PIN; the 4-digit card PIN never authorizes it',async()=>{
  assert.equal((await devCall('/api/pos/withdraw',{amountSats:100,pin:'123456'})).status,401,'old PIN after change');
  assert.equal((await devCall('/api/pos/withdraw',{amountSats:100})).status,400,'missing PIN');
  assert.equal((await devCall('/api/pos/withdraw',{amountSats:100,pin:'1234'})).status,401,'4-digit card-shaped PIN must not pass a 6-digit send PIN');
  const w=await devCall('/api/pos/withdraw',{amountSats:100,pin:'654321'});
  assert.equal(w.status,400);assert.match(w.data.error,/wallet not configured/i,'correct PIN reaches the wallet stage');
  assert.equal((await devCall('/api/pos/send-to-card',{cardUrl:'junk',amountSats:100,pin:'111111'})).status,401);
  const sc=await devCall('/api/pos/send-to-card',{cardUrl:'junk',amountSats:100,pin:'654321'});
  assert.equal(sc.status,400);assert.match(sc.data.error,/card url/i,'correct PIN reaches the card stage');
  const cb=await fetch(base+'/api/pos/withdraw/callback?k1=deadbeef');assert.equal(cb.status,200);assert.equal((await cb.json()).status,'ERROR');
});

test('legacy 4-digit bitPOS PIN keeps verifying on the device path',async()=>{
  await sql.query('UPDATE entities SET pin_hash=$1 WHERE id=(SELECT entity_id FROM accounts WHERE id=$2)',[bcrypt.hashSync('1234',10),a.account.id]);
  const ok=await devCall('/api/pos/withdraw',{amountSats:100,pin:'1234'});
  assert.equal(ok.status,400);assert.match(ok.data.error,/wallet not configured/i,'legacy 4-digit PIN passes the guard');
  assert.equal((await devCall('/api/pos/withdraw',{amountSats:100,pin:'654321'})).status,401);
});

test('withdraw creation returns the k1 window the RIC displays',async()=>{
  // Point the account at a Blink-shaped wallet via SQL (same trick as the
  // legacy-PIN test). This route only decrypts the stored key — it never calls
  // the wallet — so a fake key is enough to reach the success path.
  const {encrypt}=await import('../dist/core/money/encrypt.js');
  await sql.query('UPDATE accounts SET wallet_mode=$1, blink_api_key_encrypted=$2 WHERE id=$3',['blink',encrypt('blink_fake_test_key'),a.account.id]);
  await sql.query('UPDATE entities SET pin_hash=$1 WHERE id=(SELECT entity_id FROM accounts WHERE id=$2)',[bcrypt.hashSync('654321',10),a.account.id]);
  try{
    const w=await devCall('/api/pos/withdraw',{amountSats:100,pin:'654321'});
    assert.equal(w.status,200,'wallet configured -> withdrawal is created');
    assert.match(w.data.lnurlw,/^lnurl1/i,'LNURL-W QR payload');
    assert.match(w.data.k1,/^[0-9a-f]{32}$/,'k1 challenge');
    const expiresAt=Date.parse(w.data.expiresAt);
    assert.ok(Number.isFinite(expiresAt),'expiresAt must be an ISO timestamp: '+w.data.expiresAt);
    const windowMs=expiresAt-Date.now();
    assert.ok(windowMs>4*60*1000 && windowMs<=5*60*1000,'server window is ~5 min; got '+Math.round(windowMs/1000)+'s');
    // The response must mirror exactly what the server stores and polls against.
    const {rows:[row]}=await sql.query('SELECT expires_at FROM pending_invoices WHERE payment_hash=$1',[w.data.k1]);
    assert.ok(row,'withdrawal row stored');
    assert.equal(new Date(row.expires_at).toISOString(),new Date(expiresAt).toISOString(),'response mirrors the stored expiry');
  }finally{
    await sql.query('DELETE FROM pending_invoices WHERE account_id=$1',[a.account.id]);
  }
});
