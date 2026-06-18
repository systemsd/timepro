# Incident Rebuild Runbook — compromised VPS → clean host

> **Context.** On 2026-06-17 the shared Hetzner VPS `ubuntu-4gb-nbg1-1`
> (`178.105.58.173`) running **OpsCore** (production), **TimePro**, and
> **landingpro** was confirmed compromised: backdoor sudoers (`svc298`,
> `svc568`, `99-pakchoi`), attacker user `pakchoi`, attacker keys in
> `/root/.ssh/authorized_keys`, an `amco_*` miner container revived by cron, a
> self-re-enabling `terminate.service`, and system binaries (`curl`, `ss`,
> `nft`, `iptables`, `chattr`, `lsattr`) zeroed to mode `000` and made
> immutable. The box **cannot be cleaned in place** — the tools needed to remove
> the implant's immutable flags were themselves disabled. This runbook rebuilds
> on a fresh host and rotates every secret.
>
> **Principles**
> - **Carry data, never executables.** Move database *dumps* and hand-reviewed
>   source from git. Never copy binaries, `node_modules`, cron, systemd units,
>   `/home/*`, `/etc/sudoers.d/*`, SSH keys, or `.env` files off the old box.
> - **Rotate everything.** Assume every secret that ever sat on the old host is
>   public. Generate new values from your laptop.
> - **Treat the dumps as untrusted data.** The attacker had write access to the
>   rows. Restore, then review for tampered/extra admin users before going live.

---

## Phase 0 — Preserve data (do this first, while Postgres still runs)

The old box's Postgres binaries are intact (OpsCore is using them). There are two
clusters (pg16 + pg17); find which holds what.

```bash
# ON THE OLD BOX
sudo -u postgres psql -p 5432 -l        # list DBs in the pg16/main cluster
sudo -u postgres psql -p 5433 -l        # ...and pg17/main (port may differ)

# dump each real DB (custom format; adjust -p/-d from the listing)
sudo -u postgres pg_dump -p 5432 -Fc -d opscore  > /var/tmp/opscore.dump
sudo -u postgres pg_dump -p 5432 -Fc -d timepro  > /var/tmp/timepro.dump
sha256sum /var/tmp/*.dump                # note hashes
```

Pull them **from your laptop** (don't trust the box's `scp`/`curl`; pull over the
intact `sshd`):

```bash
# ON YOUR LAPTOP
scp root@178.105.58.173:/var/tmp/opscore.dump .
scp root@178.105.58.173:/var/tmp/timepro.dump .
sha256sum opscore.dump timepro.dump     # verify against the box's hashes
```

---

## Phase 1 — Capture config to re-create (reference only, do not execute)

Read these off the old box and save the text — you'll re-author them clean, not
copy them.

```bash
# ON THE OLD BOX — capture as reference
nginx -T 2>/dev/null                     # all server blocks, domains, proxy_pass targets
pm2 jlist | python3 -m json.tool         # app names, cwd, scripts, ports
ls -la /etc/letsencrypt/live/            # which certs/domains exist
cat /etc/nginx/sites-enabled/*           # vhost detail
```

Record: domains (`opscore.systemsd.co`, `api.timepro.*`, `app.timepro.*`, …),
which app listens on which port, and current DNS A-records (check your DNS
provider, not the box).

---

## Phase 2 — Isolate / decommission the old box

Via the **Hetzner Cloud Console** (web UI — the host firewall is sabotaged):

1. **Snapshot** the volume if you want forensic evidence (optional).
2. Attach a **Cloud Firewall** that denies all inbound except SSH from your IP —
   or **Power Off** the server outright once Phase 0 + 1 are done.

Do not reboot into the old OS expecting it clean. It isn't.

---

## Phase 3 — Provision a fresh server

1. New Hetzner server, **Ubuntu 24.04 LTS**, sized like the old one (4 GB is
   tight for pg + 3 Node apps; consider 8 GB).
2. Add **only your own SSH key** at create time.
3. Give it a **new IP**; you'll repoint DNS in Phase 10.

```bash
# ON YOUR LAPTOP — confirm key-only access
ssh root@NEW_IP 'echo ok'
```

---

## Phase 4 — Base hardening (on the new box)

```bash
adduser --disabled-password --gecos "" deploy
usermod -aG sudo deploy
mkdir -p /home/deploy/.ssh && cp /root/.ssh/authorized_keys /home/deploy/.ssh/
chown -R deploy:deploy /home/deploy/.ssh && chmod 700 /home/deploy/.ssh

# SSH: key-only, no root password login
sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' /etc/ssh/sshd_config
sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' /etc/ssh/sshd_config
systemctl restart ssh

apt-get update && apt-get install -y ufw fail2ban unattended-upgrades
ufw default deny incoming && ufw default allow outgoing
ufw allow OpenSSH && ufw allow 80 && ufw allow 443
ufw enable
systemctl enable --now fail2ban
```

Also set a **Hetzner Cloud Firewall** (defense in depth): allow 22 (your IP), 80,
443; deny the rest. Never expose 4001 / 3005 / 3000 / 5432 publicly.

---

## Phase 5 — Install the runtime

```bash
# Node 20 + pnpm 9 + pm2
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs git nginx postgresql
corepack enable && corepack prepare pnpm@9 --activate
npm i -g pm2

# certbot for TLS
apt-get install -y certbot python3-certbot-nginx
```

Run the apps under the **`deploy`** user (not root — the old box ran pm2 as root,
which widened the blast radius). `su - deploy` for the app phases below.

---

## Phase 6 — Restore the databases with NEW credentials

Generate fresh passwords on your laptop (`openssl rand -base64 24`), then:

```bash
# create roles + DBs (run as postgres superuser)
sudo -u postgres psql <<'SQL'
CREATE ROLE opscore_user      WITH LOGIN PASSWORD 'NEW_OPSCORE_DB_PW';
CREATE ROLE timepro_user      WITH LOGIN PASSWORD 'NEW_TIMEPRO_APP_PW';
CREATE ROLE timepro_admin     WITH LOGIN SUPERUSER PASSWORD 'NEW_TIMEPRO_ADMIN_PW';
CREATE DATABASE opscore OWNER opscore_user;
CREATE DATABASE timepro OWNER timepro_user;
GRANT ALL ON SCHEMA public TO timepro_user;
SQL

# restore data (the dumps carry table data; roles are created above)
sudo -u postgres pg_restore --no-owner --role=opscore_user -d opscore /path/opscore.dump
sudo -u postgres pg_restore --no-owner --role=timepro_user -d timepro /path/timepro.dump
```

> **Review the restored data** before going live:
> ```sql
> -- OpsCore: look for rogue admins / unexpected accounts the attacker may have added
> SELECT id, email, role, created_at FROM users ORDER BY created_at DESC LIMIT 50;
> ```
> Delete anything you don't recognize. Force-reset all OpsCore user passwords if
> the auth store could have been read.

TimePro extensions: `timepro_admin` is SUPERUSER, so the migrate step
(`CREATE EXTENSION citext/pgcrypto`) will succeed on its own.

---

## Phase 7 — Rotate secrets (generate fresh, set on BOTH sides where shared)

| Secret | Used by | Generate |
| --- | --- | --- |
| OpsCore DB password | OpsCore `.env` | `openssl rand -base64 24` |
| TimePro app DB password (`timepro_user`) | TimePro `DATABASE_URL` | `openssl rand -base64 24` |
| TimePro admin DB password (`timepro_admin`) | TimePro `DATABASE_ADMIN_URL` | `openssl rand -base64 24` |
| `OPSCORE_API_KEY` | **both** OpsCore (issues) + TimePro (`.env`) | `openssl rand -hex 32` |
| `OPSCORE_HANDOFF_SECRET` | **both** OpsCore + TimePro (`.env`) | `openssl rand -hex 32` |
| `JWT_SIGNING_KEY_PRIMARY` / `_NEXT` | TimePro `.env` | `openssl rand -hex 32` |
| SMTP / `SMTP_PASS` | OpsCore + TimePro | reset at provider |
| GitHub Actions `VPS_SSH_KEY` | deploy workflow | new keypair (Phase 11) |
| Your personal SSH key | you | new keypair |
| Any OpsCore session/JWT signing keys | OpsCore | per OpsCore docs |

The two **shared** secrets (`OPSCORE_API_KEY`, `OPSCORE_HANDOFF_SECRET`) must be
identical in OpsCore's env and TimePro's `.env` or the handoff login + directory
sync break.

---

## Phase 8 — Deploy OpsCore

OpsCore has its own pm2-based deploy (process name `opscore`); follow its repo
docs. Essentials on the clean box:

```bash
su - deploy
git clone <opscore-repo> /var/www/opscore && cd /var/www/opscore
# write .env with: rotated DB url (opscore_user), rotated OPSCORE_API_KEY +
#   OPSCORE_HANDOFF_SECRET, TIMEPRO_URL=https://app.timepro.systemsd.co, SMTP, etc.
pnpm install --frozen-lockfile
pnpm build            # if Prisma: pnpm prisma migrate deploy
pm2 start "pnpm start" --name opscore
pm2 save
```

nginx vhost for `opscore.systemsd.co` → `127.0.0.1:<opscore_port>`, then
`certbot --nginx -d opscore.systemsd.co`.

---

## Phase 9 — Deploy TimePro

**Merge `fix/loadenv-and-web-standalone` to `main` first** — it makes the bundled
API resolve `.env` on its own and drops the web `output: standalone` that breaks
`next start`.

```bash
su - deploy
git clone <timepro-repo> /var/www/timepro && cd /var/www/timepro

# root .env  — API + DB + OpsCore secrets (all rotated)
cat > .env <<'ENV'
NODE_ENV=production
API_HOST=127.0.0.1
API_PORT=4001
API_CORS_ORIGINS=https://app.timepro.systemsd.co
DATABASE_URL=postgres://timepro_user:NEW_TIMEPRO_APP_PW@localhost:5432/timepro
DATABASE_ADMIN_URL=postgres://timepro_admin:NEW_TIMEPRO_ADMIN_PW@localhost:5432/timepro
OPSCORE_API_URL=https://opscore.systemsd.co
OPSCORE_API_KEY=<rotated, matches OpsCore>
OPSCORE_HANDOFF_SECRET=<rotated, matches OpsCore>
OPSCORE_ORG_SLUG=systemsd
OPSCORE_ORG_NAME=Systemsd
JWT_SIGNING_KEY_PRIMARY=<rotated>
JWT_SIGNING_KEY_NEXT=<rotated>
ENV

# web build-time env (NEXT_PUBLIC_* are inlined at build)
cat > apps/web/.env.production <<'ENV'
NEXT_PUBLIC_API_URL=https://api.timepro.systemsd.co
NEXT_PUBLIC_OPSCORE_URL=https://opscore.systemsd.co
ENV

pnpm install --frozen-lockfile
pnpm build
pnpm db:migrate                 # extensions + schema (admin role)

pm2 start "pnpm --filter @timepro/api start" --name timepro-api
pm2 start "pnpm --filter @timepro/web start" --name timepro-web
pm2 save
pm2 startup systemd             # run the printed command, then `pm2 save` again

# verify (no public bind, production mode)
pm2 logs timepro-api --lines 5  # expect: http://127.0.0.1:4001 (production)
curl -fsS http://127.0.0.1:4001/readyz   # expect 200, checks.db ok
```

nginx vhosts:
- `api.timepro.systemsd.co` → `127.0.0.1:4001`
- `app.timepro.systemsd.co` → `127.0.0.1:3005`

Then `certbot --nginx -d api.timepro.systemsd.co -d app.timepro.systemsd.co`.

---

## Phase 10 — DNS cutover + verify

1. Point the A-records (`opscore.*`, `api.timepro.*`, `app.timepro.*`) at the
   **new IP**. Lower TTL beforehand if you can.
2. After propagation:
   - `https://opscore.systemsd.co` loads.
   - "Sign in with OpsCore" on TimePro web completes the handoff.
   - Desktop agent loopback login works against the new API.
   - `https://api.timepro.systemsd.co/readyz` returns ok via nginx/TLS.

---

## Phase 11 — Post-cutover

1. **GitHub:** generate a new deploy keypair, put the **public** key in
   `/home/deploy/.ssh/authorized_keys` on the new box, update the repo's
   `VPS_SSH_KEY` / `VPS_HOST` / `VPS_USER` secrets. Rotate any GitHub PATs.
2. Review the deploy workflow runs on the old box for tampering.
3. Once the new host is verified healthy for a few days, **delete the old
   server** (after keeping any forensic snapshot you want).
4. Update `docs/HANDOFF.md` with the new IP/host and the rotation date.
5. Tell affected users to re-authenticate; consider notifying anyone whose data
   was in the OpsCore directory if disclosure obligations apply.

---

## Verification checklist

- [ ] Both DB dumps pulled + hash-verified on laptop
- [ ] Restored data reviewed; no rogue admin accounts
- [ ] All secrets in the Phase 7 table rotated
- [ ] `OPSCORE_API_KEY` + `OPSCORE_HANDOFF_SECRET` match across OpsCore ↔ TimePro
- [ ] Apps run as `deploy`, not root
- [ ] `timepro-api` logs `127.0.0.1:4001 (production)` — not `0.0.0.0`, not `development`
- [ ] No app port (4001/3005/3000/5432) reachable from the public internet
- [ ] ufw + Hetzner Cloud Firewall both active; SSH key-only
- [ ] GitHub `VPS_SSH_KEY` rotated; old key removed
- [ ] Old box powered off / firewalled, then deleted
