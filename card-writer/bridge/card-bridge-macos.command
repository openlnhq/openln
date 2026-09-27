#!/bin/bash
# openLN card bridge: one-step setup for macOS.
# Downloads the bridge, creates a private Python environment, and starts it.
set -u
DIR="$HOME/.openln-card-bridge"
mkdir -p "$DIR"
cd "$DIR" || exit 1

BASE=""
for H in "https://openln.com" "https://dev.openln.com"; do
  if curl -fsS --max-time 60 "$H/card-writer/bridge/openln-cardbridge.py" -o "$DIR/openln-cardbridge.py"; then BASE="$H"; break; fi
done
if [ -z "$BASE" ]; then
  echo "Could not download the card bridge. Check your connection and run this again."
  read -r -p "Press Enter to close..." _ < /dev/tty || true
  exit 1
fi
curl -fsS --max-time 60 "$BASE/card-writer/bridge/cardsim.py" -o "$DIR/cardsim.py" || true

if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 is required once. A macOS installer dialog will open now."
  echo "After it finishes, run this file again."
  xcode-select --install >/dev/null 2>&1 || true
  read -r -p "Press Enter to close..." _ < /dev/tty || true
  exit 1
fi

if [ ! -x "$DIR/venv/bin/python" ]; then
  echo "First run: creating a private Python environment (one time)..."
  python3 -m venv "$DIR/venv" || { echo "Could not create the Python environment."; read -r -p "Press Enter to close..." _ < /dev/tty || true; exit 1; }
fi
echo "Installing the card reader library (one time)..."
"$DIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check cryptography >/dev/null 2>&1 || true
"$DIR/venv/bin/python" -m pip install --quiet --disable-pip-version-check pyscard >/dev/null 2>&1 || true

echo ""
echo "=============================================="
echo " openLN card bridge is running."
echo " Keep this window open while you write cards."
echo " Go back to the openLN app and press Check again."
echo " Close this window to stop the bridge."
echo "=============================================="
echo ""
"$DIR/venv/bin/python" "$DIR/openln-cardbridge.py" --http
echo "The card bridge stopped."
read -r -p "Press Enter to close..." _ < /dev/tty || true
