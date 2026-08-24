import { createHash, randomBytes } from "node:crypto";
export class AuthService {
    accounts = new Map();
    sessions = new Map();
    register(handle, password) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,31}$/.test(handle))
        throw Error("Invalid handle"); if (password.length < 12)
        throw Error("Password must be at least 12 characters"); const k = handle.toLowerCase(); if (this.accounts.has(k))
        throw Error("Handle already taken"); const account = { id: randomBytes(16).toString("hex"), handle: k, createdAt: new Date().toISOString() }; this.accounts.set(k, { account, digest: this.hash(password) }); return this.newSession(account); }
    login(handle, password) { const r = this.accounts.get(handle.toLowerCase()); if (!r || r.digest !== this.hash(password))
        throw Error("Invalid handle or password"); return this.newSession(r.account); }
    authenticate(token) { const s = this.sessions.get(token); return s && new Date(s.expiresAt) > new Date() ? s.account : undefined; }
    newSession(account) { const s = { token: randomBytes(32).toString("base64url"), account, expiresAt: new Date(Date.now() + 3600000).toISOString() }; this.sessions.set(s.token, s); return s; }
    hash(v) { return createHash("sha256").update(v).digest("hex"); }
}
