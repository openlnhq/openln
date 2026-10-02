// CLINK offer webhooks end to end: a noffer connection is issued a hook pair
// (public id in the URL, bearer token as the secret), Lightning.Pub-style paid
// pushes settle a direct sale exactly once, mismatched amounts are blocked,
// wrapped rows only ever get a corroboration record, and an offer without a
// webhook keeps refusing the direct fallback until one is issued.
import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {randomBytes,createHash} from 'node:crypto';import {once} from 'node:events';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch only');
process.env.PORT='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');const {encrypt}=await import('../dist/core/money/encrypt.js');const clinkmod=await import('../dist/core/money/clink.js');const sdkmod=await import('@shocknet/clink-sdk');
let base,a;
before(async()=>{if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_hook_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});a=await r.json()});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});
const hdr=()=>({'Content-Type':'application/json',Authorization:'Bearer '+a.token});
const get=p=>fetch(base+p,{headers:hdr()});const post=(p,b)=>fetch(base+p,{method:'POST',headers:hdr(),body:JSON.stringify(b||{})});

// Structurally valid bolt11 (checksum skipped by the openLN parser) - same
// probe shape the connections suite uses.
const CHARSET='qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const mkBolt11=(hashHex,sats=null)=>{const words=[0,0,0,0,0,0,0];const hw=[];let acc=0,bits=0;for(const b of Buffer.from(hashHex,'hex')){acc=(acc<<8)|b;bits+=8;while(bits>=5){bits-=5;hw.push((acc>>bits)&31);}}if(bits)hw.push((acc<<(5-bits))&31);words.push(1,hw.length>>5,hw.length&31,...hw);return (sats?'lnbc'+(sats*10)+'n':'lnbc')+'1'+words.map(w=>CHARSET[w]).join('')+'qqqqqq';};

let mintCounter=0;
const mkHash=()=>createHash('sha256').update('qa-hook-mint-'+(++mintCounter)).digest('hex');
const stubClient=()=>clinkmod.__setClinkClientFactoryForTests(()=>({requestInvoice:async()=>({bolt11:mkBolt11(mkHash())}),debit:async()=>({res:'ok'}),stop:()=>{}}));
const callHook=(path,query,authorization)=>{const u=new URL(base+path);for(const[k,v]of Object.entries(query))u.searchParams.set(k,v);return fetch(u,authorization?{headers:{Authorization:authorization}}:undefined)};

let hookPath,hookToken,connId;
test('an offer is issued its webhook pair at connect; the list never carries the secret',async()=>{
  stubClient();
  const noffer=sdkmod.nofferEncode({pubkey:'a'.repeat(64),relay:'wss://relay.example',offer:'qa-offer-token',priceType:2});
  const c=await post('/api/wallet/connect',{connection:noffer});
  assert.equal(c.status,200);const rc=await c.json();
  assert.equal(rc.connection.kind,'noffer');
  assert.ok(rc.webhook&&/^clh_[a-f0-9]{48}$/.test(rc.webhook.token),'connect hands back the bearer token');
  assert.match(rc.webhook.path,/^\/api\/clink\/hook\/[a-f0-9]{24}$/,'the callback URL carries only a public hook id');
  connId=rc.connection.id;hookPath=rc.webhook.path;hookToken=rc.webhook.token;
  const wv=await (await get('/api/connections/'+connId+'/webhook')).json();
  assert.equal(wv.token,hookToken,'Settings reads the same pair back');
  assert.equal(wv.templatePath,hookPath+'{?invoice,amount}','the paste-ready template carries invoice + amount');
  const stored=(await pool.query('SELECT clink_hook_id FROM account_connections WHERE id=$1',[connId])).rows[0];
  assert.equal(stored.clink_hook_id,hookPath.split('/').pop(),'the hook id is persisted');
  const list=await (await get('/api/connections')).json();
  assert.ok(!JSON.stringify(list).includes(hookToken),'the connections list never leaks the bearer secret');
});

test('a wallet push settles a direct sale exactly once; the device sees it paid',async()=>{
  // No platform wallet in the QA env, so wrapping is unavailable - the
  // webhook is what lets this sale happen at all (direct fallback).
  const inv=await post('/api/pos/invoice',{amountSats:250,memo:'qa hook sale'});
  assert.equal(inv.status,201,'a webhook-backed offer sells even when wrapping is unavailable');
  const ib=await inv.json();
  const unauth=await callHook(hookPath,{invoice:ib.bolt11,amount:'250',ok:'true'});
  assert.equal(unauth.status,401,'without the bearer nothing settles');
  const naive=await callHook(hookPath,{invoice:ib.bolt11,amount:'250',ok:'true'},'Bearer '+'clh_'+'f'.repeat(48));
  assert.equal(naive.status,401);
  const hit=await callHook(hookPath,{invoice:ib.bolt11,amount:'250',ok:'true'},'Bearer '+hookToken);
  assert.equal(hit.status,200);assert.equal((await hit.json()).settled,true,'the push settles the sale');
  const row=(await pool.query('SELECT paid_at FROM pending_invoices WHERE payment_hash=$1',[ib.paymentHash])).rows[0];
  assert.ok(row.paid_at,'the direct invoice is settled');
  const st=await (await get('/api/pos/invoice/'+ib.paymentHash+'/status')).json();
  assert.equal(st.status,'paid','the device sees the sale as paid');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM transactions WHERE payment_hash=$1',[ib.paymentHash])).rows[0].n,1,'one receive transaction');
  const again=await callHook(hookPath,{invoice:ib.bolt11,amount:'250'},'Bearer '+hookToken);
  const ab2=await again.json();
  assert.equal(ab2.settled,false);assert.equal(ab2.alreadyPaid,true,'a repeated push is idempotent');
  assert.equal((await pool.query('SELECT count(*)::int AS n FROM transactions WHERE payment_hash=$1',[ib.paymentHash])).rows[0].n,1,'still exactly one transaction');
});

test('a mismatched amount never settles; unknown invoices are acknowledged quietly',async()=>{
  const h=mkHash();const bolt=mkBolt11(h);
  await pool.query("INSERT INTO pending_invoices (account_id,bolt11,payment_hash,amount_sats,origin,expires_at,connection_id) VALUES ($1,$2,$3,100,'web_pos',now()+interval '1 hour',$4)",[a.account.id,bolt,h,connId]);
  const mm=await callHook(hookPath,{invoice:bolt,amount:'7777'},'Bearer '+hookToken);
  assert.equal(mm.status,200);const mb=await mm.json();
  assert.equal(mb.settled,false);assert.equal(mb.reason,'amount');
  assert.equal((await pool.query('SELECT paid_at FROM pending_invoices WHERE payment_hash=$1',[h])).rows[0].paid_at,null,'a mismatched amount blocks settlement');
  assert.ok((await pool.query("SELECT count(*)::int AS n FROM payment_events WHERE event='clink.hook_amount_mismatch' AND payment_hash=$1",[h])).rows[0].n>=1,'the refusal is recorded');
  const un=await callHook(hookPath,{invoice:'lnbc1definitely-not-ours'},'Bearer '+hookToken);
  assert.equal(un.status,200);assert.equal((await un.json()).tracked,false,'an invoice we do not track is acknowledged, not an error');
});

test('a wrapped sale gets corroboration only - the wrap state machine still owns settlement',async()=>{
  const H='44'.repeat(32),MH='55'.repeat(32);const merchantBolt=mkBolt11(MH);
  await pool.query("INSERT INTO pending_invoices (account_id,bolt11,payment_hash,merchant_bolt11,merchant_payment_hash,hold_preimage,amount_sats,origin,wrap_status,wrap_updated_at,expires_at,connection_id) VALUES ($1,'lnbc1qa-hold-hook',$2,$3,$4,$5,250,'web_pos','forwarding',now(),now()+interval '1 hour',$6)",[a.account.id,H,merchantBolt,MH,'66'.repeat(32),connId]);
  const r=await callHook(hookPath,{invoice:merchantBolt,amount:'250'},'Bearer '+hookToken);
  assert.equal(r.status,200);const rb=await r.json();
  assert.equal(rb.settled,false);assert.equal(rb.wrap,'forwarding','the push reports the wrap state, it does not touch it');
  const row=(await pool.query('SELECT paid_at,wrap_status FROM pending_invoices WHERE payment_hash=$1',[H])).rows[0];
  assert.equal(row.paid_at,null,'a wrapped row is never settled from the webhook');
  assert.equal(row.wrap_status,'forwarding','the wrap state machine keeps ownership');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_events WHERE payment_hash=$1 AND event='clink.hook_paid'",[H])).rows[0].n,1,'the independent confirmation is recorded');
});

test('without a webhook the direct fallback keeps refusing; issuing one flips the gate',async()=>{
  const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_hook2_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});
  const b=await r.json();const bh={Authorization:'Bearer '+b.token};
  // A pre-webhook offer: inserted directly, without hook fields (the connect
  // flow always issues a pair now).
  const ptr=sdkmod.nofferEncode({pubkey:'d'.repeat(64),relay:'wss://relay.example',offer:'qa-offer-b',priceType:2});
  const ins=await pool.query("INSERT INTO account_connections (account_id,kind,label,clink_pointer,clink_app_key_encrypted) VALUES ($1,'noffer','CLINK Offer',$2,$3) RETURNING id",[b.account.id,ptr,encrypt('ab'.repeat(32))]);
  await pool.query('UPDATE accounts SET default_connection_id=$2 WHERE id=$1',[b.account.id,ins.rows[0].id]);
  const ref=await fetch(base+'/api/pos/invoice',{method:'POST',headers:{'Content-Type':'application/json',...bh},body:JSON.stringify({amountSats:321})});
  assert.equal(ref.status,503,'no observer -> refuse (policy A)');
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM payment_events WHERE account_id=$1 AND event='wrap.fallback_refused'",[b.account.id])).rows[0].n,1,'the refusal is recorded');
  const wv=await (await fetch(base+'/api/connections/'+ins.rows[0].id+'/webhook',{headers:bh})).json();
  assert.ok(wv.token.startsWith('clh_'),'Settings issuance works lazily for pre-existing offers');
  const inv=await fetch(base+'/api/pos/invoice',{method:'POST',headers:{'Content-Type':'application/json',...bh},body:JSON.stringify({amountSats:321})});
  assert.equal(inv.status,201,'with the webhook issued, the same offer sells directly');
});
