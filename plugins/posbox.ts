import type { IncomingMessage,ServerResponse } from "node:http";
import { eq } from "drizzle-orm";
import { db,posboxDevicesTable } from "../core/db/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const json=(r:ServerResponse,s:number,b:unknown)=>{r.writeHead(s,{"content-type":"application/json"});r.end(JSON.stringify(b));return true;};
async function body(req:IncomingMessage){let x="";for await(const c of req)x+=c;return JSON.parse(x||"{}");}
export async function handlePosboxRoute(req:IncomingMessage,res:ServerResponse,u:URL,account:{id:string}|undefined):Promise<boolean>{
 if(u.pathname==="/api/posbox/firmware"&&req.method==="GET"){try{const data=await readFile(join(process.cwd(),"firmware","posbox-latest.bin"));res.writeHead(200,{"content-type":"application/octet-stream","content-length":data.length,"content-disposition":"attachment; filename=posbox-latest.bin"});res.end(data);}catch{return json(res,404,{error:"Firmware unavailable"});}return true;}
 if(u.pathname!=="/api/posbox/devices")return false; if(req.method!=="POST")return json(res,405,{error:"Method not allowed"});
 const v=await body(req);const mac=String(v.mac??v.macAddress??"").trim().toUpperCase();const claimCode=String(v.claimCode??"").trim()||null;
 if(!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac))return json(res,400,{error:"Invalid MAC address"});
 const [existing]=await db.select().from(posboxDevicesTable).where(eq(posboxDevicesTable.mac,mac));
 if(existing&&existing.accountId!==account?.id)return json(res,409,{error:"Device already registered",deviceId:existing.id});
 if(existing)return json(res,200,{deviceId:existing.id,mac:existing.mac,claimCode:existing.claimCode,registeredAt:existing.createdAt});
 const [device]=await db.insert(posboxDevicesTable).values({accountId:account?.id??null,mac,claimCode}).returning();return json(res,201,{deviceId:device.id,mac:device.mac,claimCode:device.claimCode,registeredAt:device.createdAt});
}
