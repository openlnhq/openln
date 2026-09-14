// Child process for restart recovery tests. Real routes/DB, explicit offline wallet.
import {mock} from 'node:test';
import {createServer} from 'node:http';
import {pathToFileURL} from 'node:url';
import {OfflineNWCClient,walletFixture} from './ric-wallet.mjs';
if(!process.env.DATABASE_URL||!new URL(process.env.DATABASE_URL).pathname.startsWith('/openln_qa_'))throw Error('Scratch DB required');
mock.module('@getalby/sdk',{namedExports:{NWCClient:OfflineNWCClient}});
const dist=pathToFileURL(process.env.RIC_TEST_DIST.replace(/\/$/,'')+'/');
const {handleRicPaymentRoute}=await import(new URL('plugins/ric-payment-routes.js',dist));
const {AuthService}=await import(new URL('core/auth/service.js',dist));
const {pool}=await import(new URL('core/db/index.js',dist));
const auth=new AuthService();
const server=createServer(async(req,res)=>{try{const token=String(req.headers.authorization||'').replace(/^Bearer /,'');const account=token?await auth.authenticate(token):undefined;if(await handleRicPaymentRoute(req,res,new URL(req.url,'http://localhost'),account))return;res.writeHead(404);res.end('{}');}catch{res.writeHead(503);res.end('{}');}});
process.on('message',message=>{
 if(message.type==='start'){
  for(const [key,value] of message.outcomes||[])walletFixture.outcomes.set(key,value);
  server.listen(0,'127.0.0.1',()=>process.send({type:'ready',port:server.address().port}));
 }
 if(message.type==='stop')server.closeAllConnections(),server.close(async()=>{await pool.end();process.exit(0);});
});
