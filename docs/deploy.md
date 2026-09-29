# Deploying openLN

One repo, two environments, one command per hop. Nothing else touches the servers.

```
 a checkout (work here)
      │  git commit on main
      ▼
 scripts/ship.sh dev  ──►  forge main  ──►  dev box  ──►  https://dev.openln.com
      │                                     (deploy.sh dev)
      │  test it
      ▼
 scripts/ship.sh promote ─►  forge production (ff from main) ──►  production host ──►  https://openln.com
                                                                  (deploy.sh prod)
```

| | dev | production |
|---|---|---|
| checkout | `~/openln` | `/opt/openln` |
| branch | `main` | `production` |
| env file | `artifacts/api-server/.env` (gitignored, never deployed) | same |
| DB | `openln_dev` | `openln` |

## Rules

1. **Work on a checkout, never on the servers.** `deploy.sh` refuses to run if the target tree has uncommitted edits, so hot-fixing there is impossible by construction. If you must edit on a server for diagnosis, `git stash` before shipping and port the change back to a real commit.
2. **`production` is only moved by `ship promote`** and only fast-forward. It never gets its own commits.
3. **`promote` requires dev to be on the exact commit being promoted.** Untested code can't reach prod.
4. **Migrations are files in `migrations/`**, idempotent (`IF NOT EXISTS`), run on every deploy as the app's DB role. Never `CREATE TABLE` by hand on a server.
5. **Every deploy ends with a real register+login probe**, not just `/health`. Empty DB or missing `SESSION_SECRET` fails the deploy loudly.
6. **Credentials:** Git access is SSH-key based; no passwords and no tokens in remote URLs. Operational credentials (forge API tokens, host keys) live on the operator machine and in private SSH config, never in the repo.

## Commands

```bash
scripts/ship.sh status    # where everything is; flags drift
scripts/ship.sh dev       # push + deploy dev.openln.com
scripts/ship.sh promote   # production ← main, deploy openln.com, mirror to GitHub
```

Rollback = `git revert` on main, `ship dev`, `ship promote`. No special path.
