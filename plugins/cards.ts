import { randomBytes, createHash, scryptSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq, gte, isNotNull, isNull } from "drizzle-orm";
import { db, cardsTable } from "../core/db/index.js";
import { encrypt, decrypt } from "../core/money/encrypt.js";
import { decryptSunP, verifySunC, parseBolt11AmountSats } from "../core/money/boltcard.js";
import { payInvoice } from "../core/money/nwc.js";
import QRCode from "qrcode";
import { resolveWalletSource } from "../core/money/walletSource.js";

const DOMAIN = process.env.DOMAIN ?? "openln.com";
const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); return true; };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> { let raw=""; for await (const c of req) raw += c; if (!raw) return {}; return (req.headers["content-type"]??"").includes("form-urlencoded") ? Object.fromEntries(new URLSearchParams(raw)) : JSON.parse(raw); }
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const key = () => randomBytes(16).toString("hex");
const pinHash = (pin: string) => { const salt = randomBytes(16); return `${salt.toString("base64url")}.${scryptSync(pin, salt, 32).toString("base64url")}`; };

export async function handleCardsRoute(req: IncomingMessage, res: ServerResponse, u: URL, account: { id: string } | undefined): Promise<boolean> {
  const accountPath = u.pathname.match(/^\/api\/accounts\/([^/]+)\/cards$/);
  if (accountPath && (req.method === "GET" || req.method === "POST")) {
    if (!account || account.id !== accountPath[1]) return json(res, 403, { error: "Forbidden" }) as never;
    if (req.method === "GET") {
      const rows = await db.select({ id: cardsTable.id, name: cardsTable.name, note: cardsTable.note, status: cardsTable.status, perTapLimitSats: cardsTable.perTapLimitSats, dailyLimitSats: cardsTable.dailyLimitSats, pinEnabled: cardsTable.pinHash, pinLocked: cardsTable.pinLockedAt, lastUsedAt: cardsTable.lastUsedAt, createdAt: cardsTable.createdAt }).from(cardsTable).where(eq(cardsTable.accountId, account.id));
      return json(res, 200, rows.map(r => ({ ...r, pinEnabled: r.pinEnabled !== null, pinLocked: r.pinLocked !== null }))) as never;
    }
    const v = await body(req);
    const pin = String(v.pin ?? "").trim();
    if (!/^[0-9]{4,8}$/.test(pin)) return json(res, 400, { error: "PIN must contain 4–8 digits" }) as never;
    const k = [key(),key(),key(),key(),key()]; const token = randomBytes(24).toString("hex");
    const [card] = await db.insert(cardsTable).values({ accountId: account.id, name: typeof v.name === "string" ? v.name.trim().slice(0,64) || null : null, note: typeof v.note === "string" ? v.note.trim().slice(0,120) || null : null, perTapLimitSats: typeof v.perTapLimitSats === "number" ? Math.max(0, Math.floor(v.perTapLimitSats)) : undefined, dailyLimitSats: typeof v.dailyLimitSats === "number" ? Math.max(0, Math.floor(v.dailyLimitSats)) : undefined, pinHash: pinHash(pin), aesKey0: encrypt(k[0]), aesKey1: encrypt(k[1]), aesKey2: encrypt(k[2]), aesKey3: encrypt(k[3]), aesKey4: encrypt(k[4]), provisionToken: hash(token), provisionTokenExpiresAt: new Date(Date.now()+86400000) }).returning();
    return json(res, 201, { cardId: card.id, name: card.name, status: card.status, perTapLimitSats: card.perTapLimitSats, dailyLimitSats: card.dailyLimitSats, provisionUrl: `https://${DOMAIN}/api/provision/${token}`, lnurlwTemplate: `lnurlw://${DOMAIN}/card/${card.id}?p=${"0".repeat(32)}&c=${"0".repeat(16)}`, keys: Object.fromEntries(k.map((v,i)=>[`key${i}`,v])), createdAt: card.createdAt }) as never;
  }
  const cardPath = u.pathname.match(/^\/api\/cards\/([^/]+)$/);
  if (cardPath && (req.method === "PATCH" || req.method === "DELETE")) {
    if (!account) return json(res, 401, { error: "Authentication required" }) as never;
    const [owned] = await db.select({ accountId: cardsTable.accountId }).from(cardsTable).where(eq(cardsTable.id, cardPath[1]));
    if (!owned) return json(res, 404, { error: "Card not found" }) as never;
    if (owned.accountId !== account.id) return json(res, 403, { error: "Forbidden" }) as never;
    if (req.method === "DELETE") { await db.update(cardsTable).set({ status: "cancelled" }).where(eq(cardsTable.id, cardPath[1])); return json(res, 200, { id: cardPath[1], status: "cancelled" }) as never; }
    const v=await body(req); const allowed = ["active","frozen","cancelled"]; if (v.status !== undefined && !allowed.includes(String(v.status))) return json(res,400,{error:"Invalid status"}) as never;
    const set: Record<string,unknown> = {}; for (const f of ["status","name","note","perTapLimitSats","dailyLimitSats"]) if (v[f] !== undefined) set[f] = f.includes("Limit") ? Number(v[f]) : v[f];
    if (!Object.keys(set).length) return json(res,400,{error:"No fields to update"}) as never;
    const [updated] = await db.update(cardsTable).set(set).where(eq(cardsTable.id, cardPath[1])).returning({id:cardsTable.id,name:cardsTable.name,note:cardsTable.note,status:cardsTable.status,perTapLimitSats:cardsTable.perTapLimitSats,dailyLimitSats:cardsTable.dailyLimitSats,lastUsedAt:cardsTable.lastUsedAt,createdAt:cardsTable.createdAt}); return json(res,200,updated) as never;
  }
  const provisionQr = u.pathname.match(/^\/api\/cards\/([^/]+)\/provision-qr$/);
  if (provisionQr && req.method === "GET") {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const [card] = await db.select({ accountId: cardsTable.accountId, provisionToken: cardsTable.provisionToken }).from(cardsTable).where(eq(cardsTable.id, provisionQr[1]));
    if (!card || card.accountId !== account.id || !card.provisionToken) return json(res,404,{error:"Provisioning token not available"}) as never;
    const url = `https://${DOMAIN}/api/provision/${card.provisionToken}`;
    const svg = await QRCode.toString(url,{type:"svg",margin:1,width:320,color:{dark:"#ffffff",light:"#0a0f0f"}});
    res.writeHead(200,{"content-type":"image/svg+xml","cache-control":"no-store"}); res.end(svg); return true;
  }
  const cardAction = u.pathname.match(/^\/api\/cards\/([^/]+)\/(keys|pin)$/);
  if (cardAction && req.method === "POST") {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.id,cardAction[1]),eq(cardsTable.accountId,account.id)));
    if (!card) return json(res,404,{error:"Card not found"}) as never;
    const v=await body(req);
    if(cardAction[2]==="pin") { const p=String(v.pin??""); if(!/^[0-9]{4,8}$/.test(p)) return json(res,400,{error:"PIN must contain 4–8 digits"}) as never; await db.update(cardsTable).set({pinHash:pinHash(p)}).where(eq(cardsTable.id,card.id)); return json(res,200,{ok:true,pinEnabled:true}) as never; }
    return json(res,200,{cardId:card.id,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4),lnurlwTemplate:`lnurlw://${DOMAIN}/card/${card.id}?p=${"0".repeat(32)}&c=${"0".repeat(16)}`}) as never;
  }
  const deviceNext = u.pathname === "/api/pos/next-provision";
  const deviceCard = u.pathname.match(/^\/api\/pos\/(mark-written|wipe-keys|mark-wiped)\/([^/]+)$/);
  if (deviceNext && req.method === "GET") {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.accountId,account.id),eq(cardsTable.status,"active"),isNotNull(cardsTable.provisionToken),isNotNull(cardsTable.provisionTokenExpiresAt),gte(cardsTable.provisionTokenExpiresAt,new Date()),isNull(cardsTable.lastUsedAt))).orderBy(cardsTable.createdAt).limit(1);
    if (!card) return json(res,404,{error:"No pending cards to write"}) as never;
    return json(res,200,{cardId:card.id,lnurlwBase:`lnurlw://${DOMAIN}/card/${card.id}`,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4),ndefFile:`lnurlw://${DOMAIN}/card/${card.id}?p=${"0".repeat(32)}&c=${"0".repeat(16)}`}) as never;
  }
  if (deviceCard && ["POST","GET"].includes(req.method ?? "")) {
    if (!account) return json(res,401,{error:"Authentication required"}) as never;
    const action=deviceCard[1], cardId=deviceCard[2];
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.id,cardId),eq(cardsTable.accountId,account.id)));
    if (!card) return json(res,404,{error:"Card not found"}) as never;
    if (action === "mark-written" && req.method === "POST") { await db.update(cardsTable).set({provisionToken:null,provisionTokenExpiresAt:null,status:"active",lastUsedAt:new Date()}).where(eq(cardsTable.id,cardId)); return json(res,200,{status:"OK"}) as never; }
    if (action === "mark-wiped" && req.method === "POST") { await db.update(cardsTable).set({status:"cancelled",lastUsedAt:new Date()}).where(eq(cardsTable.id,cardId)); return json(res,200,{status:"OK"}) as never; }
    if (action === "wipe-keys" && req.method === "GET") return json(res,200,{cardId,k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4),factorySettings:"40e0ee01ffff"}) as never;
    return json(res,405,{error:"Method not allowed"}) as never;
  }
  const provision = u.pathname.match(/^\/api\/provision\/([^/]+)$/);
  if (provision && req.method === "GET") {
    const [card] = await db.select().from(cardsTable).where(and(eq(cardsTable.provisionToken, hash(provision[1])), isNotNull(cardsTable.provisionTokenExpiresAt), gte(cardsTable.provisionTokenExpiresAt, new Date())));
    if (!card) return json(res,404,{error:"Invalid or expired provisioning token"}) as never;
    await db.update(cardsTable).set({provisionToken:null,provisionTokenExpiresAt:null}).where(eq(cardsTable.id,card.id));
    return json(res,200,{protocol_name:"new_bolt_card_response",protocol_version:1,card_name:"openLN Card",lnurlw_base:`lnurlw://${DOMAIN}/card/${card.id}`,uid_privacy:"Y",k0:decrypt(card.aesKey0),k1:decrypt(card.aesKey1),k2:decrypt(card.aesKey2),k3:decrypt(card.aesKey3),k4:decrypt(card.aesKey4)}) as never;
  }
  const tap = u.pathname.match(/^\/card\/([^/]+)$/);
  if (tap && req.method === "GET") {
    if (!/^[0-9a-f-]{36}$/i.test(tap[1])) return json(res,404,{status:"ERROR",reason:"Card not found"}) as never;
    const [card] = await db.select().from(cardsTable).where(eq(cardsTable.id,tap[1])); if (!card) return json(res,404,{status:"ERROR",reason:"Card not found"}) as never;
    if (card.status === "cancelled" || card.pinLockedAt) return json(res,200,{status:"ERROR",reason:card.status === "cancelled" ? "Card has been cancelled" : "Card PIN is locked"}) as never;
    const p=String(u.searchParams.get("p")??"").toLowerCase(), c=String(u.searchParams.get("c")??"");
    if (/^0+$/.test(p) && /^0+$/.test(c) && p.length===32 && c.length===16) return json(res,200,{tag:"withdrawRequest",callback:`https://${DOMAIN}/card/${card.id}/callback`,k1:"0".repeat(64),defaultDescription:card.note??"openLN card payment",minWithdrawable:1000,maxWithdrawable:card.perTapLimitSats*1000}) as never;
    if (!p || !c) return json(res,200,{status:"ERROR",reason:"Missing p or c parameter"}) as never;
    const sun=decryptSunP(decrypt(card.aesKey1),p); if (!sun || !verifySunC(decrypt(card.aesKey2),sun.uid,sun.counter,c)) return json(res,200,{status:"ERROR",reason:"Card authentication failed"}) as never;
    if (sun.counter <= card.counter) return json(res,200,{status:"ERROR",reason:"Counter replay detected"}) as never;
    const k1=randomBytes(16).toString("hex"); await db.update(cardsTable).set({counter:sun.counter,uid:card.uid??sun.uid.toString("hex"),pendingK1:k1,pendingK1ExpiresAt:new Date(Date.now()+300000),lastUsedAt:new Date()}).where(eq(cardsTable.id,card.id));
    return json(res,200,{tag:"withdrawRequest",callback:`https://${DOMAIN}/card/${card.id}/callback`,k1,defaultDescription:card.note??"openLN card payment",minWithdrawable:1000,maxWithdrawable:card.perTapLimitSats*1000}) as never;
  }
  const callback = u.pathname.match(/^\/card\/([^/]+)\/callback$/);
  if (callback && req.method === "GET") {
    if (!/^[0-9a-f-]{36}$/i.test(callback[1])) return json(res,404,{status:"ERROR",reason:"Card not found"}) as never;
    const [card] = await db.select().from(cardsTable).where(eq(cardsTable.id,callback[1]));
    if (!card) return json(res,404,{status:"ERROR",reason:"Card not found"}) as never;
    const k1=String(u.searchParams.get("k1")??""), pr=String(u.searchParams.get("pr")??"");
    if (!k1 || !pr) return json(res,200,{status:"ERROR",reason:"Missing k1 or pr parameter"}) as never;
    if (card.status !== "active" || !card.pendingK1 || card.pendingK1 !== k1 || !card.pendingK1ExpiresAt || card.pendingK1ExpiresAt < new Date()) return json(res,200,{status:"ERROR",reason:"Invalid or expired k1"}) as never;
    const amountSats=parseBolt11AmountSats(pr);
    if (!amountSats || amountSats > card.perTapLimitSats) return json(res,200,{status:"ERROR",reason:"Invoice exceeds card limit"}) as never;
    const source=await resolveWalletSource(card.accountId);
    if (source.kind !== "nwc") return json(res,200,{status:"ERROR",reason:"Wallet not configured for NWC"}) as never;
    const [consumed]=await db.update(cardsTable).set({pendingK1:null,pendingK1ExpiresAt:null}).where(and(eq(cardsTable.id,card.id),eq(cardsTable.pendingK1,k1),gte(cardsTable.pendingK1ExpiresAt,new Date()))).returning({id:cardsTable.id});
    if (!consumed) return json(res,200,{status:"ERROR",reason:"Invalid or expired k1"}) as never;
    try { const paid=await payInvoice(pr,source.nwcUrl); return json(res,200,{status:"OK",preimage:paid.preimage}) as never; }
    catch (e) { return json(res,200,{status:"ERROR",reason:e instanceof Error?e.message:"Payment failed"}) as never; }
  }
  return false;
}
