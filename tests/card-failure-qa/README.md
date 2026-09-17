# Card insufficient-balance regression suite

Required explicit CI commands from repository root (Node 22.23+):

```sh
npm ci --prefix tests/card-failure-qa --ignore-scripts --no-audit --no-fund
npm test --prefix tests/card-failure-qa
```

Dependencies are pinned here and in package-lock.json; root package files are unchanged. This nested suite is **not** included by the root `tests/*.test.mjs` glob: CI must run the command above. Missing dependencies fail rather than silently skip.

The suite runs actual card callback, card claim, and feeEngine code with a mocked wallet transport and real SQL/Drizzle against ephemeral in-memory PGlite PostgreSQL. It also executes the actual invoice-status route block and ricInvoiceView. No server is deployed/listening; no credentials, production database, or live wallet are used. Source modules load from normal core/plugins paths (flat staging source fallback for the repair workspace).

Coverage: typed k1-bound definitive failure; actual 1500 ms deadline and late rejection; lost response/reloaded-module durable status; ambiguous timeout; generic messages; settlement winning failure CAS; failed DB finalization; invoice paid/accepted/forwarding/terminal precedence; competing outgoing attempts and newer claims; exact hash/invoice/owner correlation; late success; proof-read failure; real status-route authorization and response fields.
