import type { IncomingMessage, ServerResponse } from "node:http";
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, partnerAccountsTable, partnerClaimCodesTable, partnerAuditEventsTable, posboxDevicesAttributionTable, posboxDevicesTable, partnerEarningsTable } from "../core/db/index.js";
import { and, eq, isNull, gt } from "drizzle-orm";
import { deviceMetadata, partnerNvsWrite, validateClaimForNvs } from "./webflasher.js";

const CODE_TTL_MS = 90 * 24 * 60 * 60 * 1000;
const json=(r:ServerResponse,s:number,b:unknown)=>{r.writeHead(s,{"content-type":"application/json"});r.end(JSON.stringify(b));return true;};
function digest(password:string,salt=randomBytes(16)){return `${salt.toString("base64url")}.${scryptSync(password,salt,32).toString("base64url")}`;}
function verify(password:string,stored:string){try{const [s,h]=stored.split("."),got=scryptSync(password,Buffer.from(s,"base64url"),32),want=Buffer.from(h,"base64url");return got.length===want.length&&timingSafeEqual(got,want);}catch{return false;}}
function token(id:string){const raw=Buffer.from(JSON.stringify({id,exp:Date.now()+3*60*60*1000})).toString("base64url");return `${raw}.${createHmac("sha256",process.env.SESSION_SECRET??"").update(raw).digest("base64url")}`;}
export function partnerFromToken(value:string|undefined){try{if(!value)return;const [raw,mac]=value.split("."),expected=createHmac("sha256",process.env.SESSION_SECRET??"").update(raw).digest("base64url");if(!mac||mac.length!==expected.length||!timingSafeEqual(Buffer.from(mac),Buffer.from(expected)))return;const p=JSON.parse(Buffer.from(raw,"base64url").toString());return p.exp>Date.now()?p.id:undefined;}catch{return;}}
export function hashClaim(code:string){return createHmac("sha256",process.env.SESSION_SECRET??"").update(code.trim().toUpperCase()).digest("hex");}
export function newClaimCode(){return randomBytes(18).toString("base64url").toUpperCase();}
async function body(req:IncomingMessage){let x="";for await(const c of req)x+=c;return JSON.parse(x||"{}");}
function bearer(req:IncomingMessage){const h=req.headers.authorization??"";return h.startsWith("Bearer ")?h.slice(7):undefined;}
async function audit(partnerId:string,event:string,detail:Record<string,unknown>={}){await db.insert(partnerAuditEventsTable).values({partnerId,event,detail});}
export async function createPartner(name:string,handle:string,region:string,password:string){if(!name||!handle||password.length<12)throw Error("name, handle, and password of at least 12 characters are required");const [p]=await db.insert(partnerAccountsTable).values({name,handle:handle.trim().toLowerCase(),region,passwordHash:digest(password)}).returning();await audit(p.id,"partner.created",{handle:p.handle,region:p.region});return {id:p.id,name:p.name,handle:p.handle,region:p.region,status:p.status};}
export async function partnerLogin(handle:string,password:string){const [p]=await db.select().from(partnerAccountsTable).where(eq(partnerAccountsTable.handle,handle.trim().toLowerCase()));if(!p||p.status!=="active"||!verify(password,p.passwordHash)){if(p)await audit(p.id,"partner.login_failed");throw Error("Invalid partner credentials");}await audit(p.id,"partner.authenticated");return {token:token(p.id),partner:{id:p.id,name:p.name,handle:p.handle,status:p.status}};}
export async function issueClaim(partnerId:string){const code=newClaimCode(),expiresAt=new Date(Date.now()+CODE_TTL_MS);await db.update(partnerClaimCodesTable).set({revokedAt:new Date()}).where(and(eq(partnerClaimCodesTable.partnerId,partnerId),isNull(partnerClaimCodesTable.revokedAt)));const [row]=await db.insert(partnerClaimCodesTable).values({partnerId,codeHash:hashClaim(code),expiresAt}).returning({id:partnerClaimCodesTable.id,createdAt:partnerClaimCodesTable.createdAt,expiresAt:partnerClaimCodesTable.expiresAt});await audit(partnerId,"claim.issued",{claimId:row.id,expiresAt});return {claimCode:code,...row};}
export async function revokeClaims(partnerId:string){const now=new Date();const rows=await db.update(partnerClaimCodesTable).set({revokedAt:now}).where(and(eq(partnerClaimCodesTable.partnerId,partnerId),isNull(partnerClaimCodesTable.revokedAt))).returning({id:partnerClaimCodesTable.id});await audit(partnerId,"claim.revoked",{count:rows.length});return rows.length;}
export async function resolveClaim(code:string){const normalized=code.trim().toUpperCase(),[c]=await db.select().from(partnerClaimCodesTable).where(and(eq(partnerClaimCodesTable.codeHash,hashClaim(normalized)),isNull(partnerClaimCodesTable.revokedAt),gt(partnerClaimCodesTable.expiresAt,new Date())));return c;}
export async function redeemClaim(macInput:string,code:string){
 const mac=macInput.trim().toUpperCase();
 let normalized:string;
 try { normalized=validateClaimForNvs(code); } catch(e) { throw Object.assign(e instanceof Error?e:Error("Invalid claim code"),{status:400}); }
 const claim=await resolveClaim(normalized);
 if(!claim){await db.insert(partnerAuditEventsTable).values({event:"claim.redemption_invalid",detail:{mac}});throw Object.assign(Error("Invalid, expired, or revoked claim code"),{status:401});}
 const client=await db.transaction(async tx=>{const [existing]=await tx.select().from(posboxDevicesAttributionTable).where(eq(posboxDevicesAttributionTable.mac,mac));if(existing&&existing.partnerId!==claim.partnerId)throw Object.assign(Error("MAC already bound to another partner"),{status:409,deviceId:existing.deviceId});if(existing){await tx.update(posboxDevicesAttributionTable).set({lastSeenAt:new Date(),conflictAlert:null}).where(eq(posboxDevicesAttributionTable.id,existing.id));return {deviceId:existing.deviceId,partnerId:existing.partnerId,mac,replayed:true};}const [device]=await tx.insert(posboxDevicesTable).values({mac,claimCode:null}).returning({id:posboxDevicesTable.id});await tx.insert(posboxDevicesAttributionTable).values({deviceId:device.id,partnerId:claim.partnerId,mac});return {deviceId:device.id,partnerId:claim.partnerId,mac,replayed:false};});
 await audit(claim.partnerId,client.replayed?"claim.redemption_replay":"claim.redeemed",{claimId:claim.id,mac,deviceId:client.deviceId});
 return {...client, nvsWrite: partnerNvsWrite(normalized), metadata: deviceMetadata(claim.id,mac)};
}
export async function partnerEarnings(partnerId:string){return db.select().from(partnerEarningsTable).where(eq(partnerEarningsTable.partnerId,partnerId));}
export async function handlePartnerRoute(req:IncomingMessage,res:ServerResponse,u:URL):Promise<boolean>{
 if(req.method==="POST"&&u.pathname==="/api/partner/login"){const v=await body(req);try{return json(res,200,await partnerLogin(String(v.handle??""),String(v.password??"")));}catch(e){return json(res,401,{error:e instanceof Error?e.message:"Invalid credentials"});}}
 const pid=partnerFromToken(bearer(req));
 if(req.method==="GET"&&u.pathname.match(/^\/api\/partner\/[^/]+\/earnings$/)){const id=u.pathname.split("/")[3];if(!pid||pid!==id)return json(res,401,{error:"Partner authentication required"});return json(res,200,{partnerId:id,earnings:await partnerEarnings(id)});}
 if(req.method==="POST"&&u.pathname.match(/^\/api\/partner\/[^/]+\/claim-code$/)){const id=u.pathname.split("/")[3];if(!pid||pid!==id)return json(res,401,{error:"Partner authentication required"});try{return json(res,201,await issueClaim(id));}catch(e){return json(res,500,{error:e instanceof Error?e.message:"Unable to issue claim"});}}
 if(req.method==="DELETE"&&u.pathname.match(/^\/api\/partner\/[^/]+\/claim-code$/)){const id=u.pathname.split("/")[3];if(!pid||pid!==id)return json(res,401,{error:"Partner authentication required"});return json(res,200,{revoked:await revokeClaims(id)});}
 if(req.method==="POST"&&u.pathname==="/api/posbox/devices"){const v=await body(req),mac=String(v.mac??v.macAddress??"");if(!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)||!String(v.claimCode??""))return json(res,400,{error:"Valid mac and claimCode required"});try{return json(res,201,await redeemClaim(mac,String(v.claimCode)));}catch(e){return json(res,(e as {status?:number}).status??401,{error:e instanceof Error?e.message:"Claim redemption failed",deviceId:(e as {deviceId?:string}).deviceId});}}
 return false;
}
export { digest, verify }; 
export const partnerApiContract={claimCode:{input:"opaque string",stored:"HMAC-SHA256 only",ttlDays:90,reuse:"idempotent for same MAC; revoked on rotation",redemption:"POST /api/posbox/devices {mac,claimCode}"}};
