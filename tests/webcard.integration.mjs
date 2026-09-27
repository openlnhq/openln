import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import pg from 'pg';

if (!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_')) throw Error('Scratch database required');
process.env.PORT='0';
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});
const Z='0'.repeat(32),ZC='0'.repeat(16),ZK='0'.repeat(64);
let base,a,device;
async function call(path,{token=a?.token,method='GET',body}={}){
  const r=await fetch(base+path,{method,headers:{...(token?{Authorization:'Bearer '+token}:{}),'Content-Type':'application/json'},...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const text=await r.text();let data;try{data=JSON.parse(text)}catch{data=text}
  return {status:r.status,data,headers:r.headers};
}
const issue=async()=>{const r=await call('/api/accounts/'+a.account.id+'/cards',{method:'POST',body:{name:'Phone card',note:'Web NFC test',pin:'1357',perTapLimitSats:5000,dailyLimitSats:10000}});assert.equal(r.status,201);return r.data.cardId};
const markWeb=async(cardId)=>{const r=await call('/api/pos/mark-written/'+cardId,{method:'POST',body:{mode:'web'}});assert.equal(r.status,200)};
before(async()=>{
  await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;
  const r=await call('/api/auth/register',{token:null,method:'POST',body:{handle:'qa_web_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')}});assert.equal(r.status,201);a=r.data;
  const d=await call('/api/accounts/'+a.account.id+'/device-tokens',{method:'POST',body:{label:'QA web NFC'}});device=d.data.token;
});
after(async()=>{
  await sql.end();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await pool.end();
});

test('the phone write pulls a plain placeholder link, not key material',async()=>{
  const cardId=await issue();
  const r=await call('/api/cards/'+cardId+'/nfc-url',{method:'POST',body:{}});
  assert.equal(r.status,200);
  assert.match(r.data.url,new RegExp('^lnurlw://[^/]+/card/'+cardId+'\\?p='+Z+'&c='+ZC+'$'));
  assert.ok(!('k0' in r.data),'no key material is sent to the browser');
});

test('a card written from a phone (web) accepts its zero-p/c tap and issues a real k1',async()=>{
  const cardId=await issue();
  await markWeb(cardId);
  const row=await sql.query('select write_mode,last_used_at from cards where id=$1',[cardId]);
  assert.equal(row.rows[0].write_mode,'web');
  assert.ok(row.rows[0].last_used_at,'a web write marks the card written');
  const tap=await call('/card/'+cardId+'?p='+Z+'&c='+ZC,{token:null});
  assert.equal(tap.data.tag,'withdrawRequest');
  assert.match(tap.data.k1,/^[0-9a-f]{32}$/);
  assert.notEqual(tap.data.k1,Z);
  assert.match(tap.data.callback,new RegExp('/card/'+cardId+'/callback$'));
  const pend=await sql.query('select pending_k1 from cards where id=$1',[cardId]);
  assert.equal(pend.rows[0].pending_k1,tap.data.k1,'k1 is stored for the callback to consume');
});

test('a web card with no p/c at all still taps (plain link)',async()=>{
  const cardId=await issue();
  await markWeb(cardId);
  const tap=await call('/card/'+cardId,{token:null});
  assert.equal(tap.data.tag,'withdrawRequest');
  assert.match(tap.data.k1,/^[0-9a-f]{32}$/);
});

test('regression: on a SUN card, zero p/c stays a provisioning probe with the dummy k1',async()=>{
  const cardId=await issue();
  const tap=await call('/card/'+cardId+'?p='+Z+'&c='+ZC,{token:null});
  assert.equal(tap.data.tag,'withdrawRequest');
  assert.equal(tap.data.k1,ZK,'probe k1 stays all-zero (64 chars) and non-payable');
  const pend=await sql.query('select pending_k1 from cards where id=$1',[cardId]);
  assert.equal(pend.rows[0].pending_k1,null,'no k1 is stored for a probe');
});

test('regression: garbage SUN data is still rejected on a SUN card',async()=>{
  const cardId=await issue();
  const tap=await call('/card/'+cardId+'?p='+'ab'.repeat(16)+'&c='+'cd'.repeat(8),{token:null});
  assert.equal(tap.data.status,'ERROR');
});

test('web card: wipe data is the factory zeros (the chip was never keyed)',async()=>{
  const cardId=await issue();
  await markWeb(cardId);
  const r=await call('/api/cards/'+cardId+'/wipe',{method:'POST',body:{}});
  assert.equal(r.status,200);
  for(const k of ['k0','k1','k2','k3','k4'])assert.equal(r.data.wipeKeys[k],Z);
  const dev=await call('/api/pos/wipe-keys/'+cardId,{token:device});
  assert.equal(dev.status,200);
  for(const k of ['k0','k1','k2','k3','k4'])assert.equal(dev.data[k],Z);
});

test('web card: mark-wiped cancels it and taps are refused afterwards',async()=>{
  const cardId=await issue();
  await markWeb(cardId);
  const w=await call('/api/pos/mark-wiped/'+cardId,{method:'POST',body:{}});
  assert.equal(w.status,200);
  const tap=await call('/card/'+cardId+'?p='+Z+'&c='+ZC,{token:null});
  assert.equal(tap.data.status,'ERROR');
});
