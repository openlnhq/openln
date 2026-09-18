#!/usr/bin/env bash
# Read-only diagnostic: RIC invoice + payment_events state on an openLN target.
# Usage: prod-invoice-diag.sh <payment_hash> [<payment_hash>...]
set -euo pipefail
cd /opt/openln
set -a; . artifacts/api-server/.env; set +a
echo "--- env keys ---"
grep -o -E '^[A-Z_0-9]+=' artifacts/api-server/.env | tr -d = | tr '\n' ' '; echo
IN=$(printf "'%s'," "$@"); IN=${IN%,}
echo "--- pending_invoices ---"
psql "$DATABASE_URL" -X -P pager=off -c "select left(payment_hash,12) ph, wrap_status, amount_sats, fee_sats, merchant_payment_hash is not null as has_merchant, nwc_url_encrypted is not null as has_nwc, created_at, wrap_updated_at, paid_at, expires_at from pending_invoices where payment_hash in ($IN);"
echo "--- tables ---"
psql "$DATABASE_URL" -X -P pager=off -At -c "select table_name from information_schema.tables where table_schema='public' order by 1;" | tr '\n' ' '; echo
echo "--- payment_events columns ---"
psql "$DATABASE_URL" -X -P pager=off -At -c "select column_name from information_schema.columns where table_name='payment_events' order by ordinal_position;" | tr '\n' ' '; echo
echo "--- payment_events rows ---"
psql "$DATABASE_URL" -X -P pager=off -c "select * from payment_events where payment_hash in ($IN) order by 1;" | cut -c1-400 | head -60
echo "--- transactions ---"
psql "$DATABASE_URL" -X -P pager=off -c "select left(payment_hash,12) ph, direction, type, status, amount_sats, fee_sats, failure_reason, created_at, updated_at from transactions where payment_hash in ($IN) order by created_at;" 2>&1 | head
