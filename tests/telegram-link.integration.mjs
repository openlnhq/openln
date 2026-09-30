import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
process.env.TELEGRAM_LINK_SECRET=process.env.TELEGRAM_LINK_SECRET||('qa_'+randomBytes(12).toString('hex'));
process.env.PORT='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');
const SECRET=process.env.TELEGRAM_LINK_SECRET;
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});let base,a,b,tgA=0,tgB=0;
async function call(path,method='GET',body,token){const useTok=token===undefined?a?.token:token;const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(useTok?{Authorization:'Bearer '+useTok}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()}}
async function bot(path,body,secret=SECRET){const r=await fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json','x-openln-bot-secret':secret},body:JSON.stringify(body)});return{status:r.status,data:await r.json()}}
async function reg(){const handle='qa_tg_'+randomBytes(5).toString('hex');const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle,password:randomBytes(20).toString('hex')})});assert.equal(r.status,201);return{...await r.json(),handle}}
async function mint(token){return call('/api/telegram/link-code','POST',{},token)}
before(async()=>{await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;a=await reg();b=await reg()});
after(async()=>{for(const acc of [a,b]){if(!acc)continue;const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[acc.account.id])).rows[0];if(e)await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id])}await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});

test('linking routes require a session and the claim requires the bot secret',async()=>{
  assert.equal((await call('/api/telegram/link-code','POST',{},null)).status,401);
  assert.equal((await call('/api/telegram/status','GET',undefined,null)).status,401);
  assert.equal((await call('/api/telegram/unlink','POST',{},null)).status,401);
  assert.equal((await bot('/api/telegram/claim',{code:'ZZZZZZZZ',telegram_user_id:1},'wrong-secret')).status,403);
  const noHeader=await fetch(base+'/api/telegram/claim',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'ZZZZZZZZ',telegram_user_id:1})});
  assert.equal(noHeader.status,403);
});

test('connect flow: mint code, claim by the bot, status shows the link, unlink clears it',async()=>{
  const s=await call('/api/telegram/status');assert.equal(s.status,200);assert.equal(s.data.linked,false);assert.equal(s.data.handle,a.handle);
  const m=await mint();assert.equal(m.status,200);
  assert.match(m.data.code,/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
  assert.equal(m.data.url,'https://t.me/openLN_bot?start=link_'+m.data.code);
  assert.equal(m.data.expiresInSeconds,900);
  tgA=900000000+Math.floor(Math.random()*99999999);
  const c=await bot('/api/telegram/claim',{code:m.data.code,telegram_user_id:tgA,username:'qa_linked',first_name:'Qa'});
  assert.equal(c.status,200);assert.equal(c.data.ok,true);assert.equal(c.data.handle,a.handle);
  const reuse=await bot('/api/telegram/claim',{code:m.data.code,telegram_user_id:tgA+1,username:'qa_other'});
  assert.equal(reuse.status,400);assert.equal(reuse.data.error,'invalid_code');
  const again=await bot('/api/telegram/claim',{code:m.data.code,telegram_user_id:tgA,username:'qa_linked'});
  assert.equal(again.status,200);assert.equal(again.data.handle,a.handle);
  const st=await call('/api/telegram/status');assert.equal(st.data.linked,true);assert.equal(st.data.username,'qa_linked');assert.equal(st.data.handle,a.handle);
  const row=(await sql.query('SELECT telegram_user_id FROM telegram_links WHERE entity_id=(SELECT entity_id FROM accounts WHERE id=$1)',[a.account.id])).rows[0];
  assert.equal(Number(row.telegram_user_id),tgA);
  assert.equal((await call('/api/telegram/unlink','POST',{})).status,200);
  assert.equal((await call('/api/telegram/status')).data.linked,false);
  const m2=await mint();const c2=await bot('/api/telegram/claim',{code:m2.data.code,telegram_user_id:tgA,username:'qa_linked'});
  assert.equal(c2.status,200,'the telegram id is free again after unlink');
});

test('a telegram user cannot link to a second account; re-connecting an account replaces its telegram user',async()=>{
  const mB=await mint(b.token);
  const cB=await bot('/api/telegram/claim',{code:mB.data.code,telegram_user_id:tgA,username:'qa_linked'});
  assert.equal(cB.status,409);assert.equal(cB.data.error,'telegram_already_linked');
  tgB=900000000+Math.floor(Math.random()*99999999);
  const mA=await mint();const cA=await bot('/api/telegram/claim',{code:mA.data.code,telegram_user_id:tgB,username:'qa_relinked'});
  assert.equal(cA.status,200);assert.equal(cA.data.handle,a.handle);
  const rowA=(await sql.query("SELECT telegram_user_id FROM telegram_links WHERE entity_id=(SELECT entity_id FROM accounts WHERE id=$1)",[a.account.id])).rows[0];
  assert.equal(Number(rowA.telegram_user_id),tgB,'re-connect replaces the previous telegram user');
  const cB2=await bot('/api/telegram/claim',{code:mB.data.code,telegram_user_id:tgA,username:'qa_linked'});
  assert.equal(cB2.status,200,'the replaced telegram id is free for another account');
  assert.equal(cB2.data.handle,b.handle);
});

test('expired and malformed codes are rejected',async()=>{
  const acc=(await sql.query('SELECT entity_id FROM accounts WHERE id=$1',[a.account.id])).rows[0];
  await sql.query("INSERT INTO telegram_link_codes(code, entity_id, expires_at) VALUES('ZZZZZZZZ',$1, now() - interval '5 minutes')",[acc.entity_id]);
  const exp=await bot('/api/telegram/claim',{code:'zzzzzzzz',telegram_user_id:111111});
  assert.equal(exp.status,400);assert.equal(exp.data.error,'invalid_code');
  for(const bad of [{code:'BAD',telegram_user_id:111111},{code:'OOOOOOOO',telegram_user_id:111111},{code:'ABCDEFGH',telegram_user_id:-5},{code:'ABCDEFGH',telegram_user_id:'x'}]){
    assert.equal((await bot('/api/telegram/claim',bad)).status,400,JSON.stringify(bad));
  }
});
