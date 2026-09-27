/**
 * openLN card writer engine loader for the merchant app (/app).
 *
 * The app loads this file on demand (module script) when the user writes or
 * wipes a card; it exposes the NTAG424 engine as window.openlnCardEngine so
 * the inline app script can drive a local reader bridge.
 */
import * as boltcard from "./engine/boltcard.js";

window.openlnCardEngine = boltcard;
window.dispatchEvent(new Event("openln-card-engine"));
