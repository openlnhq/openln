#!/usr/bin/env bash
# openLN Card Bridge installer (Linux + macOS).
# Registers the Chrome native messaging host and checks prerequisites.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
BRIDGE="$HERE/bridge/openln-cardbridge.py"
EXT_ID="$(cat "$HERE/tools/extension-id.txt" 2>/dev/null || echo iikjoajfihdnhkeaglmidonioplochdg)"

chmod +x "$BRIDGE"

echo "openLN card bridge"
echo "  bridge:       $BRIDGE"
echo "  extension id: $EXT_ID"
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3 first." >&2
  exit 1
fi

if ! python3 -c "import smartcard" >/dev/null 2>&1; then
  echo "note: pyscard not found (needed for USB readers). install it with:"
  echo "  python3 -m pip install pyscard"
  echo "      linux also needs pcscd:  sudo apt install pcscd  (or your package manager)"
  echo "simulation mode works without it."
  echo ""
fi

TMP="$(mktemp)"
sed "s|__BRIDGE_PATH__|$BRIDGE|" "$HERE/extension/com.openln.cardbridge.json.template" > "$TMP"
trap 'rm -f "$TMP"' EXIT

installed=0
for dir in \
  "$HOME/.config/google-chrome/NativeMessagingHosts" \
  "$HOME/.config/chromium/NativeMessagingHosts" \
  "$HOME/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/.config/microsoft-edge/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Chromium/NativeMessagingHosts" \
  "$HOME/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts" \
  "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts"
do
  base="$(dirname "$dir")"
  if [ -d "$base" ]; then
    mkdir -p "$dir"
    cp "$TMP" "$dir/com.openln.cardbridge.json"
    echo "installed host manifest: $dir/com.openln.cardbridge.json"
    installed=$((installed + 1))
  fi
done

if [ "$installed" -eq 0 ]; then
  echo "no Chrome/Chromium profile directories found; nothing to register."
  echo "the local HTTP mode (python3 bridge/openln-cardbridge.py --http) works without any of this."
else
  echo ""
  echo "done. next steps:"
  echo "  1. load the extension:  chrome://extensions  ->  Developer mode  ->  Load unpacked  ->  $HERE/extension"
  echo "     (extension id: $EXT_ID)"
  echo "  2. plug in the NFC reader (or run with --sim to play without hardware)"
fi

echo ""
echo "run the tool:"
echo "  python3 \"$BRIDGE\" --http        # then open  http://127.0.0.1:17777"
echo "or open your openLN webapp with the extension installed."
