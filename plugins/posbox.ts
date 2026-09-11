import type { IncomingMessage,ServerResponse } from "node:http";
import { eq,and,isNull } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { db,posboxDevicesTable,deviceTokensTable,accountsTable,entitiesTable,cardsTable,pendingInvoicesTable,transactionsTable } from "../core/db/index.js";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DOMAIN } from "../core/domain.js";
import { verifySendPin, SEND_PIN_UNSET } from "../core/auth/send-pin.js";
import { generateK1, encodeLnurl, decryptSunP, verifySunC } from "../core/money/boltcard.js";
import { captureFiatSnapshot } from "../core/money/fiatSnapshot.js";
import { resolveWalletSource } from "../core/money/walletSource.js";
import { getAccountNwcUrl, makeInvoice } from "../core/money/nwc.js";
import { processExternalPayment } from "../core/money/feeEngine.js";
import { logger } from "../core/money/logger.js";
const json=(r:ServerResponse,s:number,b:unknown)=>{r.writeHead(s,{"content-type":"application/json"});r.end(JSON.stringify(b));return true;};
async function body(req:IncomingMessage){let x="";for await(const c of req)x+=c;return JSON.parse(x||"{}");}

/** RIC device is "online" if it made an authenticated API call within the last 10 minutes. */
function isOnline(lastUsedAt: Date | null): boolean {
  if (!lastUsedAt) return false;
  return Date.now() - new Date(lastUsedAt).getTime() < 10 * 60 * 1000;
}

export async function handlePosboxRoute(req:IncomingMessage,res:ServerResponse,u:URL,account:{id:string}|undefined):Promise<boolean>{
 if(u.pathname==="/api/posbox/firmware/manifest"&&req.method==="GET"){try{const manifest=JSON.parse(await readFile(join(process.cwd(),"firmware","manifest.json"),"utf8"));return json(res,200,manifest);}catch{return json(res,404,{error:"Firmware manifest unavailable"});}}
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

 // ── Device SEND routes (ported from bitPOS pos.ts: /pos/withdraw, /pos/send-to-card) ──
 // These authorize sats LEAVING the merchant via the RIC. The 6-digit send PIN
 // (entities.pin_hash, bcrypt, core/auth/send-pin.ts) is verified here exactly
 // as bitPOS did. Distinct from the 4-digit Bolt Card spending PIN on the tap
 // path (card-tap.ts) — do not conflate.

 // Shared sentinel so insert / status / callback lookups can never drift.
 const WITHDRAW_MEMO = "RIC send (QR)";
 const sendPinGuard = async (accountId: string, rawPin: string): Promise<null | { status: number; body: Record<string, string> }> => {
  const [acc] = await db.select({ entityId: accountsTable.entityId }).from(accountsTable).where(eq(accountsTable.id, accountId));
  if (!acc) return { status: 404, body: { error: "Account not found" } };
  const [entity] = await db.select({ pinHash: entitiesTable.pinHash }).from(entitiesTable).where(eq(entitiesTable.id, acc.entityId));
  if (!entity) return { status: 404, body: { error: "Account not found" } };
  if (!entity.pinHash || entity.pinHash === SEND_PIN_UNSET) {
   // No PIN configured. Deliberately without the word "PIN": the firmware
   // re-prompts on PIN-ish errors, which would loop forever here.
   return { status: 403, body: { error: "Sending is not set up for this account. Configure a send code in openLN Settings." } };
  }
  if (!rawPin) return { status: 400, body: { error: "PIN required" } };
  if (!await verifySendPin(rawPin, entity.pinHash)) return { status: 401, body: { error: "Invalid PIN" } };
  return null;
 };

 // POST /api/pos/withdraw — device creates an LNURL-W QR; merchant's wallet is
 // charged when the counterparty wallet submits its bolt11 to the callback.
 if (u.pathname === "/api/pos/withdraw" && req.method === "POST") {
  if (!account) return json(res, 401, { error: "Authentication required" });
  const v = await body(req);
  const amountSats = Number(v.amountSats);
  const pin = String(v.pin ?? "");
  if (!amountSats || !Number.isInteger(amountSats) || amountSats < 1) return json(res, 400, { error: "amountSats must be a positive integer" });
  const denied = await sendPinGuard(account.id, pin); if (denied) return json(res, denied.status, denied.body);
  const source = await resolveWalletSource(account.id);
  if (source.kind === "none") return json(res, 400, { error: "Wallet not configured" });
  if (source.kind === "lnaddress") return json(res, 400, { error: "Lightning address accounts are receive-only" });
  const k1 = generateK1();
  const fiatSnapshot = await captureFiatSnapshot(account.id, amountSats, "send");
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000);
  await db.insert(pendingInvoicesTable).values({ accountId: account.id, bolt11: "", paymentHash: k1, amountSats, memo: WITHDRAW_MEMO, expiresAt, ...(fiatSnapshot ?? {}) });
  const callbackUrl = `https://${DOMAIN}/api/pos/withdraw/callback`;
  const lnurlw = encodeLnurl(`${callbackUrl}?k1=${k1}`);
  logger.info({ accountId: account.id, amountSats, k1 }, "RIC send: LNURL-W created");
  return json(res, 200, { lnurlw, k1 });
 }
 // GET /api/pos/withdraw/:k1/status — device polls while the QR is shown.
 const wdStatus = u.pathname.match(/^\/api\/pos\/withdraw\/([^/]+)\/status$/);
 if (wdStatus && req.method === "GET") {
  if (!account) return json(res, 401, { error: "Authentication required" });
  const k1 = decodeURIComponent(wdStatus[1]);
  const [pending] = await db.select().from(pendingInvoicesTable).where(and(eq(pendingInvoicesTable.paymentHash, k1), eq(pendingInvoicesTable.memo, WITHDRAW_MEMO)));
  if (!pending || pending.accountId !== account.id) return json(res, 200, { status: "expired" });
  if (pending.paidAt) return json(res, 200, { status: "paid" });
  if (pending.expiresAt < new Date()) return json(res, 200, { status: "expired" });
  return json(res, 200, { status: "pending" });
 }
 // GET /api/pos/withdraw/callback — LNURL-W, public: step 1 (no pr) returns
 // the withdrawRequest, step 2 (pr) pays the submitted bolt11 from the
 // merchant wallet. Same shape and semantics as bitPOS.
 if (u.pathname === "/api/pos/withdraw/callback" && req.method === "GET") {
  const k1 = String(u.searchParams.get("k1") ?? "");
  const pr = String(u.searchParams.get("pr") ?? "");
  if (!k1) return json(res, 200, { status: "ERROR", reason: "Missing k1" });
  const [pending] = await db.select().from(pendingInvoicesTable).where(and(eq(pendingInvoicesTable.paymentHash, k1), eq(pendingInvoicesTable.memo, WITHDRAW_MEMO)));
  if (!pending) return json(res, 200, { status: "ERROR", reason: "Invalid or expired withdrawal" });
  if (pending.expiresAt < new Date()) return json(res, 200, { status: "ERROR", reason: "Withdrawal expired" });
  if (!pr) return json(res, 200, { tag: "withdrawRequest", callback: `https://${DOMAIN}/api/pos/withdraw/callback`, k1, defaultDescription: "openLN send", minWithdrawable: pending.amountSats * 1000, maxWithdrawable: pending.amountSats * 1000 });
  if (pending.paidAt) return json(res, 200, { status: "ERROR", reason: "Withdrawal already claimed" });
  try {
   const { paymentHash, feeSats } = await processExternalPayment(pending.accountId, pr, pending.amountSats, undefined, WITHDRAW_MEMO);
   logger.info({ accountId: pending.accountId, amountSats: pending.amountSats, feeSats, paymentHash }, "RIC send: payment sent via QR");
   await db.update(pendingInvoicesTable).set({ paidAt: new Date(), bolt11: pr }).where(eq(pendingInvoicesTable.id, pending.id));
   return json(res, 200, { status: "OK" });
  } catch (err) {
   logger.error({ accountId: pending.accountId, err }, "RIC send: payment failed");
   return json(res, 200, { status: "ERROR", reason: err instanceof Error ? err.message : "Payment failed" });
  }
 }
 // POST /api/pos/send-to-card — merchant taps a customer's openLN Bolt Card
 // and pays its holder directly. AES-SUN verified server-side, merchant
 // charged via the fee engine. bitPOS-verbatim, PIN-gated.
 if (u.pathname === "/api/pos/send-to-card" && req.method === "POST") {
  if (!account) return json(res, 401, { error: "Authentication required" });
  const merchantAccountId = account.id;
  const v = await body(req);
  const cardUrl = String(v.cardUrl ?? "");
  const amountSats = Number(v.amountSats);
  const pin = String(v.pin ?? "");
  if (!cardUrl || !amountSats || !pin) return json(res, 400, { error: "cardUrl, amountSats, and pin are required" });
  const denied = await sendPinGuard(merchantAccountId, pin); if (denied) return json(res, denied.status, denied.body);
  const urlMatch = cardUrl.match(/\/card\/([^?]+)\?p=([0-9a-fA-F]+)&c=([0-9a-fA-F]+)/);
  if (!urlMatch) return json(res, 400, { error: "Invalid card URL" });
  const [, cardId, pHex, cHex] = urlMatch;
  const [card] = await db.select().from(cardsTable).where(eq(cardsTable.id, cardId));
  if (!card) return json(res, 404, { error: "Card not found" });
  if (card.status === "cancelled") return json(res, 400, { error: "Card has been cancelled" });
  let key1Hex: string, key2Hex: string;
  try {
   const { decrypt } = await import("../core/money/encrypt.js");
   key1Hex = decrypt(card.aesKey1);
   key2Hex = decrypt(card.aesKey2);
  } catch {
   logger.error({ cardId }, "Failed to decrypt card AES keys for send-to-card");
   return json(res, 500, { error: "Internal error" });
  }
  const sunData = decryptSunP(key1Hex, pHex.toLowerCase());
  if (!sunData) return json(res, 400, { error: "Card authentication failed" });
  if (!verifySunC(key2Hex, sunData.uid, sunData.counter, cHex.toLowerCase())) return json(res, 400, { error: "Card verification failed" });
  const cardAccountId = card.accountId;
  const cardNwcUrl = await getAccountNwcUrl(cardAccountId);
  if (!cardNwcUrl) return json(res, 400, { error: "Card holder has no wallet configured" });
  const merchantSource = await resolveWalletSource(merchantAccountId);
  if (merchantSource.kind === "none") return json(res, 400, { error: "Merchant wallet not configured" });
  if (merchantSource.kind === "lnaddress") return json(res, 400, { error: "Lightning address accounts are receive-only" });
  const merchantNwcUrl = await getAccountNwcUrl(merchantAccountId);
  if (!merchantNwcUrl) return json(res, 400, { error: "Merchant wallet not available" });
  try {
   const invoice = await makeInvoice(amountSats, "openLN send from merchant", 300, cardNwcUrl);
   const { paymentHash, feeSats } = await processExternalPayment(merchantAccountId, invoice.bolt11, amountSats, undefined, "RIC send to card", merchantNwcUrl);
   logger.info({ cardId, merchantAccountId, cardAccountId, amountSats, feeSats, paymentHash }, "RIC send: payment sent to card holder");
   await db.insert(transactionsTable).values({ cardId, accountId: cardAccountId, amountSats, direction: "in", type: "receive", status: "completed", bolt11: invoice.bolt11, paymentHash, memo: "openLN send to card" });
   return json(res, 200, { status: "OK" });
  } catch (err) {
   logger.error({ cardId, merchantAccountId, cardAccountId, err }, "RIC send to card failed");
   return json(res, 500, { error: err instanceof Error ? err.message : "Payment failed" });
  }
 }

 if(u.pathname!=="/api/posbox/devices")return false; if(req.method!=="POST")return json(res,405,{error:"Method not allowed"});
 const v=await body(req);const mac=String(v.mac??v.macAddress??"").trim().toUpperCase();const claimCode=String(v.claimCode??"").trim()||null;
 if(!/^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac))return json(res,400,{error:"Invalid MAC address"});
 const [existing]=await db.select().from(posboxDevicesTable).where(eq(posboxDevicesTable.mac,mac));
 if(existing&&existing.accountId!==account?.id)return json(res,409,{error:"Device already registered",deviceId:existing.id});
 if(existing)return json(res,200,{deviceId:existing.id,mac:existing.mac,claimCode:existing.claimCode,registeredAt:existing.createdAt});
 const [device]=await db.insert(posboxDevicesTable).values({accountId:account?.id??null,mac,claimCode}).returning();return json(res,201,{deviceId:device.id,mac:device.mac,claimCode:device.claimCode,registeredAt:device.createdAt});
}
