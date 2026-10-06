/**
 * Shared admin gate for the /api/admin/* console routes (treasury + userbase).
 *
 * X-Admin-Secret header matching ADMIN_SECRET, OR a resolved session account
 * whose entity handle is in the ADMIN_HANDLES allowlist. Same security
 * semantics as the heritage bitPOS requireAdmin: secret checked first, then
 * session + handle allowlist.
 */
import type { IncomingMessage } from "node:http";

export const ADMIN_HANDLES = new Set(
  (process.env.ADMIN_HANDLES ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

export function adminSecretOk(req: IncomingMessage): boolean {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) return false;
  const provided = req.headers["x-admin-secret"];
  const val = Array.isArray(provided) ? provided[0] : provided;
  return !!val && val === secret;
}

export type AdminSessionAccount = { id: string; handle: string; createdAt: string } | undefined;

export async function isAdmin(req: IncomingMessage, sessionAccount: AdminSessionAccount): Promise<boolean> {
  if (adminSecretOk(req)) return true;
  if (!sessionAccount) return false;
  return ADMIN_HANDLES.has(sessionAccount.handle.toLowerCase());
}
