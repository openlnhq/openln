#!/usr/bin/env python3
"""
openLN Card Bridge — local APDU transport that lets a web page program
NTAG424 DNA Bolt Cards, with no Play Store app anywhere in the loop.

Why a bridge: the browser cannot speak PC/SC. Web NFC is NDEF-only (and
Android-only), WebUSB refuses the smart-card interface class (0x0B), and the
Web Smart Card API is ChromeOS-only. This bridge runs on the machine where
the USB NFC reader is plugged in and exposes raw APDU transceive through two
channels:

  * Chrome native messaging (default, stdio + 4-byte LE length frames) —
    paired with the bundled Chrome extension. A web page calls
    window.openlnBridge.request(...); the extension relays to this process.
  * Local HTTP API (--http, default http://127.0.0.1:17777) — serves the
    card-writer webapp plus a small JSON API; pages on openln.com origins
    may call it directly (CORS allow-listed) when the extension is absent.

Hardware mode needs pyscard (`pip install pyscard`) and a PC/SC stack
(pcscd on Linux). With --sim — or when no reader is present — an in-process
NTAG424 DNA simulator (cardsim.py) takes over so the full write/wipe flow
can be exercised with zero hardware.

Commands (both channels, JSON):
  status | connect {reader?} | disconnect | transceive {apdu} | uid
  sim_reset {uid?, keys?} | sim_state

The bridge only ever talks to locally attached hardware or the simulator.
It never touches the network, keys, or provisioning data itself — the
webapp drives the protocol; this process is a wire.
"""

import argparse
import json
import os
import re
import struct
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

VERSION = "1.0.0"
DEFAULT_PORT = 17777
MAX_APDU = 1024

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT_DIR = os.path.dirname(BASE_DIR)
WEB_DIR = os.path.join(ROOT_DIR, "web")
ENGINE_DIR = os.path.join(ROOT_DIR, "engine")

DEFAULT_ORIGINS = [
    r"^https://(openln\.com|www\.openln\.com|dev\.openln\.com)$",
    r"^http://(localhost|127\.0\.0\.1)(:\d+)?$",
    r"^http://(10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|100\.\d+\.\d+\.\d+)(:\d+)?$",
    r"^null$",  # file:// pages
]


def log(*a):
    print(*a, file=sys.stderr, flush=True)


# ── transports ──────────────────────────────────────────────────────────────

class TransportHub:
    """Owns whichever transport is active: a PC/SC reader or the simulator."""

    def __init__(self, args):
        self.args = args
        self.lock = threading.Lock()
        self.mode = None
        self.sim = None
        self.reader_name = None
        self.reader_index = None
        self.connection = None
        self.note = None
        self._reader_names = []
        if args.sim:
            self.mode = "sim"
            self._init_sim()
        else:
            self._detect_pcsc()

    # -- setup --------------------------------------------------------------

    def _init_sim(self, uid=None, keys=None):
        from cardsim import CardSim
        self.sim = CardSim(uid=uid or "04a1b2c3d4e580", keys=keys)

    def _detect_pcsc(self):
        try:
            from smartcard.System import readers
        except Exception as e:  # pyscard missing
            self.mode = "sim"
            self.note = f"pyscard unavailable ({e}); running with the card simulator"
            self._init_sim()
            return
        try:
            self._reader_names = [str(r) for r in readers()]
        except Exception as e:
            self.mode = "sim"
            self.note = f"PC/SC unavailable ({e}); running with the card simulator"
            self._init_sim()
            return
        if not self._reader_names:
            self.mode = "sim"
            self.note = "no PC/SC reader found; running with the card simulator"
            self._init_sim()
            return
        self.mode = "pcsc"
        self._select_reader(self.args.reader)

    def _select_reader(self, spec):
        if not self._reader_names:
            raise RuntimeError("no PC/SC readers present")
        if spec is None:
            self.reader_index = 0
        elif spec.isdigit():
            idx = int(spec)
            if idx >= len(self._reader_names):
                raise RuntimeError(f"reader index {idx} out of range")
            self.reader_index = idx
        else:
            matches = [i for i, n in enumerate(self._reader_names) if spec.lower() in n.lower()]
            if not matches:
                raise RuntimeError(f"no reader matching {spec!r}")
            self.reader_index = matches[0]
        self.reader_name = self._reader_names[self.reader_index]
        self.connection = None

    # -- operations ---------------------------------------------------------

    def connect(self, reader=None):
        if self.mode == "sim":
            return {"reader": "simulator"}
        if reader is not None:
            self._select_reader(reader)
        if self.connection is None:
            from smartcard.System import readers
            assert self.reader_index is not None
            rdr = readers()[self.reader_index]
            conn = rdr.createConnection()
            conn.connect()
            self.connection = conn
        return {"reader": self.reader_name}

    def disconnect(self):
        if self.connection is not None:
            try:
                self.connection.disconnect()
            except Exception:
                pass
            self.connection = None
        return {}

    def transceive(self, apdu: bytes) -> bytes:
        if len(apdu) == 0 or len(apdu) > MAX_APDU:
            raise ValueError(f"APDU length {len(apdu)} out of range")
        with self.lock:
            if self.mode == "sim":
                assert self.sim is not None
                return self.sim.transceive(apdu)
            last_err = None
            for attempt in (1, 2):
                try:
                    self.connect()
                    conn = self.connection
                    assert conn is not None
                    data, sw1, sw2 = conn.transmit(list(apdu))
                    return bytes(bytearray(data)) + bytes([sw1, sw2])
                except Exception as e:
                    last_err = e
                    self.disconnect()
            raise RuntimeError(
                f"card communication failed ({last_err}); "
                "check that the card is on the reader and no other app is using it"
            )

    def uid(self):
        with self.lock:
            if self.mode == "sim":
                assert self.sim is not None
                resp = self.sim.transceive(bytes([0xFF, 0xCA, 0x00, 0x00, 0x00]))
                sw = resp[-2:]
                if sw != b"\x90\x00":
                    raise RuntimeError(f"UID read failed (SW {sw.hex()})")
                return {"uid": resp[:-2].hex()}
            resp = self.transceive(bytes([0xFF, 0xCA, 0x00, 0x00, 0x00]))
            sw = resp[-2:]
            if sw != b"\x90\x00":
                raise RuntimeError(f"UID read failed (SW {sw.hex()})")
            return {"uid": resp[:-2].hex()}

    def sim_reset(self, uid=None, keys=None):
        if self.mode != "sim":
            raise RuntimeError("sim_reset is only available in simulator mode")
        self._init_sim(uid=uid, keys=keys)
        return {"ok": True}

    def sim_state(self):
        if self.mode != "sim":
            raise RuntimeError("sim_state is only available in simulator mode")
        assert self.sim is not None
        return self.sim.state()

    def status(self):
        return {
            "ok": True,
            "bridge": VERSION,
            "mode": self.mode,
            "sim": self.mode == "sim",
            "reader": self.reader_name,
            "readers": self._reader_names,
            "note": self.note,
        }


# ── command dispatch (shared by both channels) ─────────────────────────────

ALLOWED_API_HOSTS = {"openln.com", "www.openln.com", "dev.openln.com"}


def _openln_api(msg):
    """Forward an authenticated request to the openLN API.

    The page (any origin) asks the local bridge, so no CORS or credential
    complications ever reach the browser. Hard allowlist: https, openln.com
    hosts only, /api/ paths only, one-shot request, nothing stored.
    """
    import urllib.error
    import urllib.request
    from urllib.parse import urlparse

    url = str(msg.get("url") or "")
    method = str(msg.get("method") or "GET").upper()
    token = msg.get("token")
    payload = msg.get("body")
    u = urlparse(url)
    if u.scheme != "https" or u.hostname not in ALLOWED_API_HOSTS:
        raise ValueError("openln_api: only https openln.com hosts are allowed")
    if not u.path.startswith("/api/"):
        raise ValueError("openln_api: only /api/ paths are allowed")
    headers = {"accept": "application/json"}
    if token:
        headers["authorization"] = "Bearer " + str(token)
    data = None
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["content-type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    status = None
    raw = b""
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            status = resp.status
            raw = resp.read()
    except urllib.error.HTTPError as e:
        status = e.code
        raw = e.read()
    text = raw.decode("utf-8", "replace")
    try:
        parsed = json.loads(text) if text else None
    except Exception:
        parsed = None
    out = {"ok": True, "status": status}
    if parsed is not None:
        out["json"] = parsed
    else:
        out["text"] = text
    return out


def dispatch(hub: TransportHub, msg: dict) -> dict:
    cmd = msg.get("cmd")
    try:
        if cmd == "status":
            return hub.status()
        if cmd == "connect":
            return {"ok": True, **hub.connect(msg.get("reader"))}
        if cmd == "disconnect":
            hub.disconnect()
            return {"ok": True}
        if cmd == "transceive":
            apdu_hex = re.sub(r"\s+", "", str(msg.get("apdu", "")))
            if len(apdu_hex) % 2 or not re.fullmatch(r"[0-9a-fA-F]*", apdu_hex):
                raise ValueError("apdu must be an even-length hex string")
            resp = hub.transceive(bytes.fromhex(apdu_hex))
            return {"ok": True, "response": resp.hex()}
        if cmd == "uid":
            return {"ok": True, **hub.uid()}
        if cmd == "sim_reset":
            hub.sim_reset(uid=msg.get("uid"), keys=msg.get("keys"))
            return {"ok": True}
        if cmd == "sim_state":
            return {"ok": True, "state": hub.sim_state()}
        if cmd == "openln_api":
            return _openln_api(msg)
        raise ValueError(f"unknown cmd {cmd!r}")
    except Exception as e:
        return {"ok": False, "error": str(e)}


# ── Chrome native messaging (stdio, framed JSON) ───────────────────────────

def run_stdio(hub: TransportHub):
    log(f"openLN Card Bridge {VERSION} — native messaging mode (transport: {hub.mode})")
    inp, out = sys.stdin.buffer, sys.stdout.buffer
    while True:
        raw_len = inp.read(4)
        if len(raw_len) < 4:
            break
        (n,) = struct.unpack("<I", raw_len)
        payload = inp.read(n)
        if len(payload) < n:
            break
        try:
            msg = json.loads(payload.decode("utf-8"))
        except Exception as e:
            log("bad message:", e)
            continue
        resp = dispatch(hub, msg)
        resp["id"] = msg.get("id")
        data = json.dumps(resp).encode("utf-8")
        out.write(struct.pack("<I", len(data)))
        out.write(data)
        out.flush()


# ── HTTP channel ────────────────────────────────────────────────────────────

class BridgeHTTP(BaseHTTPRequestHandler):
    hub: TransportHub
    origin_patterns: list
    server_version = f"openln-cardbridge/{VERSION}"

    # silence the default request logging to stdout; log to stderr instead
    def log_message(self, format, *args):
        log("%s - %s" % (self.address_string(), format % args))

    def _origin_ok(self, origin):
        if origin is None:
            return None  # non-browser client; no CORS headers needed
        for pat in self.origin_patterns:
            if re.match(pat, origin):
                return origin
        return False

    def _cors(self):
        origin = self.headers.get("Origin")
        allowed = self._origin_ok(origin)
        if allowed:
            self.send_header("Access-Control-Allow-Origin", allowed)
            self.send_header("Vary", "Origin")
        return allowed

    def _json(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n == 0:
            return {}
        try:
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return {}

    # -- routes ---------------------------------------------------------------

    def do_OPTIONS(self):
        origin = self.headers.get("Origin")
        if self._origin_ok(origin) is False:
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.send_header("Access-Control-Max-Age", "600")
        self._cors()
        self.end_headers()

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if path == "/api/status":
            return self._json(200, self.hub.status())
        if path == "/api/sim/state":
            res = dispatch(self.hub, {"cmd": "sim_state"})
            return self._json(200 if res.get("ok") else 400, res)
        if path.startswith("/api/"):
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        return self._serve_static(path)

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        body = self._read_body()
        routes = {
            "/api/connect": "connect",
            "/api/disconnect": "disconnect",
            "/api/transceive": "transceive",
            "/api/uid": "uid",
            "/api/sim/reset": "sim_reset",
            "/api/openln": "openln_api",
        }
        cmd = routes.get(path)
        if cmd is None:
            return self._json(404, {"ok": False, "error": "unknown endpoint"})
        res = dispatch(self.hub, {**body, "cmd": cmd})
        return self._json(200 if res.get("ok") else 400, res)

    def _serve_static(self, path):
        if path == "/":
            path = "/index.html"
        if path.startswith("/engine/"):
            base, rel = ENGINE_DIR, path[len("/engine/"):]
        else:
            base, rel = WEB_DIR, path.lstrip("/")
        full = os.path.realpath(os.path.join(base, rel))
        if not full.startswith(os.path.realpath(base)) or not os.path.isfile(full):
            return self._json(404, {"ok": False, "error": f"not found: {path}"})
        import mimetypes
        ctype = {
            ".html": "text/html; charset=utf-8",
            ".js": "text/javascript; charset=utf-8",
            ".mjs": "text/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg": "image/svg+xml",
        }.get(os.path.splitext(full)[1].lower()) or mimetypes.guess_type(full)[0] or "application/octet-stream"
        with open(full, "rb") as fh:
            body = fh.read()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)


def run_http(hub: TransportHub, port, extra_origins):
    pats = list(DEFAULT_ORIGINS) + [re.escape(o).replace("\\*", ".*") for o in (extra_origins or [])]
    BridgeHTTP.hub = hub
    BridgeHTTP.origin_patterns = pats
    srv = ThreadingHTTPServer(("127.0.0.1", port), BridgeHTTP)
    srv.daemon_threads = True
    log(f"openLN Card Bridge {VERSION} — http://127.0.0.1:{port} (transport: {hub.mode})")
    if hub.note:
        log(f"note: {hub.note}")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()


# ── entry point ─────────────────────────────────────────────────────────────

def main(argv=None):
    ap = argparse.ArgumentParser(description="openLN Card Bridge — NTAG424 APDU transport for browsers")
    ap.add_argument("--http", action="store_true", help="run the local HTTP API + webapp instead of native messaging")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"HTTP port (default {DEFAULT_PORT})")
    ap.add_argument("--sim", action="store_true", help="force the built-in card simulator (no hardware)")
    ap.add_argument("--stdio", action="store_true", help="force native-messaging stdio mode (default when --http is absent)")
    ap.add_argument("--reader", default=None, help="PC/SC reader name substring or index (default: first)")
    ap.add_argument("--allow-origin", action="append", default=[], help="extra CORS origin pattern (repeatable)")
    # Chrome launches native messaging hosts with the calling extension's
    # origin as the first positional argument (e.g. chrome-extension://<id>/).
    # Native messaging already enforces the manifest's allowed_origins, but
    # accept the argument so argparse does not reject the launch.
    ap.add_argument("origin", nargs="?", default=None, help=argparse.SUPPRESS)
    args = ap.parse_args(argv)

    hub = TransportHub(args)
    if args.http:
        run_http(hub, args.port, args.allow_origin)
    else:
        run_stdio(hub)
    return 0


if __name__ == "__main__":
    sys.exit(main())
