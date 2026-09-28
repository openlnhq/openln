import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch only');process.env.PORT='0';process.env.WRAP_DRIVER_ENABLED='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');let base;
before(async()=>{if(!server.listening)await once(server,'listening');base='http://127.0.0.1:'+server.address().port});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});
test('media subfolders are served and traversal is rejected',async()=>{
  const ok=await fetch(base+'/media/compat/alby.png');
  assert.equal(ok.status,200,'wallet logos in /media subfolders must be served');
  assert.equal(ok.headers.get('content-type'),'image/png');
  const flat=await fetch(base+'/media/minimal.webp');
  assert.equal(flat.status,200,'flat media files keep working');
  const jsqr=await fetch(base+'/media/jsqr.mjs');
  assert.equal(jsqr.status,200,'the vendored send-scanner decoder must be served');
  assert.match(jsqr.headers.get('content-type')||'',/javascript/i);
  const zx=await fetch(base+'/media/zxing.mjs');
  assert.equal(zx.status,200,'the zxing-wasm decoder bundle must be served');
  assert.match(zx.headers.get('content-type')||'',/javascript/i);
  const zxw=await fetch(base+'/media/zxing_reader.wasm');
  assert.equal(zxw.status,200,'the zxing-wasm binary must be served');
  assert.equal(zxw.headers.get('content-type'),'application/wasm');
  for(const bad of ['/media/','/media/nope.png','/media/..%2f..%2fetc%2fpasswd','/media/compat/..%2f..%2fcore%2fserver.ts','/media/%2e%2e%2f%2e%2e%2fetc%2fpasswd'])
    assert.equal((await fetch(base+bad)).status,404,`must reject ${bad}`);
});
