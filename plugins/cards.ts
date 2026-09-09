import { randomBytes, createHash, scryptSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { db, cardsTable } from "../core/db/index.js";
import { encrypt, decrypt } from "../core/money/encrypt.js";
import { decryptSunP, verifySunC, parseBolt11AmountSats } from "../core/money/boltcard.js";
import { handleCardTapRoute } from "./card-tap.js";
import QRCode from "qrcode";
import { computeSdmOffsets, buildSdmSettings } from "./card-ndef.js";
import { verifyCardPin } from "../core/auth/card-pin.js";

import { DOMAIN } from "../core/domain.js";
const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json", "cache-control":"no-store", "referrer-policy":"no-referrer" }); r.end(JSON.stringify(b)); return true; };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> { let raw=""; for await (const c of req) raw += c; if (!raw) return {}; return (req.headers["content-type"]??"").includes("form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const key = () => randomBytes(16).toString("hex");
const qrSvg = (url: string) => QRCode.toString(url, { type: "svg", margin: 4, width: 320, color: { dark: "#071c1b", light: "#ffffff" } });
const provisionFields = async (cardId: string, token: string) => {
  const provisionUrl = `https://${DOMAIN}/api/provision/${token}`;
  return { provisionUrl, provisionQr: await qrSvg(provisionUrl), lnurlwTemplate: `lnurlw://${DOMAIN}/card/${cardId}?p=${"0".repeat(32)}&c=${"0".repeat(16)}` };
};
const pinHash = (pin: string) => { const salt = randomBytes(16); return `${salt.toString("base64url")}.${scryptSync(pin, salt, 32).toString("base64url")}`; };
const pinVerify = (pin: string, stored: string | null) => { try { if (!stored) return false; const [salt, val] = stored.split("."); const got=scryptSync(pin,Buffer.from(salt,"base64url"),32).toString("base64url"); return got===val; } catch { return false; } };


export async function handleCardsRoute(req: IncomingMessage, res: ServerResponse, u: URL, account: { id: string } | undefined): Promise<boolean> {
  const accountPath = u.pathname.match(/^\/api\/accounts\/([^/]+)\/cards$/);
  if (accountPath && (req.method === "GET" || req.method === "POST")) {
    if (!account || account.id !== accountPath[1]) return json(res, 403, { error: "Forbidden" }) as never;
    if (req.method === "GET") {
      const rows = await db.select({ id: cardsTable.id, name: cardsTable.name, note: cardsTable.note, status: cardsTable.status, perTapLimitSats: cardsTable.perTapLimitSats, dailyLimitSats: cardsTable.dailyLimitSats, pinEnabled: cardsTable.pinHash, pinLocked: cardsTable.pinLockedAt, lastUsedAt: cardsTable.lastUsedAt, createdAt: cardsTable.createdAt }).from(cardsTable).where(eq(cardsTable.accountId, account.id));
      return json(res, 200, rows.map(r => ({ ...r, pinEnabled: r.pinEnabled !== null, pinLocked: r.pinLocked !== null }))) as never;
    }
    const v = await body(req);
    for(const field of ["perTapLimitSats","dailyLimitSats"]) if(v[field]!==undefined && (typeof v[field]!=="number" || !Number.isSafeInteger(v[field]) || Number(v[field])<0))return json(res,400,{error:"Spending limits must be non-negative whole sats"});
    const pin = String(v.pin ?? "").trim();
    if (!/^[0-9]{4}$/.test(pin)) return json(res, 400, { error: "PIN must be exactly 4 digits" }) as never;
    const k = [key(),key(),key(),key(),key()]; const token = randomBytes(24).toString("hex");
    const [card] = await db.insert(cardsTable).values({ accountId: account.id, name: typeof v.name === "string" ? v.name.trim().slice(0,64) || null : null, note: typeof v.note === "string" ? v.note.trim().slice(0,120) || null : null, perTapLimitSats: typeof v.perTapLimitSats === "number" ? Math.max(0, Math.floor(v.perTapLimitSats)) : undefined, dailyLimitSats: typeof v.dailyLimitSats === "number" ? Math.max(0, Math.floor(v.dailyLimitSats)) : undefined, pinHash: pinHash(pin), aesKey0: encrypt(k[0]), aesKey1: encrypt(k[1]), aesKey2: encrypt(k[2]), aesKey3: encrypt(k[3]), aesKey4: encrypt(k[4]), provisionToken: hash(token), provisionTokenExpiresAt: new Date(Date.now()+86400000) }).returning();
    return json(res, 201, { cardId: card.id, name: card.name, status: card.status, perTapLimitSats: card.perTapLimitSats, dailyLimitSats: card.dailyLimitSats, ...(await provisionFields(card.id, token)), provisionExpiresAt: card.provisionTokenExpiresAt, keys: Object.fromEntries(k.map((v,i)=>[`key${i}`,v])), createdAt: card.createdAt }) as never;
  }
  const cardPath = u.pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardPath && (req.method === "PATCH" || req.method === "DELETE")) {
    if (!account) return json(res, 401, { error: "Authentication required" }) as never;
    const [owned] = await db.select({ accountId: cardsTable.accountId, status: cardsTable.status }).from(cardsTable).where(eq(cardsTable.id, cardPath[1]));
    if (!owned) return json(res, 404, { error: "Card not found" }) as never;
    if (owned.accountId !== account.id) return json(res, 403, { error: "Forbidden" }) as never;
    if (req.method === "DELETE") { await db.update(cardsTable).set({ status: "cancelled", provisionToken:null, provisionTokenExpiresAt:null, pendingK1:null, pendingK1ExpiresAt:null }).where(and(eq(cardsTable.id, cardPath[1]),eq(cardsTable.accountId,account.id))); return json(res, 200, { id: cardPath[1], status: "cancelled" }) as never; }
    if (owned.status === "cancelled") return json(res,409,{error:"Cancelled cards cannot be reactivated; issue a new card"});
    const v=await body(req); const allowed = ["active","frozen","cancelled"]; if (v.status !== undefined && !allowed.includes(String(v.status))) return json(res,400,{error:"Invalid status"}) as never;
    for(const field of ["perTapLimitSats","dailyLimitSats"]) if(v[field]!==undefined && (typeof v[field]!=="number" || !Number.isSafeInteger(v[field]) || Number(v[field])<0))return json(res,400,{error:"Spending limits must be non-negative whole sats"});
    const set: Record<string,unknown> = {}; for (const f of ["status","name","note","perTapLimitSats","dailyLimitSats"]) if (v[f] !== undefined) set[f] = f.includes("Limit") ? Number(v[f]) : v[f];
    for(const [field,max] of [["name",64],["note",120]] as const) if(v[field]!==undefined){if(v[field]!==null && typeof v[field]!=="string")return json(res,400,{error:"Invalid card details"});set[field]=typeof v[field]==="string"?String(v[field]).trim().slice(0,max)||null:null;}
    if(v.status && v.status!=="active")Object.assign(set,{provisionToken:null,provisionTokenExpiresAt:null,pendingK1:null,pendingK1ExpiresAt:null});
    if (!Object.keys(set).length) return json(res,400,{error:"No fields to update"}) as never;
    const [updated] = await db.update(cardsTable).set(set).where(and(eq(cardsTable.id, cardPath[1]),eq(cardsTable.accountId,account.id),eq(cardsTable.status,owned.status))).returning({id:cardsTable.id,name:cardsTable.name,note:cardsTable.note,status:cardsTable.status,perTapLimitSats:cardsTable.perTapLimitSats,dailyLimitSats:cardsTable.dailyLimitSats,lastUsedAt:cardsTable.lastUsedAt,createdAt:cardsTable.createdAt}); return json(res,200,updated) as never;
  }
  const renewProvision = u.pathname.match(/^\/api\/cards\/([^/]+)\/provision$/);
  if (renewProvision && req.method === "POST") {
    if (!account) return json(res,401,{error:"Authentication required"});
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.id,renewProvision[1]),eq(cardsTable.accountId,account.id)));
    if (!card) return json(res,404,{error:"Card not found"});
    if (card.status !== "active" || card.lastUsedAt) return json(res,409,{error:"Only an active, unwritten card can receive a new setup link"});
    const token=randomBytes(24).toString("hex"),expiresAt=new Date(Date.now()+86400000);
    const fields=await provisionFields(card.id,token);
    const [updated]=await db.update(cardsTable).set({provisionToken:hash(token),provisionTokenExpiresAt:expiresAt})
      .where(and(eq(cardsTable.id,card.id),eq(cardsTable.accountId,account.id),eq(cardsTable.status,"active"),isNull(cardsTable.lastUsedAt))).returning({id:cardsTable.id});
    if (!updated) return json(res,409,{error:"Card state changed; reload Cards"});
    return json(res,200,{cardId:card.id,...fields,provisionExpiresAt:expiresAt});
  }
  const provisionQr = u.pathname.match(/^\/api\/cards\/([^/]+)\/provision-qr$/);
  if (provisionQr && req.method === "GET") {
    if (!account) return json(res,401,{error:"Authentication required"});
    // A one-way token hash cannot be turned back into a working setup URL.
    // The owner deliberately renews it via POST /provision; GET never rotates secrets.
    return json(res,409,{error:"Open Cards and choose Set up card to generate a fresh QR"});
  }
  const pinPath = u.pathname.match(/^\/api\/cards\/([^/]+)\/pin(?:\/(unlock|limit))?$/);
  if (pinPath && (req.method === "PUT" || req.method === "POST")) {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.id,pinPath[1]),eq(cardsTable.accountId,account.id)));
    if (!card) return json(res,404,{error:"Card not found"}) as never;
    const v=await body(req); const sub=pinPath[2];
    if(sub === "unlock") { if(!card.pinLockedAt) return json(res,200,{ok:true,pinLocked:false}) as never; await db.update(cardsTable).set({pinLockedAt:null,pinFailCount:0}).where(eq(cardsTable.id,card.id)); return json(res,200,{ok:true,pinLocked:false}) as never; }
    if(sub === "limit") { const x=v.pinLimitMsats===null?null:Number(v.pinLimitMsats); if(x!==null && (!Number.isFinite(x)||x<0)) return json(res,400,{error:"Invalid PIN threshold"}) as never; await db.update(cardsTable).set({pinLimitMsats:x}).where(eq(cardsTable.id,card.id)); return json(res,200,{ok:true,pinLimitMsats:x}) as never; }
    const p=String(v.newPin ?? v.pin ?? ""); if(!p && v.newPin !== null) return json(res,400,{error:"PIN required"}) as never;
    if(v.newPin === null) { if(!await verifyCardPin(String(v.pin??""),card.pinHash)) return json(res,401,{error:"Incorrect PIN"}) as never; await db.update(cardsTable).set({pinHash:null,pinLimitMsats:null,pinFailCount:0,pinLockedAt:null}).where(eq(cardsTable.id,card.id)); return json(res,200,{ok:true,pinEnabled:false}) as never; }
    if(!/^[0-9]{4}$/.test(p)) return json(res,400,{error:"PIN must be exactly 4 digits"}) as never;
    if (card.pinHash && !await verifyCardPin(String(v.pin??""),card.pinHash)) return json(res,401,{error:"Current PIN is required and must be correct"});
    await db.update(cardsTable).set({pinHash:pinHash(p),pinFailCount:0,pinLockedAt:null}).where(eq(cardsTable.id,card.id)); return json(res,200,{ok:true,pinEnabled:true}) as never;
  }
  const wipeExport=u.pathname.match(/^\/api\/cards\/([^/]+)\/wipe$/);
  if(wipeExport && req.method === "POST") {
    if(!account)return json(res,401,{error:"Authentication required"});
    const [card]=await db.select().from(cardsTable).where(and(eq(cardsTable.id,wipeExport[1]),eq(cardsTable.accountId,account.id)));
    if(!card)return json(res,404,{error:"Card not found"});
    const wipeKeys={protocol_name:"wipe_bolt_card_response",protocol_version:1,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4)};
    // Export only. Never rotate recovery keys before the physical chip reports success.
    return json(res,200,{cardId:card.id,wipeKeys,wipeQr:await qrSvg(JSON.stringify(wipeKeys)),factorySettings:"40e0ee01ffff"});
  }
  const cardAction = u.pathname.match(/^\/api\/cards\/([^/]+)\/(keys|pin)$/);
  if (cardAction && req.method === "POST") {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.id,cardAction[1]),eq(cardsTable.accountId,account.id)));
    if (!card) return json(res,404,{error:"Card not found"}) as never;
    const v=await body(req);
    if(cardAction[2]==="pin") { const p=String(v.pin??""); if(!/^[0-9]{4}$/.test(p)) return json(res,400,{error:"PIN must be exactly 4 digits"}) as never; await db.update(cardsTable).set({pinHash:pinHash(p)}).where(eq(cardsTable.id,card.id)); return json(res,200,{ok:true,pinEnabled:true}) as never; }
    return json(res,200,{cardId:card.id,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4),lnurlwTemplate:`lnurlw://${DOMAIN}/card/${card.id}?p=${"0".repeat(32)}&c=${"0".repeat(16)}`}) as never;
  }
  const deviceNext = u.pathname === "/api/pos/next-provision";
  const deviceCard = u.pathname.match(/^\/api\/pos\/(mark-written|wipe-keys|mark-wiped)\/([^/]+)$/);
  if (deviceNext && req.method === "GET") {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.accountId,account.id),eq(cardsTable.status,"active"),isNotNull(cardsTable.provisionToken),isNotNull(cardsTable.provisionTokenExpiresAt),gte(cardsTable.provisionTokenExpiresAt,new Date()),isNull(cardsTable.lastUsedAt))).orderBy(cardsTable.createdAt).limit(1);
    if (!card) return json(res,404,{error:"No pending cards to write"}) as never;
    const lnurlwBase=`lnurlw://${DOMAIN}/card/${card.id}`;
    const {ndefFile,encPiccOffset,macOffset}=computeSdmOffsets(lnurlwBase);
    return json(res,200,{cardId:card.id,name:card.name,lnurlwBase,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4),ndefFile:ndefFile.toString("hex"),sdmSettings:buildSdmSettings(encPiccOffset,macOffset).toString("hex")}) as never;
  }
  if (deviceCard && ["POST","GET"].includes(req.method ?? "")) {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const action=deviceCard[1], cardId=deviceCard[2];
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.id,cardId),eq(cardsTable.accountId,account.id)));
    if (!card) return json(res,404,{error:"Card not found"}) as never;
    if (action === "mark-written" && req.method === "POST") { const [written]=await db.update(cardsTable).set({provisionToken:null,provisionTokenExpiresAt:null,lastUsedAt:new Date()}).where(and(eq(cardsTable.id,cardId),eq(cardsTable.accountId,account.id),eq(cardsTable.status,"active"))).returning({id:cardsTable.id}); if(!written)return json(res,409,{error:"Card is frozen or cancelled; write confirmation rejected"}); return json(res,200,{status:"OK"}); }
    if (action === "mark-wiped" && req.method === "POST") { await db.update(cardsTable).set({status:"cancelled",provisionToken:null,provisionTokenExpiresAt:null,pendingK1:null,pendingK1ExpiresAt:null,lastUsedAt:new Date()}).where(eq(cardsTable.id,cardId)); return json(res,200,{status:"OK"}) as never; }
    if (action === "wipe-keys" && req.method === "GET") return json(res,200,{cardId,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4),factorySettings:"40e0ee01ffff"}) as never;
    return json(res,405,{error:"Method not allowed"}) as never;
  }
  const provision = u.pathname.match(/^\/api\/provision\/([^/]+)$/);
  if (provision && req.method === "GET") {
    if (!/^[0-9a-f]{48}$/.test(provision[1])) return json(res,404,{error:"Invalid or expired provisioning token"});
    const [card] = await db.update(cardsTable).set({provisionToken:null,provisionTokenExpiresAt:null})
      .where(and(eq(cardsTable.provisionToken,hash(provision[1])),eq(cardsTable.status,"active"),isNotNull(cardsTable.provisionTokenExpiresAt),gte(cardsTable.provisionTokenExpiresAt,new Date()))).returning();
    if (!card) return json(res,404,{error:"Invalid or expired provisioning token"}) as never;
    return json(res,200,{protocol_name:"new_bolt_card_response",protocol_version:1,card_name:"openLN Card",lnurlw_base:`lnurlw://${DOMAIN}/card/${card.id}`,uid_privacy:"Y",k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4)}) as never;
  }
  if (await handleCardTapRoute(req,res,u)) return true;
  return false;
}
