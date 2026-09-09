import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {sunParams} from './helpers/sun.mjs';
import pg from 'pg';

if (!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_')) throw Error('Scratch database required');
process.env.PORT='0';
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});
let base,a,b,device;
const ids=[];
async function call(path,{token=a?.token,method='GET',body}={}){
  const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
  return {status:r.status,data,headers:r.headers};
}
async function issue(){const r=await call('/api/accounts/'+a.account.id+'/cards',{method:'POST',body:{name:'Trial card',note:'Counter test',pin:'1357',perTapLimitSats:5000,dailyLimitSats:10000}});assert.equal(r.status,201);return r.data}
before(async()=>{
  await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
  for(let i=0;i<2;i++){const r=await call('/api/auth/register',{token:null,method:'POST',body:{handle:'qa_card_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')}});assert.equal(r.status,201);ids.push(r.data.account.id);if(i===0)a=r.data;else b=r.data}
  const r=await call('/api/accounts/'+a.account.id+'/device-tokens',{method:'POST',body:{label:'QA RIC'}});assert.equal(r.status,201);device=r.data.token;
});
after(async()=>{
  // The ledger is deliberately append-only. Keep isolated QA fixtures in the
  // disposable scratch DB instead of disabling its protection to delete them.
  await sql.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end();
});

test('issued card QR uses the actual raw token, not its stored hash',async()=>{
  const card=await issue();
  const QRCode=(await import('qrcode')).default;
  const response=await call('/api/cards/'+card.cardId+'/provision-qr');
  const expected=await QRCode.toString(card.provisionUrl,{type:'svg',margin:1,width:320,color:{dark:'#ffffff',light:'#0a0f0f'}});
  // Old route generated a visibly valid QR encoding the stored SHA256 hash.
  const qr=card.provisionQr||response.data;
  const expectedNew=await QRCode.toString(card.provisionUrl,{type:'svg',margin:4,width:320,color:{dark:'#071c1b',light:'#ffffff'}});
  assert.ok(qr===expected || qr===expectedNew,'QR must encode the exact returned raw-token URL');
  const raw=card.provisionUrl.split('/').pop();
  assert.match(raw,/^[0-9a-f]{48}$/);
  const redeemed=await call('/api/provision/'+raw,{token:null});assert.equal(redeemed.status,200);assert.equal(redeemed.data.protocol_name,'new_bolt_card_response');
  for(let i=0;i<5;i++)assert.equal(redeemed.data['k'+i],card.keys['key'+i]);
  assert.equal((await call('/api/provision/'+raw,{token:null})).status,404);
});

test('owner can renew an unused card setup link; the old link is revoked',async()=>{
  const card=await issue();
  const denied=await call('/api/cards/'+card.cardId+'/provision',{token:b.token,method:'POST',body:{}});assert.equal(denied.status,404);
  const renewed=await call('/api/cards/'+card.cardId+'/provision',{method:'POST',body:{}});assert.equal(renewed.status,200);
  assert.ok(renewed.data.provisionUrl && renewed.data.provisionQr);
  assert.notEqual(renewed.data.provisionUrl,card.provisionUrl);
  assert.equal((await call(new URL(card.provisionUrl).pathname,{token:null})).status,404);
  const results=await Promise.all(Array.from({length:4},()=>call(new URL(renewed.data.provisionUrl).pathname,{token:null})));
  assert.equal(results.filter(r=>r.status===200).length,1,'Only one reader may consume a setup token');
  assert.equal(results.filter(r=>r.status===404).length,3);
});

test('RIC receives a real NDEF hex file and SDM offsets, then write/wipe reads back',async()=>{
  // Other tests may leave unused cards; isolate this account's queue.
  await sql.query('UPDATE cards SET provision_token=NULL, provision_token_expires_at=NULL WHERE account_id=$1',[a.account.id]);
  const card=await issue();
  const next=await call('/api/pos/next-provision',{token:device});assert.equal(next.status,200);assert.equal(next.data.cardId,card.cardId);
  assert.match(next.data.ndefFile,/^(?:[0-9a-f]{2})+$/i,'RIC expects NDEF bytes encoded as hex, not a URL');
  assert.match(next.data.sdmSettings,/^[0-9a-f]{30}$/i);
  const ndef=Buffer.from(next.data.ndefFile,'hex');assert.equal(ndef.readUInt16BE(0),ndef.length-2);
  const url=ndef.subarray(7).toString();assert.equal(url,card.lnurlwTemplate);
  const sdm=Buffer.from(next.data.sdmSettings,'hex');
  assert.equal(ndef.subarray(sdm.readUIntLE(6,3),sdm.readUIntLE(6,3)+32).toString(),'0'.repeat(32));
  assert.equal(ndef.subarray(sdm.readUIntLE(9,3),sdm.readUIntLE(9,3)+16).toString(),'0'.repeat(16));
  for(let i=0;i<5;i++)assert.equal(next.data['k'+i],card.keys['key'+i]);
  assert.equal((await call('/api/pos/mark-written/'+card.cardId,{token:device,method:'POST',body:{}})).status,200);
  assert.equal((await call('/api/pos/next-provision',{token:device})).status,404);
  const listed=await call('/api/accounts/'+a.account.id+'/cards');assert.ok(listed.data.find(c=>c.id===card.cardId).lastUsedAt);
  const wipe=await call('/api/pos/wipe-keys/'+card.cardId,{token:device});assert.equal(wipe.status,200);assert.equal(wipe.data.factorySettings,'40e0ee01ffff');
  assert.equal((await call('/api/pos/mark-wiped/'+card.cardId,{token:device,method:'POST',body:{}})).status,200);
  const after=await call('/api/accounts/'+a.account.id+'/cards');assert.equal(after.data.find(c=>c.id===card.cardId).status,'cancelled');
});

test('card tap advertises LUD-21 PIN and refuses missing PIN before any NWC call',async()=>{
  const card=await issue();
  const probe=await call('/card/'+card.cardId+'?p='+'0'.repeat(32)+'&c='+'0'.repeat(16),{token:null});
  assert.equal(probe.data.pinLimit,0,'New cards require their 4-digit PIN on every payment');
  await sql.query('UPDATE cards SET pending_k1=$2,pending_k1_expires_at=now()+interval \'5 minutes\' WHERE id=$1',[card.cardId,'qa-pin-challenge']);
  // Header-shaped invoice only reaches pre-payment validation; no wallet configured.
  const callback=await call('/card/'+card.cardId+'/callback?k1=qa-pin-challenge&pr=lnbc10u1test',{token:null});
  assert.equal(callback.data.status,'ERROR');assert.match(callback.data.reason,/PIN required/);
});


test('card daily limit constrains real SUN taps and concurrent replay admits one',async()=>{
  const card=await issue();
  await sql.query("INSERT INTO transactions(account_id,card_id,direction,type,status,amount_sats) VALUES($1,$2,'out','send','completed',9000)",[a.account.id,card.cardId]);
  const params=new URLSearchParams(sunParams(card.keys.key1,card.keys.key2,1));
  const taps=await Promise.all(Array.from({length:8},()=>call('/card/'+card.cardId+'?'+params,{token:null})));
  const accepted=taps.filter(r=>r.data.tag==='withdrawRequest');
  assert.equal(accepted.length,1,'Atomic SUN counter must admit exactly one concurrent replay');
  assert.equal(accepted[0].data.maxWithdrawable,1000000,'Only 1000 sats of the daily limit remains');
});

test('cancelled card cannot be resurrected, provisioned, or marked written',async()=>{
  const card=await issue();assert.equal((await call('/api/cards/'+card.cardId,{method:'DELETE'})).status,200);
  assert.equal((await call('/api/cards/'+card.cardId,{method:'PATCH',body:{status:'active'}})).status,409);
  assert.equal((await call(new URL(card.provisionUrl).pathname,{token:null})).status,404);
  assert.equal((await call('/api/pos/mark-written/'+card.cardId,{token:device,method:'POST',body:{}})).status,409);
  // Retain keys for a physical wipe even after cancellation.
  assert.equal((await call('/api/pos/wipe-keys/'+card.cardId,{token:device})).status,200);
});

test('changing PIN always verifies the current PIN, even identical fields or omitted current PIN',async()=>{
  const card=await issue();
  for(const body of [{newPin:'2468'},{pin:'2468',newPin:'2468'}])assert.equal((await call('/api/cards/'+card.cardId+'/pin',{method:'PUT',body})).status,401);
  assert.equal((await call('/api/cards/'+card.cardId+'/pin',{method:'PUT',body:{pin:'1357',newPin:'2468'}})).status,200);
  assert.equal((await call('/api/cards/'+card.cardId+'/pin',{method:'PUT',body:{pin:'2468',newPin:null}})).status,200);
  const listed=await call('/api/accounts/'+a.account.id+'/cards');assert.equal(listed.data.find(c=>c.id===card.cardId).pinEnabled,false);
});

test('phone wipe exports the creator-app QR without destroying recovery keys',async()=>{
 const card=await issue();const wipe=await call('/api/cards/'+card.cardId+'/wipe',{method:'POST',body:{}});assert.equal(wipe.status,200);assert.equal(wipe.data.wipeKeys.protocol_name,'wipe_bolt_card_response');
 for(let i=0;i<5;i++)assert.equal(wipe.data.wipeKeys['k'+i],card.keys['key'+i]);assert.match(wipe.data.wipeQr,/<svg/);
 const unchanged=await call('/api/cards/'+card.cardId+'/keys',{method:'POST',body:{}});assert.equal(unchanged.data.k0,card.keys.key0);
 assert.equal((await call('/api/cards/'+card.cardId+'/wipe',{token:b.token,method:'POST',body:{}})).status,404);
});

test('negative, fractional, unsafe and nonnumeric limits are rejected',async()=>{const card=await issue();for(const value of [-1,1.5,9007199254740992,'oops']){assert.equal((await call('/api/cards/'+card.cardId,{method:'PATCH',body:{perTapLimitSats:value}})).status,400);assert.equal((await call('/api/accounts/'+a.account.id+'/cards',{method:'POST',body:{pin:'1357',dailyLimitSats:value}})).status,400)}});
