import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { db, partnerAccountsTable, partnerClaimCodesTable, partnerEarningsTable } from "../core/db/index.js";
import { eq, and, isNull } from "drizzle-orm";
function digest(password: string, salt: Buffer) { return `${salt.toString("base64url")}.${scryptSync(password, salt, 32).toString("base64url")}`; }
function verify(password: string, stored: string) { try { const [s,h]=stored.split("."); const got=scryptSync(password,Buffer.from(s,"base64url"),32), want=Buffer.from(h,"base64url"); return got.length===want.length&&timingSafeEqual(got,want); } catch { return false; } }
function token(id:string) { const raw=Buffer.from(JSON.stringify({id,exp:Date.now()+3*60*60*1000})).toString("base64url"); return `${raw}.${createHmac("sha256",process.env.SESSION_SECRET ?? "").update(raw).digest("base64url")}`; }
export function partnerFromToken(value:string|undefined) { try { if(!value) return; const [raw,mac]=value.split("."); const expected=createHmac("sha256",process.env.SESSION_SECRET ?? "").update(raw).digest("base64url"); if(!mac||mac.length!==expected.length||!timingSafeEqual(Buffer.from(mac),Buffer.from(expected))) return; const p=JSON.parse(Buffer.from(raw,"base64url").toString()); return p.exp>Date.now()?p.id:undefined; } catch { return; } }
export function newClaimCode() { return randomBytes(6).toString("base64url").toUpperCase(); }
export function hashClaim(code:string) { return createHmac("sha256", process.env.SESSION_SECRET ?? "").update(code).digest("hex"); }
export async function partnerLogin(handle:string,password:string) { const [p]=await db.select().from(partnerAccountsTable).where(eq(partnerAccountsTable.handle,handle.toLowerCase())); if(!p||!verify(password,p.passwordHash)) throw Error("Invalid partner credentials"); return {token:token(p.id),partner:{id:p.id,name:p.name,handle:p.handle,status:p.status}}; }
export async function resolveClaim(code:string) { const [c]=await db.select().from(partnerClaimCodesTable).where(and(eq(partnerClaimCodesTable.codeHash,hashClaim(code)),isNull(partnerClaimCodesTable.revokedAt))); return c; }
export async function partnerEarnings(partnerId:string) { return db.select().from(partnerEarningsTable).where(eq(partnerEarningsTable.partnerId,partnerId)); }
export { digest };
