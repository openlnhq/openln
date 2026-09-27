// Send-scanner target resolution end to end: BOLT11, lightning addresses,
// LNURL-pay (bech32 lnurl1 / LUD-17 / raw https), LNURL-withdraw, login codes,
// then a full /api/wallet/pay through the Blink lane.
// Hermetic: the LNURL provider and the Blink GraphQL API are stubbed in-process.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {once} from 'node:events';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch only');

// ── Provider harness ─────────────────────────────────────────────────────────
const CHARSET='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
// Structurally valid bolt11: the openLN parser reads the p-tag; the checksum
// is skipped, so a synthetic invoice round-trips without signing keys.
function mkBolt11(hashHex,sats=null){
  const words=[0,0,0,0,0,0,0];
  const hw=[];let acc=0,bits=0;
  for(const b of Buffer.from(hashHex,'hex')){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;hw.push((acc>>bits)&31);}}
  if(bits)hw.push((acc<<(5-bits))&31);
  words.push(1,hw.length>>5,hw.length&31,...hw);
  return (sats?'lnbc'+(sats*10)+'n':'lnbc')+'1'+words.map(w=>CHARSET[w]).join('')+'qqqqqq';
}
const randomHash=()=>createHash('sha256').update(randomBytes(16)).digest('hex');
const json=(obj,status=200)=>new Response(JSON.stringify(obj),{status,headers:{'content-type':'application/json'}});

const BLINK_KEY='blink_openln_qa_0123456789abcdef';
let carolComment=null;
let blinkPayCalls=0;

const realFetch=globalThis.fetch;
globalThis.fetch=async (input,init)=>{
  const url=typeof input==='string'?input:String(input.url??input);
  const u=new URL(url);
  if(u.hostname==='127.0.0.1'||u.hostname==='localhost')return realFetch(input,init); // the test's own server calls
  if(u.hostname==='ln.test'){
    if(u.pathname==='/.well-known/lnurlp/alice')return json({status:'OK',tag:'payRequest',callback:'https://ln.test/pay/alice',minSendable:1000,maxSendable:100000000000,commentAllowed:255});
    if(u.pathname==='/.well-known/lnurlp/carol')return json({status:'OK',tag:'payRequest',callback:'https://ln.test/pay/carol',minSendable:1000,maxSendable:500000,commentAllowed:10});
    if(u.pathname==='/.well-known/lnurlp/dave')return json({status:'OK',tag:'payRequest',callback:'https://ln.test/pay/dave',minSendable:1000,maxSendable:100000000000,commentAllowed:0});
    if(u.pathname==='/pay/dave')return json({error:true,message:'Recipient wallet error. Please contact the recipient.'}); // getalby-style failure shape
    if(u.pathname==='/pay/alice')return json({pr:mkBolt11(randomHash())});
    if(u.pathname==='/pay/carol'){
      carolComment=u.searchParams.get('comment');
      const sats=Math.round(Number(u.searchParams.get('amount')||0)/1000);
      return json({pr:mkBolt11(randomHash(),sats||null)});
    }
    if(u.pathname==='/withdraw/carol')return json({status:'OK',tag:'withdrawRequest',callback:'https://ln.test/withdraw/carol/cb',k1:'ab'.repeat(32),maxWithdrawable:210000,defaultDescription:'Lunch refund'});
    if(u.pathname==='/login/page')return json({status:'OK',tag:'login',k1:'cd'.repeat(32),callback:'https://ln.test/login/cb'});
    return json({status:'ERROR',reason:'unknown lnurl path'},404);
  }
  if(u.hostname==='api.blink.test'){
    if((init?.headers??{})['X-API-KEY']!==BLINK_KEY)return json({errors:[{message:'unauthorized'}]},401);
    const body=JSON.parse(init?.body??'{}');const q=String(body.query??'');
    if(q.includes('OpenLnMe'))return json({data:{me:{defaultAccount:{wallets:[{id:'wbtc-openln-test',walletCurrency:'BTC',balance:210000}]}}}});
    // Connect validates receive capability by creating a throwaway invoice.
    if(q.includes('OpenLnInvoiceCreate')){const bh=randomHash();return json({data:{lnInvoiceCreate:{errors:[],invoice:{paymentRequest:mkBolt11(bh),paymentHash:bh,satoshis:body.variables?.input?.amount}}}});}
    if(q.includes('OpenLnPay')){blinkPayCalls++;return json({data:{lnInvoicePaymentSend:{status:'SUCCESS',errors:[]}}});}
    return json({errors:[{message:'unknown operation'}]});
  }
  if(u.hostname==='dead.test')throw new TypeError('fetch failed');
  throw new Error('blocked host '+u.hostname);
};
const dnsMod=await import('node:dns/promises');
const realLookup=dnsMod.default.lookup;
dnsMod.default.lookup=async()=>[{address:'203.0.113.7',family:4}];

process.env.PORT='0';
process.env.BLINK_API_URL='https://api.blink.test/graphql';
// Skip the background drivers + reconcile cron: HTTP paths under test are
// synchronous, and the cron timers otherwise keep the test process alive.
process.env.WRAP_DRIVER_ENABLED='0';
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');

let base;
const q=(sql,params)=>pool.query(sql,params);
async function register(){
  const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_send_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});
  assert.equal(r.status,201);return r.json();
}
const auth=(token)=>({Authorization:'Bearer '+token});
const resolve=(token,input,extra={})=>fetch(base+'/api/wallet/resolve',{method:'POST',headers:{'Content-Type':'application/json',...auth(token)},body:JSON.stringify({input,...extra})});

before(async()=>{if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;});
after(async()=>{globalThis.fetch=realFetch;dnsMod.default.lookup=realLookup;server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});

test('resolve is session-only and validates input',async()=>{
  const noauth=await fetch(base+'/api/wallet/resolve',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({input:'alice@ln.test'})});
  assert.equal(noauth.status,401);
  const a=await register();
  assert.equal((await resolve(a.token,'')).status,400);
  assert.equal((await resolve(a.token,'x'.repeat(2100))).status,400);
});

test('bolt11 targets come back with their amount',async()=>{
  const a=await register();
  let j=await (await resolve(a.token,mkBolt11(randomHash(),1234))).json();
  assert.equal(j.kind,'bolt11');assert.equal(j.amountSats,1234);
  j=await (await resolve(a.token,mkBolt11(randomHash()))).json();
  assert.equal(j.kind,'bolt11');assert.equal(j.amountSats,null);
});

test('lightning address resolves to a pay target and mints the invoice when given an amount',async()=>{
  const a=await register();
  let j=await (await resolve(a.token,'alice@ln.test')).json();
  assert.equal(j.kind,'lnurl_pay');assert.equal(j.source,'alice@ln.test');
  assert.equal(j.minSendableSats,1);assert.equal(j.maxSendableSats,100000000);assert.equal(j.commentAllowed,255);
  assert.equal(j.invoice,undefined,'no amount yet means no invoice minted');
  j=await (await resolve(a.token,'alice@ln.test',{amountSats:500})).json();
  assert.ok(j.invoice,'amount present mints the invoice');
  assert.match(j.invoice.bolt11,/^lnbc1/);assert.match(j.invoice.paymentHash,/^[0-9a-f]{64}$/);
  assert.equal(j.invoice.amountSats,500,'the mint echoes the requested amount for the confirm screen');
});

test('lnurl bech32, LUD-17 and raw https all resolve to the same pay target',async()=>{
  const a=await register();
  const {encodeLnurl}=await import('../dist/core/money/boltcard.js');
  for(const input of [encodeLnurl('https://ln.test/.well-known/lnurlp/alice'),'lnurlp://ln.test/.well-known/lnurlp/alice','https://ln.test/.well-known/lnurlp/alice']){
    const j=await (await resolve(a.token,input)).json();
    assert.equal(j.kind,'lnurl_pay',input);
    assert.equal(j.source,'ln.test',input);
    assert.equal(j.maxSendableSats,100000000,input);
  }
});

test('amount outside the provider range is refused with the range in the message',async()=>{
  const a=await register();
  const r=await resolve(a.token,'carol@ln.test',{amountSats:600});
  assert.equal(r.status,400);
  assert.match((await r.json()).error,/out of range/i);
});

test('comment passes through when allowed and is trimmed to the provider limit',async()=>{
  const a=await register();
  await resolve(a.token,'carol@ln.test',{amountSats:200,comment:'hi there'});
  assert.equal(carolComment,'hi there');
  await resolve(a.token,'carol@ln.test',{amountSats:200,comment:'abcdefghijkl'}); // 12 chars, provider allows 10
  assert.equal(carolComment,'abcdefghij','provider commentAllowed trims the comment');
});

test('lnurl-withdraw comes back with its limits and stays a receive code',async()=>{
  const a=await register();
  for(const input of ['https://ln.test/withdraw/carol','lnurlw://ln.test/withdraw/carol']){
    const j=await (await resolve(a.token,input)).json();
    assert.equal(j.kind,'lnurl_withdraw',input);
    assert.equal(j.source,'ln.test');assert.equal(j.maxWithdrawableSats,210);
    assert.equal(j.defaultDescription,'Lunch refund');assert.equal(j.input,input);
  }
});

test('login codes and unclassifiable input are explained, not paid',async()=>{
  const a=await register();
  let j=await (await resolve(a.token,'https://ln.test/login/page')).json();
  assert.equal(j.kind,'unsupported');assert.match(j.message,/login code/i);
  j=await (await resolve(a.token,'hello world')).json();
  assert.equal(j.kind,'unsupported');
  j=await (await resolve(a.token,'lno1pqps7sjq')).json();
  assert.equal(j.kind,'unsupported');assert.match(j.message,/BOLT12/i);
});

test('provider-side invoice errors surface the provider message',async()=>{
  const a=await register();
  const r=await resolve(a.token,'dave@ln.test',{amountSats:100});
  assert.equal(r.status,400);
  assert.match((await r.json()).error,/Recipient wallet error/);
});

test('an unreachable payee is explained without leaking network errors',async()=>{
  const a=await register();
  const r=await resolve(a.token,'nobody@dead.test');
  assert.equal(r.status,400);
  assert.match((await r.json()).error,/Could not reach/i);
});

test('a scanned pay target pays end to end through /api/wallet/pay',async()=>{
  const a=await register();
  const c=await fetch(base+'/api/wallet/connect',{method:'POST',headers:{'Content-Type':'application/json',...auth(a.token)},body:JSON.stringify({connection:BLINK_KEY})});
  assert.equal(c.status,200);
  const j=await (await resolve(a.token,'carol@ln.test',{amountSats:200})).json();
  assert.ok(j.invoice);
  assert.equal(j.invoice.amountSats,200,'the mint echoes the requested amount for the confirm screen');
  const pay=await fetch(base+'/api/wallet/pay',{method:'POST',headers:{'Content-Type':'application/json',...auth(a.token)},body:JSON.stringify({bolt11:j.invoice.bolt11,purpose:'spend'})});
  assert.equal(pay.status,200);
  const pj=await pay.json();
  assert.equal(pj.status,'completed');assert.equal(pj.paymentHash,j.invoice.paymentHash);
  assert.equal(blinkPayCalls,1);
  const {rows:[tx]}=await q('SELECT direction, status, amount_sats::int AS a, class FROM transactions WHERE payment_hash=$1',[j.invoice.paymentHash]);
  assert.equal(tx.direction,'out');assert.equal(tx.status,'completed');assert.equal(tx.a,200);assert.equal(tx.class,'spend');
});
