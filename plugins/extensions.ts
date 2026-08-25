import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, extensionInstallsTable } from "../core/db/index.js";
import { encrypt, decrypt } from "../core/money/encrypt.js";

const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); return true; };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> { let raw = ""; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }

/** Catalog metadata: what each server-installed extension is, for the marketplace UI.
 *  Future third-party extensions (stripe, satora) register here with their config schema. */
export const EXTENSION_CATALOG: Record<string, { name: string; blurb: string; category: string; configKeys?: { key: string; label: string; secret?: boolean }[] }> = {
  cards: { name: "Cards", blurb: "Issue, freeze and wipe NTAG424 Lightning cards", category: "wallet" },
  pos: { name: "POS", blurb: "Point-of-sale terminal and device invoices", category: "commerce" },
  reports: { name: "Reports", blurb: "Payment summaries and transaction history", category: "wallet" },
  posbox: { name: "POSBOX", blurb: "Device registry, webflasher and firmware", category: "hardware" },
  shop: { name: "Shop", blurb: "Partner hardware listings", category: "commerce" },
  stripe: { name: "Stripe", blurb: "Accept Visa, Mastercard and PromptPay card payments", category: "fiat", configKeys: [{ key: "apiKey", label: "Stripe API key", secret: true }] },
  satora: { name: "Satora", blurb: "Accept on-chain and altcoin payments via satora.io", category: "crypto", configKeys: [{ key: "apiKey", label: "Satora API key", secret: true }] },
};

export async function handleExtensionsRoute(req: IncomingMessage, res: ServerResponse, u: URL, account: { id: string } | undefined): Promise<boolean> {
  if (!u.pathname.startsWith("/api/extensions")) return false;
  if (!account) return json(res, 401, { error: "Authentication required" });

  // GET /api/extensions — catalog + this account's install state
  if (req.method === "GET" && u.pathname === "/api/extensions") {
    const installs = await db.select().from(extensionInstallsTable).where(eq(extensionInstallsTable.accountId, account.id));
    const byId = new Map(installs.map(i => [i.extensionId, i]));
    const catalog = Object.entries(EXTENSION_CATALOG).map(([id, meta]) => ({
      id, ...meta,
      installed: byId.has(id),
      enabled: byId.get(id)?.enabled ?? false,
      hasConfig: !!byId.get(id)?.configEncrypted,
    }));
    return json(res, 200, { catalog });
  }

  // POST /api/extensions/:id/install
  const install = u.pathname.match(/^\/api\/extensions\/([a-z0-9-]+)\/install$/);
  if (req.method === "POST" && install) {
    const id = install[1];
    if (!EXTENSION_CATALOG[id]) return json(res, 404, { error: "Unknown extension" });
    await db.insert(extensionInstallsTable).values({ accountId: account.id, extensionId: id, enabled: true })
      .onConflictDoUpdate({ target: [extensionInstallsTable.accountId, extensionInstallsTable.extensionId], set: { enabled: true, updatedAt: new Date() } });
    return json(res, 201, { ok: true, installed: true, enabled: true });
  }

  // POST /api/extensions/:id/toggle  { enabled }
  const toggle = u.pathname.match(/^\/api\/extensions\/([a-z0-9-]+)\/toggle$/);
  if (req.method === "POST" && toggle) {
    const v = await body(req);
    const enabled = Boolean(v.enabled);
    const updated = await db.update(extensionInstallsTable)
      .set({ enabled, updatedAt: new Date() })
      .where(and(eq(extensionInstallsTable.accountId, account.id), eq(extensionInstallsTable.extensionId, toggle[1])))
      .returning({ id: extensionInstallsTable.id });
    if (!updated.length) return json(res, 404, { error: "Extension not installed" });
    return json(res, 200, { ok: true, enabled });
  }

  // POST /api/extensions/:id/config  { ...keyValues }  (encrypted at rest)
  const config = u.pathname.match(/^\/api\/extensions\/([a-z0-9-]+)\/config$/);
  if (req.method === "POST" && config) {
    const id = config[1];
    const meta = EXTENSION_CATALOG[id];
    if (!meta) return json(res, 404, { error: "Unknown extension" });
    if (!meta.configKeys?.length) return json(res, 400, { error: "This extension has no configuration" });
    const v = await body(req);
    const clean: Record<string, string> = {};
    for (const k of meta.configKeys) { const val = String(v[k.key] ?? "").trim(); if (val) clean[k.key] = val; }
    if (!Object.keys(clean).length) return json(res, 400, { error: "No valid config values provided" });
    const updated = await db.update(extensionInstallsTable)
      .set({ configEncrypted: encrypt(JSON.stringify(clean)), updatedAt: new Date() })
      .where(and(eq(extensionInstallsTable.accountId, account.id), eq(extensionInstallsTable.extensionId, id)))
      .returning({ id: extensionInstallsTable.id });
    if (!updated.length) return json(res, 404, { error: "Extension not installed" });
    return json(res, 200, { ok: true, hasConfig: true });
  }

  // DELETE /api/extensions/:id — uninstall
  const uninstall = u.pathname.match(/^\/api\/extensions\/([a-z0-9-]+)$/);
  if (req.method === "DELETE" && uninstall) {
    await db.delete(extensionInstallsTable)
      .where(and(eq(extensionInstallsTable.accountId, account.id), eq(extensionInstallsTable.extensionId, uninstall[1])));
    return json(res, 200, { ok: true, installed: false });
  }

  return json(res, 404, { error: "Not found" });
}

/** Resolve an account's stored (decrypted) config for an extension — used by payment plugins at runtime. */
export async function extensionConfig(accountId: string, extensionId: string): Promise<Record<string, string> | null> {
  const [row] = await db.select({ cfg: extensionInstallsTable.configEncrypted, enabled: extensionInstallsTable.enabled })
    .from(extensionInstallsTable)
    .where(and(eq(extensionInstallsTable.accountId, accountId), eq(extensionInstallsTable.extensionId, extensionId)));
  if (!row?.enabled || !row.cfg) return null;
  try { return JSON.parse(decrypt(row.cfg)); } catch { return null; }
}
