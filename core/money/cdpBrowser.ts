// @ts-nocheck
/**
 * Minimal Chrome DevTools Protocol client for the shared provisioning browser
 * (systemd unit openln-rizful-browser: chromium behind Xvfb, CDP on 127.0.0.1:9223).
 * Zero dependencies: Node 22+ global WebSocket plus fetch. Every provisioning
 * run gets its own incognito browser context, so no cookies survive between
 * runs and nothing is shared with openLN operations.
 *
 * The surface is deliberately tiny - navigate, evaluate JS, click coordinates,
 * screenshot, wait - because that is all the Rizful flow needs.
 *
 * Note on eval(): CdpPage.eval sends CDP Runtime.evaluate with expressions
 * built by this module (fixed strings + JSON-encoded values we generate), not
 * code from users or pages. It is the standard way to drive a page over CDP.
 */
import { writeFile } from "node:fs/promises";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CdpConnection {
  private ws: any;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private closed = false;

  private constructor(ws: any) {
    this.ws = ws;
    ws.addEventListener("message", (ev: any) => {
      let msg: any;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!;
        clearTimeout(p.timer);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`${msg.error.message || "cdp error"}${msg.error.code ? ` (${msg.error.code})` : ""}`));
        else p.resolve(msg.result ?? {});
      }
    });
    ws.addEventListener("close", () => {
      this.closed = true;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("cdp connection closed")); }
      this.pending.clear();
    });
  }

  static async connect(endpoint: string): Promise<CdpConnection> {
    const base = String(endpoint || "").replace(/\/+$/, "");
    let res: any;
    try {
      res = await fetch(base + "/json/version", { signal: AbortSignal.timeout(8000) });
    } catch {
      throw new Error("the provisioning browser is not reachable");
    }
    if (!res.ok) throw new Error(`provisioning browser is not reachable (HTTP ${res.status} at ${base})`);
    const info: any = await res.json();
    const wsUrl: string = info?.webSocketDebuggerUrl || "";
    if (!wsUrl) throw new Error("provisioning browser gave no debugger websocket");
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("provisioning browser websocket timed out")), 10000);
      ws.addEventListener("open", () => { clearTimeout(t); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("provisioning browser websocket failed")); });
    });
    return new CdpConnection(ws);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string, timeoutMs = 30000): Promise<any> {
    if (this.closed) return Promise.reject(new Error("cdp connection closed"));
    const id = this.nextId++;
    const payload: any = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`cdp ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }

  close(): void { try { this.ws.close(); } catch { /* already gone */ } }
}

export class CdpPage {
  private constructor(
    private conn: CdpConnection,
    public sessionId: string,
    public targetId: string,
    public browserContextId: string,
  ) {}

  /** Open a fresh incognito context and a page inside it. */
  static async open(conn: CdpConnection, url = "about:blank", pace = 0): Promise<CdpPage> {
    const ctx = await conn.send("Target.createBrowserContext", {});
    const target = await conn.send("Target.createTarget", { url, browserContextId: ctx.browserContextId });
    const attached = await conn.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
    const page = new CdpPage(conn, attached.sessionId, target.targetId, ctx.browserContextId);
    await conn.send("Page.enable", {}, page.sessionId).catch(() => {});
    await conn.send("Runtime.enable", {}, page.sessionId).catch(() => {});
    if (pace) await sleep(200);
    return page;
  }

  async eval(expression: string, timeoutMs = 20000): Promise<any> {
    const r: any = await this.conn.send(
      "Runtime.evaluate",
      { expression, returnByValue: true, awaitPromise: true },
      this.sessionId,
      timeoutMs,
    );
    if (r?.exceptionDetails) {
      const detail = r.exceptionDetails?.exception?.description || r.exceptionDetails?.text || "eval failed";
      throw new Error(String(detail).slice(0, 200));
    }
    return r?.result?.value;
  }

  async navigate(url: string, settleMs = 1800, pace = 0): Promise<void> {
    await this.conn.send("Page.navigate", { url }, this.sessionId, 30000);
    await sleep(pace === 0 ? Math.min(settleMs, 50) : settleMs);
  }

  async url(): Promise<string> {
    return String((await this.eval("location.href")) || "");
  }

  async bodyText(): Promise<string> {
    return String((await this.eval("document.body ? document.body.innerText : ''")) || "");
  }

  /** Poll a boolean JS expression until it is (or stops being) true. */
  async waitFor(expression: string, timeoutMs = 30000, want = true, pace = 0, intervalMs = 700): Promise<boolean> {
    const interval = pace === 0 ? 20 : intervalMs;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      let v: any = false;
      try { v = await this.eval(`!!(${expression})`); } catch { v = false; }
      if (Boolean(v) === want) return true;
      await sleep(interval);
    }
    return false;
  }

  async click(x: number, y: number): Promise<void> {
    const base = { x, y, buttons: 0 };
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseMoved", ...base }, this.sessionId).catch(() => {});
    await sleep(120);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 }, this.sessionId);
    await sleep(90);
    await this.conn.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 }, this.sessionId);
  }

  async screenshot(path: string): Promise<void> {
    try {
      const r: any = await this.conn.send("Page.captureScreenshot", { format: "png" }, this.sessionId, 30000);
      if (r?.data) await writeFile(path, Buffer.from(r.data, "base64"));
    } catch { /* best effort */ }
  }

  async close(): Promise<void> {
    try { await this.conn.send("Target.closeTarget", { targetId: this.targetId }); } catch { /* gone */ }
    try { await this.conn.send("Target.disposeBrowserContext", { browserContextId: this.browserContextId }); } catch { /* gone */ }
  }
}
