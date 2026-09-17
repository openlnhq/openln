#!/usr/bin/env python3
"""Compile actual RIC main.cpp on host. All dependencies are explicit test doubles.

No firmware/payment transport is linked. No credentials or live network calls.
The selected main.cpp is copied byte-for-byte, never rewritten/extracted.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
SHIM = ROOT / "tests/ric-main-shim"
FIRMWARE = Path("firmware/esp32-pos/src")
SCENARIOS = [
    "frozen-tls", "frozen-nfc", "callback-paid-only", "callback-timeout-once",
    "wifi-preserve-hash", "boot-receive-unsent", "boot-receive-dispatched",
    "boot-withdraw-unsent", "boot-withdraw-dispatched", "receive-window-600",
    "receive-expiry-qr", "receive-expiry-card", "typed-pin-retry", "send-shared-k1",
    "journal-before-expose", "maintenance-gate", "pin-timeout-not-rejection", "cancel-while-detecting",
    "boot-corrupt-journal", "boot-unavailable-journal", "invoice-journal-save-failure",
    "worker-network-unavailable", "worker-nfc-unavailable", "cancel-retry-after-pending", "send-timeout-once",
    "insufficient-balance", "insufficient-balance-pending", "insufficient-balance-paid-wins",
    "insufficient-balance-lost-reply",
    "cancel-receive-pending-cadence", "cancel-send-pending-cadence",
    "insufficient-balance-repeated-proof",
    "boot-receive-unsent-expiry", "boot-receive-dispatched-expiry",
    "safe-stage-trace", "closed-direct-checkout", "failed-status-reconnect",
]


def run(command, **kwargs):
    return subprocess.run(command, cwd=ROOT, text=True, capture_output=True,
                          timeout=180, **kwargs)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--revision", help="Read source from git without checkout (e.g. 159cf93)")
    parser.add_argument("--scenario", action="append", choices=SCENARIOS)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    build_root = SHIM / ".build"
    build_root.mkdir(exist_ok=True)
    build = Path(tempfile.mkdtemp(prefix="host-", dir=build_root))
    snapshot = build / "source"
    if args.revision:
        files = run(["git", "ls-tree", "-r", "--name-only", args.revision, "--", str(FIRMWARE)])
        files.check_returncode()
        for filename in files.stdout.splitlines():
            source = subprocess.run(["git", "show", f"{args.revision}:{filename}"], cwd=ROOT,
                                    capture_output=True, check=True, timeout=30).stdout
            target = snapshot / Path(filename).relative_to(FIRMWARE)
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source)
    else:
        shutil.copytree(ROOT / FIRMWARE, snapshot)
    original = (snapshot / "main.cpp").read_bytes()
    include_dir = build / "include-site"
    include_dir.mkdir()
    actual_main = include_dir / "main.cpp"
    actual_main.write_bytes(original)
    assert actual_main.read_bytes() == original
    binary = build / "ric-main-host"
    command = [os.environ.get("CXX", "g++"), "-std=c++17", "-O0", "-g", "-Wall", "-Wextra",
               "-Wno-unused-function", "-Wno-unused-variable", "-Werror=return-type",
               "-I", str(SHIM), "-I", str(snapshot),
               "-I", str(ROOT / FIRMWARE),
               "-I", str(ROOT / "tests/ric-checkout-journal-shim"),
               f'-DRIC_MAIN_SOURCE="{actual_main}"',
               f'-DRIC_API_HEADER="{snapshot / "api/BitposClient.h"}"',
               str(ROOT / "tests/ric-main.cpp"), "-o", str(binary),
               "-Wl,--wrap=socket,--wrap=connect,--wrap=sendto,--wrap=getaddrinfo"]
    api_text = (snapshot / "api/BitposClient.h").read_text()
    if "submitLnurlCallback(" in api_text:
        command.insert(1, "-DRIC_MAIN_TYPED_API=1")
    if "const String& requestId" in api_text:
        command.insert(1, "-DRIC_MAIN_WITHDRAW_REQUEST_ID=1")
    compiled = run(command)
    (build / "compile.log").write_text(compiled.stdout + compiled.stderr)
    if compiled.returncode:
        print(compiled.stdout + compiled.stderr, file=sys.stderr)
        print(json.dumps({"compileFailed": True, "build": str(build), "command": command}))
        return 2
    canary_run = run([str(binary), "transport-deny-canary"])
    canary = json.loads(canary_run.stdout)
    if canary_run.returncode or not canary["passed"] or canary["socketAttempts"] != 4:
        print("Transport deny canary failed: " + canary_run.stdout + canary_run.stderr, file=sys.stderr)
        return 2
    results = []
    for scenario in args.scenario or SCENARIOS:
        executed = run([str(binary), scenario])
        (build / (scenario + ".log")).write_text(executed.stdout + executed.stderr)
        try:
            result = json.loads(executed.stdout)
        except json.JSONDecodeError:
            result = {"scenario": scenario, "passed": False, "error": executed.stdout + executed.stderr}
        result["returnCode"] = executed.returncode
        results.append(result)
    output = {
        "provenance": {
            "revision": args.revision or "working-tree",
            "source": str(ROOT / FIRMWARE / "main.cpp"),
            "compiledSource": str(actual_main),
            "sourceSha256": hashlib.sha256(original).hexdigest(),
            "sourceBytes": len(original), "byteIdentical": actual_main.read_bytes() == original,
            "apiHeader": str(snapshot / "api/BitposClient.h"),
            "actualJournal": str(snapshot / "core/CheckoutJournal.h") if (snapshot / "core/CheckoutJournal.h").exists() else str(ROOT / FIRMWARE / "core/CheckoutJournal.h"),
            "compiler": run([os.environ.get("CXX", "g++"), "--version"]).stdout.splitlines()[0],
            "shims": ["Arduino/TFT/touch/WiFi", "UI screens (observers only)", "deterministic RicIoWorker scheduler", "explicit BitposClient fixture definitions", "existing journal NVS model"],
            "network": "No BitposClient.cpp, TLS, HTTP, or wallet transport linked; socket/connect/sendto/getaddrinfo denied",
            "transportCanary": {"passed": canary["passed"], "deniedCalls": canary["socketAttempts"]},
            "build": str(build), "compileLog": str(build / "compile.log"),
        },
        "passed": sum(bool(item["passed"]) for item in results),
        "failed": sum(not item["passed"] for item in results),
        "scenarios": results,
    }
    destination = args.out or build / "report.json"
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(output, indent=2) + "\n")
    print(json.dumps({"report": str(destination), "passed": output["passed"], "failed": output["failed"],
                      "failures": [{"scenario": item["scenario"], "error": item["error"]}
                                   for item in results if not item["passed"]]}))
    # Scenario reds are real test failures, not compile failures. Node consumes
    # their structured evidence then gives each scenario its own failed test.
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
