// Funding-source lanes end to end: Lightning Address (receive-only, LUD-21)
// and Blink API wallet - connect, POS receive, and settlement observation.
//
// Fully hermetic: the LNURL provider (DNS + HTTPS) and the Blink GraphQL API
// are stubbed in-process, so no real wallet or public network is touched.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch only');

// ── Provider harness ─────────────────────────────────────────────────────────
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const CHARSET='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
// Structurally valid bolt11: the openLN parser reads the p-tag; the checksum
// is skipped, so a synthetic invoice round-trips without signing keys.
function mkBolt11(hashHex){
  const words=[0,0,0,0,0,0,0];
  const hw=[];let acc=0,bits=0;
  for(const b of Buffer.from(hashHex,'hex')){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;hw.push((acc>>bits)&31);}}
  if(bits)hw.push((acc<<(5-bits))&31);
  words.push(1,hw.length>>5,hw.length&31,...hw);
  return 'lnbc1'+words.map(w=>CHARSET[w]).join('')+'qqqqqq';
}
const randomHash=()=>createHash('sha256').update(randomBytes(16)).digest('hex');
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}});

const LN_ADDR='alice@ln.test';
const BLINK_KEY='blink_openln_qa_0123456789abcdef';
let verifySettled=false;
let blinkStatus='PENDING';
let blinkHash=null;

const realFetch=globalThis.fetch;
globalThis.fetch=async (input,init)=>{
  const url=typeof input==='string'?input:String(input.url??input);
  const u=new URL(url);
  if(u.hostname==='127.0.0.1'||u.hostname==='localhost')return realFetch(input,init); // the test's own server calls
  if(u.hostname==='ln.test'){
    if(u.pathname==='/.well-known/lnurlp/alice'){
      return json({status:'OK',tag:'payRequest',callback:'https://ln.test/pay/alice',minSendable:1000,maxSendable:100000000000,commentAllowed:255});
    }
    if(u.pathname==='/.well-known/lnurlp/bob'){
      return json({status:'OK',tag:'payRequest',callback:'https://ln.test/pay/bob',minSendable:1000,maxSendable:100000000000,commentAllowed:0});
    }
    if(u.pathname==='/pay/alice')return json({pr:mkBolt11(randomHash()),verify:'https://ln.test/verify/alice/1'});
    if(u.pathname==='/pay/bob')return json({pr:mkBolt11(randomHash())}); // no verify -> not connectable
    if(u.pathname==='/verify/alice/1')return json({status:'OK',settled:verifySettled,preimage:verifySettled?'ab'.repeat(32):undefined});
    return json({status:'ERROR',reason:'unknown lnurl path'},404);
  }
  if(u.hostname==='api.blink.test'){
    if((init?.headers??{})['X-API-KEY']!==BLINK_KEY)return json({errors:[{message:'unauthorized'}]},401);
    const body=JSON.parse(init?.body??'{}');const q=String(body.query??'');
    if(q.includes('OpenLnMe'))return json({data:{me:{defaultAccount:{wallets:[{id:'wbtc-openln-test',walletCurrency:'BTC',balance:21000}]}}}});
    if(q.includes('OpenLnInvoiceCreate')){blinkHash=randomHash();return json({data:{lnInvoiceCreate:{errors:[],invoice:{paymentRequest:mkBolt11(blinkHash),paymentHash:blinkHash,satoshis:body.variables?.input?.amount}}}});}
    if(q.includes('OpenLnStatus'))return json({data:{lnInvoicePaymentStatusByPaymentRequest:{status:blinkStatus,paymentHash:blinkHash}}});
    return json({errors:[{message:'unknown operation'}]});
  }
  throw new Error('blocked host '+u.hostname);
};
const dnsMod=await import('node:dns/promises');
const realLookup=dnsMod.default.lookup;
dnsMod.default.lookup=async()=>[{address:'203.0.113.7',family:4}];

process.env.PORT='0';
process.env.BLINK_API_URL='https://api.blink.test/graphql';
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');

let base;
const q=(sql,params)=>pool.query(sql,params);
async function register(){
  const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_fund_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});
  assert.equal(r.status,201);return r.json();
}
const auth=(token)=>({Authorization:'Bearer '+token});
const connect=(token,connection)=>fetch(base+'/api/wallet/connect',{method:'POST',headers:{'Content-Type':'application/json',...auth(token)},body:JSON.stringify({connection})});

before(async()=>{if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;});
after(async()=>{globalThis.fetch=realFetch;dnsMod.default.lookup=realLookup;server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});

test('unclassifiable input is rejected and leaves the wallet untouched',async()=>{
  const a=await register();
  const r=await connect(a.token,'definitely not a wallet');
  assert.equal(r.status,400);
  const {rows:[row]}=await q('SELECT wallet_mode, custom_nwc_url, lightning_address, blink_api_key_encrypted FROM accounts WHERE id=$1',[a.account.id]);
  assert.equal(row.wallet_mode,'unset');
  assert.equal(row.custom_nwc_url,null);
  assert.equal(row.lightning_address,null);
  assert.equal(row.blink_api_key_encrypted,null);
});

test('lightning address: connect is receive-only, POS invoice settles via LUD-21 verify',async()=>{
  const a=await register();
  const r=await connect(a.token,LN_ADDR);
  assert.equal(r.status,200);
  const j=await r.json();
  assert.equal(j.walletMode,'lnaddress');assert.equal(j.connected,true);assert.equal(j.receiveOnly,true);
  let {rows:[row]}=await q('SELECT wallet_mode, lightning_address FROM accounts WHERE id=$1',[a.account.id]);
  assert.equal(row.wallet_mode,'lnaddress');assert.equal(row.lightning_address,LN_ADDR);

  const sj=await (await fetch(base+'/api/wallet/status',{headers:auth(a.token)})).json();
  assert.equal(sj.walletMode,'lnaddress');assert.equal(sj.receiveOnly,true);assert.equal(sj.canSend,false);assert.equal(sj.connected,false);

  const inv=await fetch(base+'/api/pos/invoice',{method:'POST',headers:{'Content-Type':'application/json',...auth(a.token)},body:JSON.stringify({amountSats:1500,memo:'qa ln address'})});
  assert.equal(inv.status,201);
  const ij=await inv.json();
  assert.equal(ij.receiveOnly,true);assert.match(ij.bolt11,/^lnbc1/);

  ({rows:[row]}=await q('SELECT paid_at, wrap_status, nwc_url_encrypted, lnurl_verify_url, fee_sats FROM pending_invoices WHERE payment_hash=$1',[ij.paymentHash]));
  assert.equal(row.paid_at,null);assert.equal(row.wrap_status,null);assert.equal(row.nwc_url_encrypted,null);
  assert.equal(row.lnurl_verify_url,'https://ln.test/verify/alice/1');assert.equal(row.fee_sats,null);

  // Take the account's reconcile slot, then settle through the verify URL.
  await fetch(base+'/api/wallet/balance',{headers:auth(a.token)});
  verifySettled=true;
  await sleep(5300);
  const bj=await (await fetch(base+'/api/wallet/balance',{headers:auth(a.token)})).json();
  assert.equal(bj.receiveOnly,true);assert.equal(bj.connected,false);

  ({rows:[row]}=await q('SELECT paid_at FROM pending_invoices WHERE payment_hash=$1',[ij.paymentHash]));
  assert.ok(row.paid_at instanceof Date,'invoice settled via LUD-21 verify');
  const {rows:[tx]}=await q('SELECT direction, status, type, amount_sats::int AS a FROM transactions WHERE payment_hash=$1',[ij.paymentHash]);
  assert.equal(tx.direction,'in');assert.equal(tx.status,'completed');assert.equal(tx.type,'receive');assert.equal(tx.a,1500);
});

test('lightning address without LUD-21 verify is rejected at connect',async()=>{
  const a=await register();
  const r=await connect(a.token,'bob@ln.test');
  assert.equal(r.status,422);
  assert.match((await r.json()).error,/LUD-21|verify/i);
  const {rows:[row]}=await q('SELECT wallet_mode FROM accounts WHERE id=$1',[a.account.id]);
  assert.equal(row.wallet_mode,'unset');
});

test('blink: wrong key fails validation, good key connects, POS invoice settles via API status',async()=>{
  const a=await register();
  const bad=await connect(a.token,'blink_wrongkey_0000000000');
  assert.equal(bad.status,422);
  let {rows:[row]}=await q('SELECT wallet_mode FROM accounts WHERE id=$1',[a.account.id]);
  assert.equal(row.wallet_mode,'unset');

  const r=await connect(a.token,BLINK_KEY);
  assert.equal(r.status,200);
  const j=await r.json();
  assert.equal(j.walletMode,'blink');assert.equal(j.connected,true);assert.equal(j.balanceSats,21000);
  ({rows:[row]}=await q('SELECT wallet_mode, blink_wallet_id, blink_wallet_currency, (blink_api_key_encrypted IS NOT NULL) AS has_key FROM accounts WHERE id=$1',[a.account.id]));
  assert.equal(row.wallet_mode,'blink');assert.equal(row.blink_wallet_id,'wbtc-openln-test');
  assert.equal(row.blink_wallet_currency,'BTC');assert.equal(row.has_key,true);

  const sj=await (await fetch(base+'/api/wallet/status',{headers:auth(a.token)})).json();
  assert.equal(sj.walletMode,'blink');assert.equal(sj.connected,true);assert.equal(sj.canSend,false);

  blinkStatus='PENDING';
  const inv=await fetch(base+'/api/pos/invoice',{method:'POST',headers:{'Content-Type':'application/json',...auth(a.token)},body:JSON.stringify({amountSats:700,memo:'qa blink'})});
  assert.equal(inv.status,201);
  const ij=await inv.json();assert.match(ij.bolt11,/^lnbc1/);
  ({rows:[row]}=await q('SELECT paid_at, wrap_status, nwc_url_encrypted, lnurl_verify_url FROM pending_invoices WHERE payment_hash=$1',[ij.paymentHash]));
  assert.equal(row.paid_at,null);assert.equal(row.wrap_status,null);assert.equal(row.nwc_url_encrypted,null);assert.equal(row.lnurl_verify_url,null);

  // Reconcile slot, then flip the invoice to PAID on the Blink side.
  await fetch(base+'/api/wallet/balance',{headers:auth(a.token)});
  blinkStatus='PAID';
  await sleep(5300);
  const bj=await (await fetch(base+'/api/wallet/balance',{headers:auth(a.token)})).json();
  assert.equal(bj.connected,true);assert.equal(bj.balanceSats,21000);

  ({rows:[row]}=await q('SELECT paid_at FROM pending_invoices WHERE payment_hash=$1',[ij.paymentHash]));
  assert.ok(row.paid_at instanceof Date,'invoice settled via Blink API status');
  const {rows:[tx]}=await q('SELECT direction, status FROM transactions WHERE payment_hash=$1',[ij.paymentHash]);
  assert.equal(tx.direction,'in');assert.equal(tx.status,'completed');
});
