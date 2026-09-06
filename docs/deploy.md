# Deploying openLN

One repo, two environments, one command per hop. Nothing else touches the servers.

```
 gateway ~/openln (work here)
      │  git commit on main
      ▼
 scripts/ship.sh dev  ──►  Gitea main  ──►  dev box ~/openln   ──►  https://dev.openln.com
      │                                       (deploy.sh dev, :3147)
      │  test it
      ▼
 scripts/ship.sh promote ─►  Gitea production (ff from main) ──► VPS /opt/openln ─► https://openln.com
                                                                 (deploy.sh prod, :3160)
```

| | dev | production |
|---|---|---|
| host | `dev` (10.10.10.11) | `prod` (159.198.77.66) |
| dir | `~/openln` | `/opt/openln` |
| branch | `main` | `production` |
| port | 3147 | 3160 |
| env file | `artifacts/api-server/.env` (gitignored, never deployed) | same |
| DB | `openln_dev` | `openln` |

## Rules

1. **Work on the gateway checkout (`~/openln`) or any clone — never on the servers.** `deploy.sh` refuses to run if the server tree has uncommitted edits, so hot-fixing on the VPS is impossible by construction. If you must edit on a server for diagnosis, `git stash` before shipping and port the change back to a real commit.
2. **`production` is only moved by `ship promote`** and only fast-forward. It never gets its own commits.
3. **`promote` requires dev to be on the exact commit being promoted.** Untested code can't reach prod.
4. **Migrations are files in `migrations/`**, idempotent (`IF NOT EXISTS`), run on every deploy as the app's DB role. Never `CREATE TABLE` by hand on a server.
5. **Every deploy ends with a real register+login probe**, not just `/health`. Empty DB or missing `SESSION_SECRET` fails the deploy loudly.
6. **Credentials:** all git access is SSH-key based (`ssh://git@10.10.10.1:2222/kongzi/openln.git`; the VPS uses the Tailscale address `100.92.64.48:2222`). No passwords, no tokens in remote URLs. Gitea admin API token (for the API only): `~/.gitea-panel-token` on the gateway.

## Commands

```bash
scripts/ship.sh status    # where everything is; flags drift
scripts/ship.sh dev       # push + deploy dev.openln.com
scripts/ship.sh promote   # production ← main, deploy openln.com, mirror to GitHub
```

Rollback = `git revert` on main, `ship dev`, `ship promote`. No special path.
