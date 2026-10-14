// Admin mail console: auth gate, not-configured behavior, and the
// fail-closed path when the mail host is unreachable. Real IMAP/SMTP behavior
// is covered live on dev (no mail server in CI).
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
process.env.PORT='0';
const SUF=randomBytes(4).toString('hex');
const ADMIN_SECRET='qa-mail-'+SUF;
const ADMIN_HANDLE='qa_mailadmin_'+SUF;
process.env.ADMIN_SECRET=ADMIN_SECRET;
process.env.ADMIN_HANDLES=ADMIN_HANDLE;
process.env.SESSION_SECRET='qa-mail-session-'+SUF;
for(const k of ['MAIL_IMAP_HOST','MAIL_IMAP_PORT','MAIL_SMTP_HOST','MAIL_SMTP_PORT','MAIL_USER','MAIL_PASS','MAIL_FROM'])delete process.env[k];
const {default:server}=await import('../dist/core/server.js');
const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});
let base,a,c;
async function call(path,method='GET',body,token,extra={}){const useTok=token===undefined?a?.token:token;const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(useTok?{Authorization:'Bearer '+useTok}:{}),...extra},...(body===undefined?{}:{body:JSON.stringify(body)})});let data=null;try{data=await r.json()}catch{}return{status:r.status,data}}
async function reg(handle){const h=handle||('qa_mail_'+randomBytes(5).toString('hex'));const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:h,password:randomBytes(20).toString('hex')})});assert.equal(r.status,201);return r.json()}
const adm=(path,method='GET',body,token)=>call(path,method,body,token,{'X-Admin-Secret':ADMIN_SECRET});

before(async()=>{
  await sql.connect();
  if(!server.listening)await once(server,'listening');
  base='http://127.0.0.1:'+server.address().port;
  a=await reg();c=await reg(ADMIN_HANDLE);
});

after(async()=>{
  for(const acc of [a,c]){if(!acc)continue;try{const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[acc.account.id])).rows[0];if(e)await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id])}catch{}}
  await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();
});

test('mail routes sit behind the same admin gate as the rest of the console',async()=>{
  assert.equal((await call('/api/admin/mail','GET',undefined,null)).status,401);
  assert.equal((await call('/api/admin/mail','GET',undefined,a.token)).status,403);
});

test('without MAIL_* configuration every route answers 503 not_configured',async()=>{
  for(const [p,m,b] of [['/api/admin/mail','GET'],['/api/admin/mail/folders','GET'],['/api/admin/mail/message?uid=1','GET'],['/api/admin/mail/send','POST',{to:'a@b.co',text:'x'}],['/api/admin/mail/delete','POST',{uid:1}]]){
    const r=await adm(p,m,b);
    assert.equal(r.status,503,p+' -> 503');
    assert.equal(r.data.code,'not_configured',p+' -> not_configured');
  }
  // the allowlisted admin session passes the gate to the same config answer
  const r=await call('/api/admin/mail','GET',undefined,c.token);
  assert.equal(r.status,503);
});

test('an unreachable mail host fails closed with a readable error',async()=>{
  process.env.MAIL_IMAP_HOST='127.0.0.1';process.env.MAIL_IMAP_PORT='9';
  process.env.MAIL_SMTP_HOST='127.0.0.1';process.env.MAIL_SMTP_PORT='9';
  process.env.MAIL_USER='qa@example.com';process.env.MAIL_PASS='x';
  try{
    const r=await adm('/api/admin/mail','GET');
    assert.equal(r.status,502);
    assert.match(String(r.data.error),/not reachable|did not answer/i);
    // and an unknown mail path is a plain 404 once the config gate passes
    const r2=await adm('/api/admin/mail','POST',{});
    assert.equal(r2.status,404);
  }finally{
    for(const k of ['MAIL_IMAP_HOST','MAIL_IMAP_PORT','MAIL_SMTP_HOST','MAIL_SMTP_PORT','MAIL_USER','MAIL_PASS'])delete process.env[k];
  }
});
