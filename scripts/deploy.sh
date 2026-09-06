#!/usr/bin/env bash
# openLN deploy — runs ON the target host (dev box or VPS). Idempotent.
#
#   scripts/deploy.sh dev    # on dev:   ~/openln       tracks branch `main`,       port 3147
#   scripts/deploy.sh prod   # on VPS:   /opt/openln    tracks branch `production`, port 3160
#
# Steps: fetch → hard-reset to origin/<branch> → pnpm install (frozen) → typecheck
#        → build → migrations (idempotent, as the app DB role) → restart → health
#        → real auth probe (register + login + cleanup) so an empty DB / missing env
#        can never pass as "deployed".
# The only per-target differences are branch, dir, port. .env is never touched.
set -euo pipefail

TARGET="${1:-}"
case "$TARGET" in
  dev)  DIR="$HOME/openln"; BRANCH="main";       PORT=3147; RESTART="sudo systemctl restart openln" ;;
  prod) DIR="/opt/openln";  BRANCH="production"; PORT=3160; RESTART="systemctl restart openln" ;;
  *) echo "usage: $0 dev|prod" >&2; exit 2 ;;
esac

ENVF="$DIR/artifacts/api-server/.env"
log(){ printf '\033[1;36m[deploy:%s]\033[0m %s\n' "$TARGET" "$*"; }

cd "$DIR"
[ -f "$ENVF" ] || { echo "FATAL: $ENVF missing — refusing to deploy without env" >&2; exit 1; }
for k in DATABASE_URL SESSION_SECRET; do
  grep -qE "^$k=." "$ENVF" || { echo "FATAL: $k not set in $ENVF" >&2; exit 1; }
done

BEFORE=$(git rev-parse --short HEAD)
log "fetching origin/$BRANCH"
git fetch -q origin "$BRANCH"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "FATAL: working tree has uncommitted changes — someone edited $DIR directly." >&2
  git status --short --untracked-files=no >&2
  echo "Commit them from a dev checkout (or: git stash) before deploying. Deployment targets are read-only." >&2
  exit 1
fi
git checkout -q -B "$BRANCH" "origin/$BRANCH"
git reset -q --hard "origin/$BRANCH"
AFTER=$(git rev-parse --short HEAD)
log "$BEFORE → $AFTER ($(git log -1 --format='%s' | cut -c1-70))"

log "pnpm install"
pnpm install --frozen-lockfile --prefer-offline 2>&1 | tail -1
log "typecheck"
pnpm typecheck >/dev/null
log "build"
pnpm build >/dev/null

log "migrations"
DBURL=$(grep -oE '^DATABASE_URL=.+' "$ENVF" | cut -d= -f2-)
for f in migrations/*.sql; do
  psql "$DBURL" -q -v ON_ERROR_STOP=1 -f "$f" >/dev/null
done
TABLES=$(psql "$DBURL" -tAc "select count(*) from pg_tables where schemaname='public'")
log "schema ok ($TABLES tables)"

log "restart"
$RESTART
for i in $(seq 1 15); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
  [ "$i" = 15 ] && { echo "FATAL: /health not up after 15s" >&2; journalctl -u openln -n 30 --no-pager >&2; exit 1; }
done
log "health ok"

# Real auth probe: exercises schema + SESSION_SECRET + DB role in one shot.
PROBE="probe-$(date +%s)-$RANDOM"
PW="deploy-probe-$(openssl rand -hex 8)"
code=$(curl -s -o /tmp/probe-reg.json -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/register" \
  -H 'content-type: application/json' -d "{\"handle\":\"$PROBE\",\"password\":\"$PW\"}")
[ "$code" = "201" ] || { echo "FATAL: register probe → HTTP $code: $(cat /tmp/probe-reg.json)" >&2; exit 1; }
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/api/auth/login" \
  -H 'content-type: application/json' -d "{\"handle\":\"$PROBE\",\"password\":\"$PW\"}")
[ "$code" = "200" ] || { echo "FATAL: login probe → HTTP $code" >&2; exit 1; }
psql "$DBURL" -q -v ON_ERROR_STOP=1 -c "DELETE FROM accounts WHERE entity_id IN (SELECT id FROM entities WHERE handle='$PROBE'); DELETE FROM entities WHERE handle='$PROBE';"
log "auth probe ok (register+login, probe account removed)"

echo "$AFTER $(date -u +%FT%TZ)" > "$DIR/.deployed"
log "DONE — $TARGET is on $AFTER"
