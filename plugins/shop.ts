import type {IncomingMessage,ServerResponse} from "node:http";
const partners=[{id:"johannesburg",name:"Johannesburg",region:"South Africa",status:"active"},{id:"thailand",name:"Thailand",region:"Thailand",status:"active"},{id:"satoshi-si",name:"satoshi.si",region:"Europe",status:"pending"}];
export function handleShopRoute(req:IncomingMessage,res:ServerResponse,u:URL):boolean{if(req.method!=="GET"||u.pathname!=="/api/shop/partners")return false;res.writeHead(200,{"content-type":"application/json"});res.end(JSON.stringify({partners}));return true;}
