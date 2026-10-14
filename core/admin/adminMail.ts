/**
 * Admin mail console - the platform ops inbox over IMAP (list/read/delete)
 * and SMTP (send).
 *
 * Mailbox config is env-only (MAIL_IMAP_HOST, MAIL_IMAP_PORT, MAIL_SMTP_HOST,
 * MAIL_SMTP_PORT, MAIL_USER, MAIL_PASS, MAIL_FROM); host addresses never live
 * in the repo. Same admin gate as the treasury/userbase consoles
 * (./adminAuth.js): X-Admin-Secret header, or a resolved session account whose
 * entity handle is in the ADMIN_HANDLES allowlist.
 *
 * Routes (all admin-only):
 *   GET  /api/admin/mail?folder=INBOX&limit=25&offset=0  message list + unread count
 *   GET  /api/admin/mail/folders                         selectable folders
 *   GET  /api/admin/mail/message?uid=1&folder=INBOX      one message (marks it seen)
 *   POST /api/admin/mail/send                            {to, subject, text}
 *   POST /api/admin/mail/delete                          {uid, folder}
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { ImapFlow, type ListResponse, type MessageAddressObject } from "imapflow";
import { simpleParser, type ParsedMail } from "mailparser";
import { htmlToText } from "html-to-text";
import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { isAdmin, type AdminSessionAccount } from "./adminAuth.js";

type SessionAccount = AdminSessionAccount;

const json = (r: ServerResponse, s: number, b: unknown): true => {
  r.writeHead(s, { "content-type": "application/json" });
  r.end(JSON.stringify(b));
  return true;
};

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = "";
  for await (const c of req) raw += c;
  if (!raw) return {};
  if ((req.headers["content-type"] ?? "").includes("application/x-www-form-urlencoded")) {
    return Object.fromEntries(new URLSearchParams(raw));
  }
  return JSON.parse(raw);
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
type MailCfg = {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  user: string;
  pass: string;
  fromHeader: string;
  fromAddress: string;
};

export function mailConfigured(): boolean {
  return Boolean(
    process.env.MAIL_IMAP_HOST && process.env.MAIL_SMTP_HOST && process.env.MAIL_USER && process.env.MAIL_PASS,
  );
}

function mailCfg(): MailCfg | null {
  if (!mailConfigured()) return null;
  const user = process.env.MAIL_USER as string;
  const fromRaw = (process.env.MAIL_FROM || user).trim();
  const angle = fromRaw.match(/<([^>]+)>/);
  return {
    imapHost: process.env.MAIL_IMAP_HOST as string,
    imapPort: clampInt(process.env.MAIL_IMAP_PORT, 993, 1, 65535),
    smtpHost: process.env.MAIL_SMTP_HOST as string,
    smtpPort: clampInt(process.env.MAIL_SMTP_PORT, 465, 1, 65535),
    user,
    pass: process.env.MAIL_PASS as string,
    fromHeader: fromRaw,
    fromAddress: (angle ? angle[1] : fromRaw).trim(),
  };
}

function clampInt(raw: string | null | undefined, dflt: number, min: number, max: number): number {
  const n = parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
}

const OP_TIMEOUT_MS = 30000;

function raceTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Timed out after " + Math.round(ms / 1000) + "s")), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });
}

async function withImap<T>(cfg: MailCfg, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: cfg.imapHost,
    port: cfg.imapPort,
    secure: true,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    greetingTimeout: 15000,
    socketTimeout: 25000,
  });
  try {
    await raceTimeout(client.connect(), 20000);
    return await raceTimeout(fn(client), OP_TIMEOUT_MS);
  } finally {
    try {
      await client.logout();
    } catch {
      try { client.close(); } catch { /* socket already gone */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Folders
// ---------------------------------------------------------------------------
type FolderInfo = { path: string; name: string; specialUse: string | null };

function specialOf(b: ListResponse): string | null {
  const raw = (b as unknown as { specialUse?: unknown }).specialUse;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) return raw.map(String).join(",");
  return null;
}

async function listFolders(c: ImapFlow): Promise<FolderInfo[]> {
  const boxes = await c.list();
  const out: FolderInfo[] = [];
  for (const b of boxes ?? []) {
    if (!b || !b.path) continue;
    if (b.flags && b.flags.has("\\Noselect")) continue;
    out.push({ path: String(b.path), name: String(b.name || b.path), specialUse: specialOf(b) });
  }
  const rank = (f: FolderInfo): number => {
    const s = (f.specialUse || "").toLowerCase();
    if (f.path.toUpperCase() === "INBOX") return 0;
    if (s.includes("sent") || /sent/i.test(f.name)) return 1;
    if (s.includes("draft")) return 2;
    if (s.includes("junk") || /spam/i.test(f.name)) return 3;
    if (s.includes("trash") || /trash/i.test(f.name)) return 4;
    return 5;
  };
  out.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
  return out.slice(0, 40);
}

async function resolveFolder(
  c: ImapFlow,
  requested: string | null | undefined,
): Promise<{ path: string; folders: FolderInfo[]; resolved: boolean }> {
  const folders = await listFolders(c);
  const want = (requested || "INBOX").trim();
  const hit =
    folders.find((f) => f.path.toLowerCase() === want.toLowerCase()) ||
    folders.find((f) => f.name.toLowerCase() === want.toLowerCase());
  if (hit) return { path: hit.path, folders, resolved: true };
  if (want.toUpperCase() === "INBOX") return { path: "INBOX", folders, resolved: true };
  return { path: "INBOX", folders, resolved: false };
}

// ---------------------------------------------------------------------------
// Address helpers
// ---------------------------------------------------------------------------
type Addr = { name: string | null; address: string | null };

function addrList(v: unknown): Addr[] {
  const arr = Array.isArray(v) ? v : v ? [v] : [];
  const out: Addr[] = [];
  for (const a of arr) {
    const o = a as MessageAddressObject | undefined;
    const name = o && typeof o.name === "string" ? o.name : null;
    const address = o && typeof o.address === "string" ? o.address : null;
    if (name || address) out.push({ name, address });
  }
  return out;
}

function addrText(list: Addr[]): string {
  return list
    .map((a) => (a.name && a.address ? `${a.name} <${a.address}>` : a.address || a.name || ""))
    .filter(Boolean)
    .join(", ");
}

// ---------------------------------------------------------------------------
// Body text
// ---------------------------------------------------------------------------
// Newsletters commonly carry an empty text/plain part (or none at all) with
// the content only in HTML; mailparser's own fallback does not fire for those
// shapes, so convert the HTML explicitly when the text part is blank.
function mailBodyText(parsed: ParsedMail | null): string {
  if (!parsed) return "(This message has no readable text content.)";
  const rawText = parsed.text || "";
  if (rawText.trim()) return rawText;
  if (parsed.html) {
    const clean = htmlToText(parsed.html, {
      wordwrap: false,
      selectors: [
        { selector: "a", options: { ignoreHref: true } },
        { selector: "img", format: "skip" },
      ],
    }).trim();
    if (clean) return clean;
    // Image-only marketing mail: the skip pass leaves nothing, so keep the
    // raw conversion (image srcs as bracket tokens) rather than lose it.
    const withTokens = htmlToText(parsed.html, {
      wordwrap: false,
      selectors: [{ selector: "a", options: { ignoreHref: true } }],
    }).trim();
    if (withTokens) return withTokens;
  }
  return "(This message has no readable text content.)";
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[^\s@,;<>]+@[^\s@,;<>]+\.[A-Za-z]{2,}$/;

export function parseRecipients(raw: string): { addresses: string[]; invalid: string[] } {
  const parts = String(raw || "")
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean);
  const addresses: string[] = [];
  const invalid: string[] = [];
  for (const p of parts) {
    const m = p.match(/<([^>]+)>\s*$/);
    const addr = (m ? m[1] : p).trim();
    if (EMAIL_RE.test(addr)) {
      if (!addresses.includes(addr)) addresses.push(addr);
    } else {
      invalid.push(p);
    }
  }
  return { addresses: addresses.slice(0, 5), invalid };
}

async function buildRaw(cfg: MailCfg, to: string[], subject: string, text: string): Promise<Buffer> {
  const builder = nodemailer.createTransport({ streamTransport: true, buffer: true });
  const info = await builder.sendMail({ from: cfg.fromHeader, to: to.join(", "), subject, text });
  const msg = (info as { message?: unknown }).message;
  if (!Buffer.isBuffer(msg)) throw new Error("Could not build the message");
  return msg;
}

let smtpPool: Transporter | null = null;
let smtpPoolKey = "";

function smtpFor(cfg: MailCfg): Transporter {
  const key = `${cfg.smtpHost}:${cfg.smtpPort}:${cfg.user}`;
  if (!smtpPool || smtpPoolKey !== key) {
    try { smtpPool?.close(); } catch { /* closing a dead pool is fine */ }
    smtpPool = nodemailer.createTransport({
      host: cfg.smtpHost,
      port: cfg.smtpPort,
      secure: cfg.smtpPort === 465,
      auth: { user: cfg.user, pass: cfg.pass },
      pool: true,
      maxConnections: 1,
      maxMessages: 50,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 30000,
    });
    smtpPoolKey = key;
  }
  return smtpPool;
}

const RETRYABLE_SMTP = new Set(["ECONNECTION", "ETIMEDOUT", "ESOCKET", "ECONNRESET", "EPIPE"]);

async function sendSmtp(cfg: MailCfg, raw: Buffer, to: string[]): Promise<void> {
  const envelope = { from: cfg.fromAddress, to };
  try {
    await smtpFor(cfg).sendMail({ envelope, raw });
  } catch (e) {
    const code = (e as { code?: string }).code ?? "";
    if (!RETRYABLE_SMTP.has(code)) throw e;
    // A stale pooled socket can fail once; reset the pool and retry a single time.
    try { smtpPool?.close(); } catch { /* pool already dead */ }
    smtpPool = null;
    await smtpFor(cfg).sendMail({ envelope, raw });
  }
}

async function appendToSent(cfg: MailCfg, raw: Buffer): Promise<boolean> {
  try {
    return await withImap(cfg, async (c) => {
      const { folders } = await resolveFolder(c, null);
      const sent =
        folders.find((f) => (f.specialUse || "").toLowerCase().includes("sent")) ||
        folders.find((f) => /sent/i.test(f.name));
      if (!sent) return false;
      await c.append(sent.path, raw, ["\\Seen"]);
      return true;
    });
  } catch {
    return false; // the send already succeeded; filing in Sent is best effort
  }
}

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------
function mailErrorText(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/authentication|invalid credentials|login failed|auth/i.test(msg)) return "Mailbox login failed. Check the mail credentials.";
  if (/timed out|timeout|etimedout/i.test(msg)) return "The mail server did not answer in time.";
  if (/econnrefused|enotfound|econnreset|getaddrinfo|not reachable/i.test(msg)) return "The mail server is not reachable.";
  return msg.length > 300 ? "Mail operation failed." : `Mail operation failed. ${msg}`;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------
export async function handleAdminMailRoute(
  req: IncomingMessage,
  res: ServerResponse,
  u: URL,
  sessionAccount: SessionAccount,
): Promise<boolean> {
  if (!u.pathname.startsWith("/api/admin/mail")) return false;

  const admin = await isAdmin(req, sessionAccount);
  if (!admin) {
    return json(res, sessionAccount ? 403 : 401, {
      error: sessionAccount ? "Admin access required" : "Unauthorized",
    });
  }

  const cfg = mailCfg();
  if (!cfg) return json(res, 503, { error: "Mail is not configured on this host", code: "not_configured" });

  // -- GET /api/admin/mail/folders -----------------------------------------
  if (req.method === "GET" && u.pathname === "/api/admin/mail/folders") {
    try {
      const folders = await withImap(cfg, async (c) => listFolders(c));
      return json(res, 200, { folders });
    } catch (e) {
      return json(res, 502, { error: mailErrorText(e) });
    }
  }

  // -- GET /api/admin/mail/message?uid&folder ------------------------------
  if (req.method === "GET" && u.pathname === "/api/admin/mail/message") {
    const uid = clampInt(u.searchParams.get("uid"), 0, 1, 2000000000);
    if (!uid) return json(res, 400, { error: "uid is required" });
    try {
      const out = await withImap(cfg, async (c) => {
        const { path, resolved } = await resolveFolder(c, u.searchParams.get("folder"));
        if (!resolved) return { found: false, unknownFolder: true };
        const lock = await c.getMailboxLock(path);
        try {
          const msg = await c.fetchOne(
            uid,
            { uid: true, envelope: true, flags: true, source: { maxLength: 1500000 } },
            { uid: true },
          );
          if (!msg || !msg.source) return { found: false };
          let parsed = null;
          try { parsed = await simpleParser(msg.source); } catch { parsed = null; }
          const wasSeen = Boolean(msg.flags && msg.flags.has("\\Seen"));
          if (!wasSeen) {
            try { await c.messageFlagsAdd(uid, ["\\Seen"], { uid: true }); } catch { /* flag is cosmetic */ }
          }
          const from = parsed && parsed.from ? addrList(parsed.from.value) : addrList(msg.envelope?.from);
          const to = parsed && parsed.to ? addrList(Array.isArray(parsed.to) ? parsed.to[0]?.value ?? [] : parsed.to.value) : addrList(msg.envelope?.to);
          const date = parsed && parsed.date
            ? parsed.date.toISOString()
            : msg.envelope && msg.envelope.date
              ? new Date(msg.envelope.date).toISOString()
              : null;
          return {
            found: true,
            uid,
            folder: path,
            seen: true,
            subject: (parsed && parsed.subject) || (msg.envelope && msg.envelope.subject) || "(no subject)",
            from,
            to,
            date,
            text: mailBodyText(parsed),
            attachments: parsed
              ? (parsed.attachments || []).slice(0, 10).map((a) => ({
                  filename: a.filename || "attachment",
                  size: typeof a.size === "number" ? a.size : 0,
                  mime: a.contentType || "",
                }))
              : [],
          };
        } finally {
          lock.release();
        }
      });
      if ((out as { unknownFolder?: boolean }).unknownFolder) return json(res, 400, { error: "Unknown folder" });
      if (!(out as { found?: boolean }).found) return json(res, 404, { error: "Message not found" });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 502, { error: mailErrorText(e) });
    }
  }

  // -- GET /api/admin/mail?folder&limit&offset ------------------------------
  if (req.method === "GET" && u.pathname === "/api/admin/mail") {
    const limit = clampInt(u.searchParams.get("limit"), 25, 1, 50);
    const offset = clampInt(u.searchParams.get("offset"), 0, 0, 5000);
    try {
      const out = await withImap(cfg, async (c) => {
        const { path } = await resolveFolder(c, u.searchParams.get("folder"));
        const lock = await c.getMailboxLock(path);
        try {
          const total = c.mailbox ? c.mailbox.exists ?? 0 : 0;
          const messages: Record<string, unknown>[] = [];
          if (total > 0) {
            const end = Math.max(1, total - offset);
            const start = Math.max(1, end - limit + 1);
            if (end >= start) {
              for await (const m of c.fetch(`${start}:${end}`, { uid: true, envelope: true, flags: true })) {
                messages.push({
                  uid: m.uid,
                  seen: Boolean(m.flags && m.flags.has("\\Seen")),
                  flagged: Boolean(m.flags && m.flags.has("\\Flagged")),
                  subject: (m.envelope && m.envelope.subject) || "(no subject)",
                  date: m.envelope && m.envelope.date ? new Date(m.envelope.date).toISOString() : null,
                  from: addrList(m.envelope?.from),
                  to: addrList((m.envelope?.to ?? []).slice(0, 3)),
                  fromText: addrText(addrList(m.envelope?.from)),
                });
              }
            }
          }
          messages.reverse();
          let unread = 0;
          try {
            const found = await c.search({ seen: false }, { uid: true });
            unread = Array.isArray(found) ? found.length : 0;
          } catch { unread = -1; }
          return { folder: path, total, unread, messages };
        } finally {
          lock.release();
        }
      });
      return json(res, 200, out);
    } catch (e) {
      return json(res, 502, { error: mailErrorText(e) });
    }
  }

  // -- POST /api/admin/mail/send -------------------------------------------
  if (req.method === "POST" && u.pathname === "/api/admin/mail/send") {
    let v: Record<string, unknown>;
    try { v = await body(req); } catch { return json(res, 400, { error: "Bad request body" }); }
    const toRaw = typeof v.to === "string" ? v.to : "";
    const subject = typeof v.subject === "string" ? v.subject.replace(/[\r\n]+/g, " ").trim().slice(0, 200) : "";
    const text = typeof v.text === "string" ? v.text.slice(0, 200000) : "";
    const { addresses, invalid } = parseRecipients(toRaw);
    if (invalid.length) return json(res, 400, { error: `Check ${invalid.length === 1 ? "this address" : "these addresses"}: ${invalid.join(", ")}` });
    if (!addresses.length) return json(res, 400, { error: "Add at least one recipient" });
    if (!text.trim()) return json(res, 400, { error: "The message body is empty" });
    try {
      const raw = await buildRaw(cfg, addresses, subject, text);
      await sendSmtp(cfg, raw, addresses);
      const sentSaved = await appendToSent(cfg, raw);
      return json(res, 200, { ok: true, to: addresses, sentSaved });
    } catch (e) {
      return json(res, 502, { error: mailErrorText(e) });
    }
  }

  // -- POST /api/admin/mail/delete -----------------------------------------
  if (req.method === "POST" && u.pathname === "/api/admin/mail/delete") {
    let v: Record<string, unknown>;
    try { v = await body(req); } catch { return json(res, 400, { error: "Bad request body" }); }
    const uid = clampInt(typeof v.uid === "number" ? String(v.uid) : typeof v.uid === "string" ? v.uid : null, 0, 1, 2000000000);
    if (!uid) return json(res, 400, { error: "uid is required" });
    const folderReq = typeof v.folder === "string" ? v.folder : null;
    try {
      const out = await withImap(cfg, async (c) => {
        const { path, folders, resolved } = await resolveFolder(c, folderReq);
        if (!resolved) throw new Error("Unknown folder");
        const trash =
          folders.find((f) => (f.specialUse || "").toLowerCase().includes("trash")) ||
          folders.find((f) => /trash/i.test(f.name));
        const lock = await c.getMailboxLock(path);
        try {
          // Verify the uid exists first: MOVE/DELETE of a missing uid is an
          // IMAP no-op that still answers OK, which would read as success.
          const exists = await c.fetchOne(uid, { uid: true }, { uid: true });
          if (!exists) return { moved: "missing", folder: path };
          if (trash && trash.path.toLowerCase() !== path.toLowerCase()) {
            await c.messageMove(uid, trash.path, { uid: true });
            return { moved: "trash", folder: path };
          }
          await c.messageDelete(uid, { uid: true });
          return { moved: "deleted", folder: path };
        } finally {
          lock.release();
        }
      });
      if (out.moved === "missing") return json(res, 404, { error: "Message not found" });
      return json(res, 200, { ok: true, ...out });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "";
      if (msg === "Unknown folder") return json(res, 400, { error: msg });
      return json(res, 502, { error: mailErrorText(e) });
    }
  }

  return json(res, 404, { error: "Unknown mail route" });
}
