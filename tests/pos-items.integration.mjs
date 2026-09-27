import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import pg from 'pg';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
process.env.PORT='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');
const sql=new pg.Client({connectionString:process.env.DATABASE_URL});let base,a,b;
async function call(path,method='GET',body,token){const useTok=token===undefined?a?.token:token;const r=await fetch(base+path,{method,headers:{'Content-Type':'application/json',...(useTok?{Authorization:'Bearer '+useTok}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return{status:r.status,data:await r.json()}}
async function reg(){const r=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:'qa_pos_'+randomBytes(5).toString('hex'),password:randomBytes(20).toString('hex')})});assert.equal(r.status,201);return r.json()}
before(async()=>{await sql.connect();if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port;a=await reg();b=await reg()});
after(async()=>{for(const acc of [a,b]){if(!acc)continue;const e=(await sql.query('DELETE FROM accounts WHERE id=$1 RETURNING entity_id',[acc.account.id])).rows[0];if(e)await sql.query('DELETE FROM entities WHERE id=$1',[e.entity_id])}await sql.end();server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});
test('item routes require a session and start empty',async()=>{
  assert.equal((await call('/api/pos/items','GET',undefined,null)).status,401);
  const r=await call('/api/pos/items');assert.equal(r.status,200);assert.deepEqual(r.data.items,[]);
});
test('create, list, update and delete an item',async()=>{
  const created=await call('/api/pos/items','POST',{name:'Cola',price:25,description:'Chilled can',photo:'data:image/jpeg;base64,AAAA'});
  assert.equal(created.status,201);assert.equal(created.data.item.name,'Cola');assert.equal(created.data.item.price,'25');assert.equal(created.data.item.photo,'data:image/jpeg;base64,AAAA');
  const list=await call('/api/pos/items');assert.equal(list.status,200);assert.equal(list.data.items.length,1);
  const id=created.data.item.id;
  const upd=await call('/api/pos/items/'+id,'PATCH',{price:26.5});assert.equal(upd.status,200);assert.equal(upd.data.item.price,'26.5');
  const cleared=await call('/api/pos/items/'+id,'PATCH',{photo:null,description:''});assert.equal(cleared.status,200);assert.equal(cleared.data.item.photo,null);assert.equal(cleared.data.item.description,null);
  const del=await call('/api/pos/items/'+id,'DELETE');assert.equal(del.status,200);assert.equal((await call('/api/pos/items')).data.items.length,0);
});
test('invalid input is rejected',async()=>{
  const bad=[{price:10},{name:'X'},{name:'Y',price:0},{name:'Y',price:'abc'},{name:'Y',price:10,photo:'data:text/plain;base64,AAAA'},{name:'Y',price:10,description:'x'.repeat(201)},{name:'Y',price:10,photo:'data:image/png;base64,'+'A'.repeat(70000)}];
  for(const payload of bad)assert.equal((await call('/api/pos/items','POST',payload)).status,400,String(JSON.stringify(payload).slice(0,50)));
});
test('items are isolated per account and unknown ids are not found',async()=>{
  const c=await call('/api/pos/items','POST',{name:'Soup',price:40});assert.equal(c.status,201);const id=c.data.item.id;
  assert.equal((await call('/api/pos/items','GET',undefined,b.token)).data.items.length,0,'other accounts see nothing');
  assert.equal((await call('/api/pos/items/'+id,'PATCH',{price:1},b.token)).status,404);
  assert.equal((await call('/api/pos/items/'+id,'DELETE',undefined,b.token)).status,404);
  assert.equal((await call('/api/pos/items/not-a-uuid','DELETE')).status,404);
  assert.equal((await call('/api/pos/items/'+id,'DELETE')).status,200);
});
