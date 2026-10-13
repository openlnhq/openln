#!/usr/bin/env node
/**
 * Standalone exercise of the Rizful provisioning flow (module level, no web
 * app, no database). Proves the whole chain end to end against the live
 * services using the repo build and the shared provisioning browser.
 *
 *   node scripts/rizful-provision-cli.mjs [--save out.json] [--show-secrets]
 *
 * Needs: `npm run build` output in dist/ and the openln-rizful-browser
 * service reachable at RIZFUL_CDP_URL (default http://127.0.0.1:9223).
 * Secrets stay masked unless --show-secrets is passed; --save writes the
 * full result as a 0600 JSON file.
 */
import { writeFileSync } from "node:fs";
import { runRizfulFlow } from "../dist/core/money/rizfulProvision.js";

const args = process.argv.slice(2);
const saveIndex = args.indexOf("--save");
const savePath = saveIndex >= 0 ? args[saveIndex + 1] : null;
const showSecrets = args.includes("--show-secrets");
const mask = (s) => (showSecrets || !s ? s : s.slice(0, 6) + "*".repeat(Math.max(0, s.length - 12)) + s.slice(-6));

const t0 = Date.now();
console.log("Rizful provisioning run. Browser:", process.env.RIZFUL_CDP_URL || "http://127.0.0.1:9223");
try {
  const result = await runRizfulFlow({
    onStep: (step) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${step}`),
    log: (msg) => console.log("      -", msg),
  });
  console.log("");
  console.log("email:             ", result.rizfulEmail);
  console.log("login password:    ", mask(result.rizfulPassword));
  console.log("lightning address: ", result.lightningAddress);
  console.log("nwc connection:    ", result.nwcUri.slice(0, 30) + "..." + result.nwcUri.slice(-8) + ` (${result.nwcUri.length} chars)`);
  console.log("pubkey:            ", result.nostrPubkeyHex.slice(0, 12) + "...");
  if (savePath) {
    writeFileSync(savePath, JSON.stringify(result, null, 2), { mode: 0o600 });
    console.log("saved:             ", savePath);
  }
  console.log(`total: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  process.exit(0);
} catch (err) {
  console.error("");
  console.error(`FAILED after ${((Date.now() - t0) / 1000).toFixed(1)}s:`, err instanceof Error ? err.message : err);
  process.exit(1);
}
