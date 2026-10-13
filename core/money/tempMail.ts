// @ts-nocheck
/**
 * mail.tm temporary mailbox client. Rizful account creation requires clicking
 * a verification link sent by email; provisioning uses a fresh burner inbox
 * per account and keeps its credentials so later mail can still be read.
 *
 * Small on purpose: create an inbox, list messages, read one, wait for one
 * that matches. The API shape has drifted over time (arrays vs hydra
 * collections), so every list parse is defensive.
 */
const BASE = process.env.TEMPMAIL_BASE || "https://api.mail.tm";

export interface TempMailbox { address: string; password: string; token: string; }
export interface MailMessage { id: string; from: string; subject: string; }

async function call(method: string, path: string, token?: string, bodyJson?: unknown): Promise<any> {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      ...(token ? { authorization: "Bearer " + token } : {}),
    },
    body: bodyJson === undefined ? undefined : JSON.stringify(bodyJson),
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    const msg = data?.["hydra:description"] || data?.detail || data?.message || `mail.tm HTTP ${res.status}`;
    throw new Error(typeof msg === "string" ? msg : `mail.tm HTTP ${res.status}`);
  }
  return data;
}

function randToken(n: number): string {
  const abc = "abcdefghijklmnopqrstuvwxyz0123456789";
  let s = "";
  for (let i = 0; i < n; i++) s += abc[Math.floor(Math.random() * abc.length)];
  return s;
}

function listOf(data: any): any[] {
  if (Array.isArray(data)) return data;
  return data?.["hydra:member"] || [];
}

export async function createMailbox(prefix = "openln"): Promise<TempMailbox> {
  const domains = await call("GET", "/domains");
  const domain = listOf(domains).map((d: any) => (typeof d === "string" ? d : d?.domain)).filter(Boolean)[0];
  if (!domain) throw new Error("no mailbox domain is available right now");
  const password = randToken(24);
  let address = "";
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    address = `${prefix}-${randToken(10)}@${domain}`;
    try {
      await call("POST", "/accounts", undefined, { address, password });
      lastError = null;
      break;
    } catch (err) {
      lastError = err;
    }
  }
  if (lastError) throw lastError;
  const session = await call("POST", "/token", undefined, { address, password });
  if (!session?.token) throw new Error("mailbox session could not be created");
  return { address, password, token: session.token };
}

export async function listMessages(token: string): Promise<MailMessage[]> {
  const data = await call("GET", "/messages", token);
  return listOf(data).map((m: any) => ({
    id: String(m.id || ""),
    from: String(m.from?.address || m.from || ""),
    subject: String(m.subject || ""),
  }));
}

export async function readMessage(token: string, id: string): Promise<string> {
  const data = await call("GET", "/messages/" + encodeURIComponent(id), token);
  const html = Array.isArray(data?.html) ? data.html.join("\n") : data?.html || "";
  const text = data?.text || "";
  return `${text}\n${html}`;
}

export async function waitForMessage(
  token: string,
  match: (m: MailMessage) => boolean,
  timeoutMs = 180000,
  intervalMs = 4000,
): Promise<MailMessage> {
  const start = Date.now();
  let lastSweep: MailMessage[] = [];
  while (Date.now() - start < timeoutMs) {
    try {
      lastSweep = await listMessages(token);
      const hit = lastSweep.find(match);
      if (hit) return hit;
    } catch { /* transient; keep polling */ }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`no matching email arrived within ${Math.round(timeoutMs / 1000)}s (${lastSweep.length} messages seen)`);
}
