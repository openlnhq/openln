/**
 * Web POS item catalog routes. Session-authenticated only: RIC device tokens are
 * already refused upstream (they are restricted to the firmware protocol paths in
 * core/server.ts), so these routes never need device handling.
 *
 *   GET    /api/pos/items        list this account's items (sorted)
 *   POST   /api/pos/items        create an item {name, price, description?, photo?}
 *   PATCH  /api/pos/items/:id    update some fields
 *   DELETE /api/pos/items/:id    remove an item
 *
 * Prices are decimal strings in the account's currency (up to 2 decimals).
 * Photos must be small image data URLs; the client downscales before upload.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, asc, eq, sql } from "drizzle-orm";
import { db, posItemsTable } from "../core/db/index.js";

const json = (r: ServerResponse, s: number, b: unknown) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); return true; };
async function body(req: IncomingMessage): Promise<Record<string, unknown>> { let raw = ""; for await (const c of req) raw += c; return raw ? JSON.parse(raw) : {}; }

const NAME_MAX = 60, DESC_MAX = 200, PHOTO_MAX = 60000, ITEMS_MAX = 100, PRICE_MAX = 1_000_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface ItemInput { name?: string; price?: string; description?: string | null; photo?: string | null; sort?: number; }
type Check = { error: string } | { value: ItemInput };

function checkInput(v: Record<string, unknown>, partial: boolean): Check {
  const out: ItemInput = {};
  if (partial && v.name === undefined && v.price === undefined && v.description === undefined && v.photo === undefined && v.sort === undefined) {
    return { error: "Nothing to update" };
  }
  if (v.name !== undefined || !partial) {
    const name = String(v.name ?? "").trim();
    if (!name || name.length > NAME_MAX) return { error: `Name must be 1 to ${NAME_MAX} characters` };
    out.name = name;
  }
  if (v.price !== undefined || !partial) {
    const n = typeof v.price === "number" ? v.price : Number(String(v.price ?? "").trim());
    if (!Number.isFinite(n) || n <= 0 || n > PRICE_MAX) return { error: "Price must be a positive number" };
    out.price = String(Math.round(n * 100) / 100);
  }
  if (v.description !== undefined) {
    const d = String(v.description ?? "").trim();
    if (d.length > DESC_MAX) return { error: `Description must be under ${DESC_MAX} characters` };
    out.description = d || null;
  }
  if (v.photo !== undefined) {
    if (v.photo === null || v.photo === "") out.photo = null;
    else {
      const p = String(v.photo);
      if (!/^data:image\/(png|jpe?g|webp);base64,/i.test(p) || p.length > PHOTO_MAX) return { error: "Photo must be a small image" };
      out.photo = p;
    }
  }
  if (v.sort !== undefined) {
    const s = Number(v.sort);
    if (!Number.isInteger(s) || s < 0 || s > 10000) return { error: "Invalid sort value" };
    out.sort = s;
  }
  return { value: out };
}

export async function handlePosItemsRoute(req: IncomingMessage, res: ServerResponse, u: URL, account: { id: string } | undefined): Promise<boolean> {
  if (!u.pathname.startsWith("/api/pos/items")) return false;
  if (!account) return json(res, 401, { error: "Authentication required" });

  if (req.method === "GET" && u.pathname === "/api/pos/items") {
    const items = await db.select().from(posItemsTable).where(eq(posItemsTable.accountId, account.id)).orderBy(asc(posItemsTable.sort), asc(posItemsTable.createdAt));
    return json(res, 200, { items });
  }

  if (req.method === "POST" && u.pathname === "/api/pos/items") {
    const v = await body(req);
    const check = checkInput(v, false);
    if ("error" in check) return json(res, 400, { error: check.error });
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(posItemsTable).where(eq(posItemsTable.accountId, account.id));
    if (n >= ITEMS_MAX) return json(res, 400, { error: `Item limit reached (${ITEMS_MAX} items)` });
    const [item] = await db.insert(posItemsTable).values({
      accountId: account.id,
      name: check.value.name as string,
      price: check.value.price as string,
      description: check.value.description ?? null,
      photo: check.value.photo ?? null,
      sort: check.value.sort ?? n,
    }).returning();
    return json(res, 201, { item });
  }

  const one = u.pathname.match(/^\/api\/pos\/items\/([^/]+)$/);
  if (one && !UUID_RE.test(one[1])) return json(res, 404, { error: "Item not found" });

  if (one && req.method === "PATCH") {
    const v = await body(req);
    const check = checkInput(v, true);
    if ("error" in check) return json(res, 400, { error: check.error });
    const [item] = await db.update(posItemsTable).set({ ...check.value, updatedAt: new Date() })
      .where(and(eq(posItemsTable.id, one[1]), eq(posItemsTable.accountId, account.id))).returning();
    if (!item) return json(res, 404, { error: "Item not found" });
    return json(res, 200, { item });
  }

  if (one && req.method === "DELETE") {
    const [gone] = await db.delete(posItemsTable)
      .where(and(eq(posItemsTable.id, one[1]), eq(posItemsTable.accountId, account.id))).returning({ id: posItemsTable.id });
    if (!gone) return json(res, 404, { error: "Item not found" });
    return json(res, 200, { ok: true });
  }

  return false;
}
