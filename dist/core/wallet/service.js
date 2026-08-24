export class WalletService {
    connections = new Map();
    connectNwc(accountId, connectionString) { if (!connectionString.startsWith("nostr+walletconnect://"))
        throw Error("Invalid NWC connection string"); const v = { mode: "nwc", connected: true, createdAt: new Date().toISOString() }; this.connections.set(accountId, v); return v; }
    status(accountId) { return this.connections.get(accountId) ?? null; }
}
