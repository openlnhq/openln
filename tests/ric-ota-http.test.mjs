import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
process.env.DATABASE_URL ||= 'postgresql://127.0.0.1/openln_test';
const {handlePosboxRoute}=await import('../dist/plugins/posbox.js');
const {pool}=await import('../dist/core/db/index.js');
test('legacy OTA check releases its TLS socket before the download', async()=>{
  const server=createServer(async(req,res)=>{await handlePosboxRoute(req,res,new URL(req.url,'http://localhost'),{id:'test-metadata-only'});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try{
    const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/firmware/posbox-version');
    const text=await r.text();assert.equal(r.status,200);
    assert.equal(r.headers.get('connection'),'close','ESP32 HTTPClient.end() keeps a keep-alive TLS socket; legacy updater runs out of memory opening its third TLS session');
    assert.equal(Number(r.headers.get('content-length')),Buffer.byteLength(text));
    assert.match(r.headers.get('cache-control'),/no-store/);
    assert.match(JSON.parse(text).version,/^\d+\.\d+\.\d+$/);
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end();}
});
