#!/usr/bin/env bash
# E2E on dev: create a wrapped invoice with a device token, cancel it, read
# back DB + hold state. Amount 100 sats so the 2% fee (2 sats) makes it a wrap.
# Nothing is paid. Usage: bash cancel_e2e.sh <accountId>
set -euo pipefail
cd ~/openln
set -a; . artifacts/api-server/.env; set +a
ACCT="$1"
TOK=$(psql "$DATABASE_URL" -X -q -At -c "SELECT token FROM device_tokens WHERE account_id='$ACCT' AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 1")
[ -n "$TOK" ] || { echo "no device token"; exit 1; }
API=http://127.0.0.1:3147/api
echo "--- create"
CREATE=$(curl -s -H "Authorization: Bearer $TOK" -H 'content-type: application/json' -d '{"amountSats":100,"memo":"cancel e2e"}' "$API/pos/invoice")
echo "$CREATE" | cut -c1-200
HASH=$(echo "$CREATE" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("paymentHash",""))')
[ ${#HASH} -eq 64 ] || { echo "no hash"; exit 1; }
echo "--- db after create"
psql "$DATABASE_URL" -X -q -c "SELECT wrap_status, amount_sats, fee_sats FROM pending_invoices WHERE payment_hash='$HASH'"
echo "--- status (should be pending, answered from DB)"
curl -s -w ' t=%{time_total}\n' -H "Authorization: Bearer $TOK" "$API/pos/invoice/$HASH/status"
echo "--- cancel"
T0=$(date +%s%N)
curl -s -w ' t=%{time_total}\n' -X POST -H "Authorization: Bearer $TOK" "$API/pos/invoice/$HASH/cancel"
echo "--- db after cancel"
psql "$DATABASE_URL" -X -q -c "SELECT wrap_status, wrap_updated_at FROM pending_invoices WHERE payment_hash='$HASH'"
psql "$DATABASE_URL" -X -q -c "SELECT event, status, left(message,90) FROM payment_events WHERE payment_hash='$HASH' ORDER BY created_at"
echo "--- status after cancel (device view)"
curl -s -H "Authorization: Bearer $TOK" "$API/pos/invoice/$HASH/status"; echo
echo "--- cancel again (idempotent)"
curl -s -X POST -H "Authorization: Bearer $TOK" "$API/pos/invoice/$HASH/cancel"; echo
echo "HASH=$HASH"
