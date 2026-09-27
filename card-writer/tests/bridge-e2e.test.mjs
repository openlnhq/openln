/**
 * Bridge E2E: the JS engine drives the Python bridge over HTTP against the
 * Python card simulator. Cross-language + cross-implementation validation of
 * the full browser-reachable path (the same path a web page uses).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeBoltCard, wipeBoltCard, tapSelfTest } from "../engine/boltcard.js";
import { bytesToHex, hexToBytes } from "../engine/ntag424.js";

const here = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(here, "..", "bridge", "openln-cardbridge.py");
const PORT = 17991;
const BASE_URL = `http://127.0.0.1:${PORT}`;

const KEYS = {
  k0: "000102030405060708090a0b0c0d0e0f",
  k1: "101112131415161718191a1b1c1d1e1f",
  k2: "202122232425262728292a2b2c2d2e2f",
  k3: "303132333435363738393a3b3c3d3e3f",
  k4: "404142434445464748494a4b4c4d4e4f",
};
const URL_BASE = "lnurlw://openln.com/card/123e4567-e89b-12d3-a456-426614174000";

async function post(path, body = {}) {
  const res = await fetch(BASE_URL + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!json.ok) throw new Error(`${path} -> ${json.error}`);
  return json;
}

async function startBridge() {
  const child = spawn("python3", [BRIDGE, "--http", "--sim", "--port", String(PORT)], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (d) => { stderr += d.toString(); });
  const deadline = Date.now() + 15000;
  let lastErr;
  while (Date.now() < deadline) {
    if (child.exitCode != null) {
      throw new Error(`bridge exited early (${child.exitCode})\n${stderr}`);
    }
    try {
      const r = await fetch(BASE_URL + "/api/status");
      if (r.ok) return child;
      lastErr = new Error("status " + r.status);
    } catch (e) {
      lastErr = e;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  child.kill();
  throw new Error(`bridge did not become ready: ${lastErr}\n${stderr}`);
}

function frameReader(stream) {
  let buf = Buffer.alloc(0);
  const waiters = [];
  function pump() {
    while (waiters.length && buf.length >= 4) {
      const n = buf.readUInt32LE(0);
      if (buf.length < 4 + n) break;
      const msg = JSON.parse(buf.subarray(4, 4 + n).toString("utf8"));
      buf = buf.subarray(4 + n);
      waiters.shift()(msg);
    }
  }
  stream.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    pump();
  });
  return () => new Promise((r) => { waiters.push(r); pump(); });
}

test("bridge e2e: JS engine -> HTTP -> python bridge -> python sim (write/tap/wipe)", async () => {
  const child = await startBridge();
  try {
    const status = await (await fetch(BASE_URL + "/api/status")).json();
    assert.equal(status.ok, true);
    assert.equal(status.mode, "sim");
    assert.equal(status.bridge, "1.0.0");

    const transport = {
      transceive: async (apdu) => {
        const res = await post("/api/transceive", { apdu: bytesToHex(apdu) });
        return hexToBytes(res.response);
      },
    };

    await post("/api/sim/reset", {});

    // ── WRITE ──
    const res = await writeBoltCard({ transport, lnurlwBase: URL_BASE, keys: KEYS });
    assert.equal(res.uid, "04a1b2c3d4e580");

    const state1 = (await (await fetch(BASE_URL + "/api/sim/state")).json()).state;
    assert.equal(state1.keys[0], KEYS.k0, "python sim must accept our k0 write");
    assert.deepEqual(state1.key_versions, [1, 1, 1, 1, 1]);
    assert.equal(state1.sdm, true);
    assert.equal(state1.meta_key_no, 1);
    assert.equal(state1.file_key_no, 2);

    // ── TAP: python sim generates p=/c= (SDM), JS SUN code verifies ──
    const tap = await tapSelfTest({ transport, keys: KEYS });
    assert.equal(tap.ok, true, tap.reason);
    assert.equal(tap.uid, "04a1b2c3d4e580");
    assert.ok(tap.counter >= 1, "SDM counter must advance");

    // ── WIPE ──
    await wipeBoltCard({ transport, keys: KEYS });
    const state2 = (await (await fetch(BASE_URL + "/api/sim/state")).json()).state;
    assert.deepEqual(state2.keys, ["0".repeat(32), "0".repeat(32), "0".repeat(32), "0".repeat(32), "0".repeat(32)]);
    assert.equal(state2.ndef, "0005d101015500");
    assert.equal(state2.sdm, false);
    assert.equal(state2.settings, "40e0ee01ffff");
    assert.deepEqual(state2.key_versions, [0, 0, 0, 0, 0]);

    // ── REWRITE works after wipe ──
    await writeBoltCard({ transport, lnurlwBase: URL_BASE, keys: KEYS });
    const state3 = (await (await fetch(BASE_URL + "/api/sim/state")).json()).state;
    assert.equal(state3.keys[0], KEYS.k0);
  } finally {
    child.kill();
  }
});

test("bridge e2e: chrome native messaging framing round-trip", async () => {
  const child = spawn("python3", [BRIDGE, "--stdio", "--sim"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  try {
    const next = frameReader(child.stdout);
    const send = (obj) => {
      const b = Buffer.from(JSON.stringify(obj), "utf8");
      const len = Buffer.alloc(4);
      len.writeUInt32LE(b.length);
      child.stdin.write(Buffer.concat([len, b]));
    };

    send({ id: 1, cmd: "status" });
    const st = await next();
    assert.equal(st.id, 1);
    assert.equal(st.ok, true);
    assert.equal(st.mode, "sim");
    assert.equal(st.sim, true);

    // select NTAG424 app via the framed channel (what the extension forwards)
    send({ id: 2, cmd: "transceive", apdu: "00a4040007d27600008501010000" });
    const r2 = await next();
    assert.equal(r2.id, 2);
    assert.equal(r2.response, "9000");

    send({ id: 3, cmd: "sim_state" });
    const s3 = await next();
    assert.equal(s3.state.uid, "04a1b2c3d4e580");

    // errors must come back framed too, without killing the process
    send({ id: 4, cmd: "transceive", apdu: "zz" });
    const r4 = await next();
    assert.equal(r4.ok, false);

    send({ id: 5, cmd: "status" });
    const s5 = await next();
    assert.equal(s5.ok, true);
  } finally {
    child.kill();
  }
});
