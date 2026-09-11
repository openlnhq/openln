import test from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import {randomBytes} from 'node:crypto';import pg from 'pg';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch only');
process.env.PORT='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');
if(!server.listening)await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});await sql.connect();let a;
async function call(path,method='GET',body,token){const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()};}
test.after(async()=>{if(a){const aid=a.account.id;await sql.query('DELETE FROM device_tokens WHERE account_id=$1',[aid]);const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[aid])).rows[0];await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id]);}await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();});
test('a stolen RIC credential cannot change merchant security or bypass the six-digit send gate',async()=>{
 const password=randomBytes(20).toString('hex');a=(await call('/api/auth/register','POST',{handle:'qa_scope_'+randomBytes(5).toString('hex'),password})).data;
 const d=await call('/api/accounts/'+a.account.id+'/device-tokens','POST',{label:'Scope test'},a.token);const dt=d.data.token;
 assert.equal((await call('/api/account/send-pin','POST',{newPin:'123456'},dt)).status,403,'device cannot set merchant Send PIN');
 assert.equal((await call('/api/wallet/pay','POST',{bolt11:'test'},dt)).status,403,'device cannot bypass merchant send PIN using browser endpoint');
 assert.equal((await call('/api/accounts/'+a.account.id+'/device-tokens','POST',{label:'backdoor'},dt)).status,403,'device cannot mint credentials');
 assert.equal((await call('/api/account/settings','PUT',{currency:'eur'},dt)).status,403);
 assert.equal((await call('/api/me','GET',undefined,dt)).status,403);
 assert.equal((await call('/api/pos/config','GET',undefined,dt)).status,200);
 const hello={firmwareVersion:'1.0.4',board:'esp32-2432s028r',partitionLayout:'ric-ab-v1',mac:'02:00:00:00:00:01',bootId:'scope-test',uptimeMs:1};
 assert.equal((await call('/api/ric/hello','POST',hello,dt)).status,200);
 assert.equal((await call('/api/account/send-pin','POST',{newPin:'123456'},a.token)).status,200,'browser retains security settings');
});
