# openLN

Open-source, non-custodial Lightning commerce platform. Wallet is core; cards, POS, POSBOX, reports, and shop are compile-time plugins.

Phase 1 skeleton; money path intentionally deferred to Phase 2 browser-shaped verification.

```sh
pnpm install && pnpm typecheck && pnpm build
PORT=3001 node dist/core/server.js
curl http://127.0.0.1:3001/health
```
