import { createServer } from "node:http";
import { AuthService } from "./auth/service.js";
import { WalletService } from "./wallet/service.js";
import { PluginRegistry } from "./plugins/api.js";
const auth = new AuthService();
const wallet = new WalletService();
const registry = new PluginRegistry();
const json = (r, s, b) => { r.writeHead(s, { "content-type": "application/json" }); r.end(JSON.stringify(b)); };
const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://localhost");
    if (req.method === "GET" && u.pathname === "/health")
        return json(res, 200, { status: "ok", service: "openln-core", plugins: registry.list().map(p => p.id) });
    if (req.method === "GET" && u.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<!doctype html><title>openLN</title><main><h1>openLN</h1><p>Non-custodial Lightning workspace</p><a href="/app">Open wallet</a></main>');
    }
    if (req.method === "GET" && u.pathname === "/app") {
        res.writeHead(200, { "content-type": "text/html" });
        return res.end('<!doctype html><title>Wallet | openLN</title><main><h1>Wallet</h1><p>Connect your own NWC wallet to receive and send sats.</p><form method="post" action="/api/wallet/connect"><input name="connection" placeholder="nostr+walletconnect://…"><button>Connect wallet</button></form></main>');
    }
    if (req.method === "GET" && u.pathname === "/api/plugins")
        return json(res, 200, registry.list());
    if (req.method === "POST" && u.pathname === "/api/auth/register") {
        let b = "";
        for await (const c of req)
            b += c;
        try {
            const v = JSON.parse(b);
            return json(res, 201, auth.register(v.handle ?? "", v.password ?? ""));
        }
        catch (e) {
            return json(res, 400, { error: e instanceof Error ? e.message : "Invalid request" });
        }
    }
    return json(res, 404, { error: "Not found" });
});
const port = Number(process.env.PORT ?? 3001);
server.listen({ port, host: "0.0.0.0" }, () => console.log(`openLN core listening on ${port}`));
export { auth, wallet, registry };
