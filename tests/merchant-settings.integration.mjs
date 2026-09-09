import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
process.env.PORT='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});let base,a,device;
async function call(path,body,token=a?.token){const r=await fetch(base+path,{method:body===undefined?'GET':'PUT',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,data:await r.json()}}
before(async()=>{await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;let r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_rates_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});assert.equal(r.status,201);a=await r.json();r=await fetch(base+'/api/accounts/'+a.account.id+'/device-tokens',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+a.token},body:JSON.stringify({label:'Rates test RIC'})});device=(await r.json()).token;});
after(async()=>{if(a){await sql.query('DELETE FROM device_tokens WHERE account_id=$1',[a.account.id]);const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[a.account.id])).rows[0];await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id])}await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});
test('ZAR settings persist and both RIC directions plus price source are delivered',async()=>{assert.equal((await call('/api/account/settings',{currency:'zar',rateSource:'binance',rateModifier:'ZAR*1.02',sendRateModifier:'ZAR*0.98'})).status,200);const saved=await call('/api/account/settings');assert.equal(saved.data.currency,'zar');const config=await call('/api/pos/config',undefined,device);assert.equal(config.status,200);assert.deepEqual(config.data,{currency:'zar',rateSource:'binance',rateModifier:'ZAR*1.02',sendRateModifier:'ZAR*0.98'});assert.equal((await call('/api/pos/config',undefined,null)).status,401)});

test('invalid rate edits are rejected atomically; sats remains a valid display unit',async()=>{
  for(const body of [{currency:'???'},{rateSource:'unknown'},{currency:'zar',rateModifier:'ZAR*nope'},{sendRateModifier:'ZAR*-1'}])assert.equal((await call('/api/account/settings',body)).status,400);
  assert.equal((await call('/api/account/settings',{currency:'sats',rateModifier:'',sendRateModifier:''})).status,200);
  assert.equal((await call('/api/account/settings')).data.currency,'sats');
});
