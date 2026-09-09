import type {IncomingMessage,ServerResponse} from "node:http";
import {readFile,stat} from "node:fs/promises";
import {resolve,extname} from "node:path";

/** Read-only preview of the pinned Cards UI. Never proxies shop writes/auth. */
export async function handleCardsPreview(req:IncomingMessage,res:ServerResponse,u:URL):Promise<boolean>{
 if(!u.pathname.startsWith('/cards-preview'))return false;
 if(req.method!=='GET'){res.writeHead(405,{'content-type':'application/json'});res.end(JSON.stringify({error:'Read-only Cards preview'}));return true;}
 if(u.pathname==='/cards-preview'){res.writeHead(302,{location:'/cards-preview/'});res.end();return true;}
 if(u.pathname.startsWith('/cards-preview/api/')){
  const path=u.pathname.slice('/cards-preview'.length);
  if(!/^\/api\/(?:products|catalog|btc-rate|price|creators|status)(?:\/|$)/.test(path)){
   res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:'Use cards.openln.com for your account'}));return true;
  }
  try{const upstream=await fetch('https://cards.openln.com'+path+u.search,{signal:AbortSignal.timeout(10000)});res.writeHead(upstream.status,{'content-type':upstream.headers.get('content-type')||'application/json','cache-control':'no-store'});res.end(Buffer.from(await upstream.arrayBuffer()));}
  catch{res.writeHead(502,{'content-type':'application/json'});res.end(JSON.stringify({error:'Catalog unavailable'}));}
  return true;
 }
 const root=resolve(process.cwd(),'artifacts/cards-shop/current/preview');
 const relative=decodeURIComponent(u.pathname.slice('/cards-preview/'.length));let path=resolve(root,relative||'index.html');
 if(path!==root&&!path.startsWith(root+'/')){res.writeHead(404);res.end();return true;}
 try{if((await stat(path)).isDirectory())path=resolve(path,'index.html');}catch{if(!extname(path))path=resolve(root,'index.html');}
 try{const data=await readFile(path);const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.webp':'image/webp','.jpg':'image/jpeg','.woff2':'font/woff2'};res.writeHead(200,{'content-type':mime[extname(path)]||'application/octet-stream','cache-control':'no-store','x-robots-tag':'noindex, nofollow'});res.end(data);}
 catch{res.writeHead(404,{'content-type':'text/plain'});res.end('Cards preview not installed');}
 return true;
}
