import test,{before,after} from 'node:test';import assert from 'node:assert/strict';import {once} from 'node:events';import http from 'node:http';
if(!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch only');process.env.PORT='0';process.env.WRAP_DRIVER_ENABLED='0';const {default:server}=await import('../dist/core/server.js');const {pool}=await import('../dist/core/db/index.js');let base,port;
before(async()=>{if(!server.listening)await once(server,'listening');port=server.address().port;base='http://127.0.0.1:'+port});
after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await pool.end()});
// fetch() cannot set Host, and robots.txt depends on it, so use node:http here.
const getAs=(path,host)=>new Promise((resolve,reject)=>{http.get({host:'127.0.0.1',port,path,headers:{host}},r=>{let body='';r.setEncoding('utf8');r.on('data',c=>body+=c);r.on('end',()=>resolve({status:r.statusCode,type:r.headers['content-type'],body}))}).on('error',reject)});
test('robots.txt: prod is indexable, every other host is not',async()=>{
  const prod=await getAs('/robots.txt','openln.com');
  assert.equal(prod.status,200);assert.match(prod.type,/^text\/plain/);
  assert.match(prod.body,/^Allow: \/$/m);assert.match(prod.body,/^Sitemap: https:\/\/openln\.com\/sitemap\.xml$/m);
  const dev=await getAs('/robots.txt','dev.openln.com');
  assert.equal(dev.body,'User-agent: *\nDisallow: /\n');
});
test('sitemap.xml lists the landing page',async()=>{
  const r=await fetch(base+'/sitemap.xml');assert.equal(r.status,200);
  assert.match(r.headers.get('content-type')||'',/^application\/xml/);
  assert.match(await r.text(),/<loc>https:\/\/openln\.com\/<\/loc>/);
});
test('favicon.ico answers with the brand PNG',async()=>{
  const r=await fetch(base+'/favicon.ico');assert.equal(r.status,200);assert.equal(r.headers.get('content-type'),'image/png');
  assert.equal(Buffer.from(await r.arrayBuffer()).subarray(1,4).toString(),'PNG');
});
test('media serves SVG and WOFF2 with real types (nosniff blocks an SVG sent as octet-stream)',async()=>{
  const svg=await fetch(base+'/media/brand/favicon.svg');assert.equal(svg.status,200);assert.equal(svg.headers.get('content-type'),'image/svg+xml');
  const font=await fetch(base+'/media/fonts/archivo-latin.woff2');assert.equal(font.status,200);assert.equal(font.headers.get('content-type'),'font/woff2');
});
