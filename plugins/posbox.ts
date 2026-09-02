import type { IncomingMessage,ServerResponse } from "node:http";
import { eq,and,isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db,posboxDevicesTable,deviceTokensTable,accountsTable } from "../core/db/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const json=(r:ServerResponse,s:number,b:unknown)=>{r.writeHead(s,{"content-type":"application/json"});r.end(JSON.stringify(b));return true;};
async function body(req:IncomingMessage){let x="";for await(const c of req)x+=c;return JSON.parse(x||"{}");}

/** RIC device is "online" if it made an authenticated API call within the last 10 minutes. */
function isOnline(lastUsedAt: Date | null): boolean {
  if (!lastUsedAt) return false;
  return Date.now() - new Date(lastUsedAt).getTime() < 10 * 60 * 1000;
}

export async function handlePosboxRoute(req:IncomingMessage,res:ServerResponse,u:URL,account:{id:string}|undefined):Promise<boolean>{
 if(u.pathname==="/api/posbox/firmware"&&req.method==="GET"){try{const data=await readFile(join(process.cwd(),"firmware","posbox-latest.bin"));res.writeHead(200,{"content-type":"application/octet-stream","content-length":data.length,"content-disposition":"attachment; filename=ric-latest.bin"});res.end(data);}catch{return json(res,404,{error:"Firmware unavailable"});}return true;}

 // RIC device tokens: account-scoped auth tokens issued when a user links a RIC to their account (verbatim from bitPOS device_tokens)
 const dtAccountPath=u.pathname.match(/^\/api\/accounts\/([^/]+)\/device-tokens$/);
 if(dtAccountPath&&(req.method==="GET"||req.method==="POST")){
  if(!account||account.id!==dtAccountPath[1])return json(res,403,{error:"Forbidden"});
  if(req.method==="GET"){
   const rows=await db.select({id:deviceTokensTable.id,label:deviceTokensTable.label,lastUsedAt:deviceTokensTable.lastUsedAt,createdAt:deviceTokensTable.createdAt}).from(deviceTokensTable).where(and(eq(deviceTokensTable.accountId,account.id),isNull(deviceTokensTable.revokedAt)));
   return json(res,200,rows.map(r=>({...r,online:isOnline(r.lastUsedAt)})));
  }
  const [acc]=await db.select({id:accountsTable.id}).from(accountsTable).where(eq(accountsTable.id,account.id));
  if(!acc)return json(res,404,{error:"Account not found"});
  const v=await body(req);
  const label=typeof v.label==="string"&&v.label.trim()?v.label.trim().slice(0,80):"RIC";
  const token=randomBytes(32).toString("hex");
  const [created]=await db.insert(deviceTokensTable).values({accountId:account.id,token,label}).returning({id:deviceTokensTable.id,label:deviceTokensTable.label,createdAt:deviceTokensTable.createdAt});
  return json(res,201,{id:created.id,token,label:created.label,createdAt:created.createdAt});
 }
 const dtRevoke=u.pathname.match(/^\/api\/accounts\/([^/]+)\/device-tokens\/([^/]+)$/);
 if(dtRevoke&&req.method==="DELETE"){
  if(!account||account.id!==dtRevoke[1])return json(res,403,{error:"Forbidden"});
  const [updated]=await db.update(deviceTokensTable).set({revokedAt:new Date()}).where(and(eq(deviceTokensTable.id,dtRevoke[2]),eq(deviceTokensTable.accountId,account.id),isNull(deviceTokensTable.revokedAt))).returning({id:deviceTokensTable.id});
  if(!updated)return json(res,404,{error:"Token not found or already revoked"});
  return json(res,200,{ok:true});
 }

 if(u.pathname!=="/api/posbox/devices")return false; if(req.method!=="POST")return json(res,405,{error:"Method not allowed"});
 const v=await body(req);const mac=String(v.mac??v.macAddress??"").trim().toUpperCase();const claimCode=String(v.claimCode??"").trim()||null;
 if(!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac))return json(res,400,{error:"Invalid MAC address"});
 const [existing]=await db.select().from(posboxDevicesTable).where(eq(posboxDevicesTable.mac,mac));
 if(existing&&existing.accountId!==account?.id)return json(res,409,{error:"Device already registered",deviceId:existing.id});
 if(existing)return json(res,200,{deviceId:existing.id,mac:existing.mac,claimCode:existing.claimCode,registeredAt:existing.createdAt});
 const [device]=await db.insert(posboxDevicesTable).values({accountId:account?.id??null,mac,claimCode}).returning();return json(res,201,{deviceId:device.id,mac:device.mac,claimCode:device.claimCode,registeredAt:device.createdAt});
}
