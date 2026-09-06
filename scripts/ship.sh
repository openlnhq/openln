#!/usr/bin/env bash
# openLN ship — the ONLY way code moves between environments. Run from the gateway.
#
#   scripts/ship.sh dev        push local `main` → Gitea, deploy to dev.openln.com (dev box :3147)
#   scripts/ship.sh promote    fast-forward `production` to `main`, deploy to openln.com (VPS :3160)
#   scripts/ship.sh status     where is each environment vs. git
#
# Model:  edit → commit on `main` → ship dev → test on dev.openln.com → ship promote.
#         `production` is only ever moved by `promote` (fast-forward only, never rewritten).
#         Deploy targets (dev box ~/openln, VPS /opt/openln) are read-only clones —
#         deploy.sh refuses to run if someone edited them by hand.
set -euo pipefail

GITEA_SSH="ssh://git@10.10.10.1:2222/kongzi/openln.git"
DEV_HOST="dev"                 # ~/.ssh/config alias → kongzi@dev (10.10.10.11)
PROD_HOST="prod"               # ~/.ssh/config alias → root@159.198.77.66
GITHUB_REMOTE="github"         # public mirror (openlnhq/openln), pushed on promote

cd "$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
log(){ printf '\033[1;32m[ship]\033[0m %s\n' "$*"; }
die(){ printf '\033[1;31m[ship] %s\033[0m\n' "$*" >&2; exit 1; }

need_clean(){
  [ -z "$(git status --porcelain --untracked-files=no)" ] || die "uncommitted changes — commit first:
$(git status --short --untracked-files=no)"
}

case "${1:-}" in
  dev)
    need_clean
    [ "$(git branch --show-current)" = "main" ] || die "ship dev runs from branch main (you are on $(git branch --show-current))"
    git fetch -q origin
    if [ -n "$(git log --oneline HEAD..origin/main)" ]; then
      die "origin/main has commits you don't have — git pull --rebase first"
    fi
    log "push main → Gitea"
    git push -q origin main
    log "deploy dev.openln.com"
    ssh "$DEV_HOST" 'bash -lc "~/openln/scripts/deploy.sh dev"'
    log "dev.openln.com is on $(git rev-parse --short HEAD)"
    ;;

  promote)
    need_clean
    git fetch -q origin
    MAIN=$(git rev-parse origin/main)
    PROD=$(git rev-parse origin/production 2>/dev/null || echo "")
    [ "$(git rev-parse HEAD)" = "$MAIN" ] || die "local HEAD ≠ origin/main — run 'ship dev' first so production gets exactly what dev has"
    if [ -n "$PROD" ]; then
      git merge-base --is-ancestor "$PROD" "$MAIN" || die "production is not an ancestor of main — someone committed directly to production. Refusing."
      [ "$PROD" = "$MAIN" ] && { log "production already at $(git rev-parse --short "$MAIN") — redeploying anyway"; }
      echo; log "commits going to production:"; git log --oneline "$PROD..$MAIN" | sed 's/^/    /'; echo
    else
      log "no production branch yet — creating from main"
    fi
    # dev must be on the same commit, otherwise this is untested code
    DEV_ON=$(ssh "$DEV_HOST" 'cut -d" " -f1 ~/openln/.deployed 2>/dev/null || git -C ~/openln rev-parse --short HEAD')
    [ "$(git rev-parse --short "$MAIN")" = "$DEV_ON" ] || die "dev.openln.com is on $DEV_ON, main is $(git rev-parse --short "$MAIN") — ship dev + test first"
    log "production ← main (fast-forward)"
    git push -q origin "$MAIN:refs/heads/production"
    log "deploy openln.com"
    ssh "$PROD_HOST" '/opt/openln/scripts/deploy.sh prod'
    if git remote get-url "$GITHUB_REMOTE" >/dev/null 2>&1; then
      log "mirror → GitHub (openlnhq/openln)"
      git push -q "$GITHUB_REMOTE" "$MAIN:refs/heads/main" || log "WARN: GitHub mirror push failed (non-fatal)"
    fi
    log "openln.com is on $(git rev-parse --short "$MAIN")"
    ;;

  status)
    git fetch -q origin
    printf '%-22s %s\n' "local main"       "$(git rev-parse --short HEAD) $(git log -1 --format=%s | cut -c1-60)"
    printf '%-22s %s\n' "gitea main"       "$(git rev-parse --short origin/main)"
    printf '%-22s %s\n' "gitea production" "$(git rev-parse --short origin/production 2>/dev/null || echo '(none)')"
    printf '%-22s %s\n' "dev.openln.com"   "$(ssh "$DEV_HOST"  'cat ~/openln/.deployed 2>/dev/null || git -C ~/openln rev-parse --short HEAD')"
    printf '%-22s %s\n' "openln.com"       "$(ssh "$PROD_HOST" 'cat /opt/openln/.deployed 2>/dev/null || git -C /opt/openln rev-parse --short HEAD')"
    for h in "$DEV_HOST:~/openln" "$PROD_HOST:/opt/openln"; do
      host=${h%%:*}; dir=${h#*:}
      dirty=$(ssh "$host" "git -C $dir status --porcelain --untracked-files=no | wc -l")
      [ "$dirty" = "0" ] || printf '\033[1;31m%-22s %s uncommitted files in %s — DRIFT\033[0m\n' "$host" "$dirty" "$dir"
    done
    ahead=$(git log --oneline origin/production..origin/main 2>/dev/null | wc -l)
    [ "$ahead" = "0" ] || echo "→ $ahead commit(s) on main not yet in production (ship promote)"
    ;;
  *) sed -n '2,12p' "$0"; exit 2 ;;
esac
