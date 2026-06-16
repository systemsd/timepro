# TimePro nginx + TLS (A3)

Reverse-proxy config for the co-located host (`178.105.58.173`, runs OpsCore too).
Routes `timepro.systemsd.co` → web and `api.timepro.systemsd.co` → api, both
served by the compose stack on `127.0.0.1` (`infra/compose/docker-compose.prod.yml`).

> Prereqts: **A0 done** — `timepro.systemsd.co` and `api.timepro.systemsd.co` both
> resolve to this host, and the compose stack is up (`docker compose ... up -d`),
> so ports `127.0.0.1:3005` (web) and `127.0.0.1:4001` (api) are listening.

The host already runs OpsCore behind nginx with Let's Encrypt, so `nginx` and
`certbot` are already installed — we just add two vhosts and two certs.

## 1. Obtain the certificates FIRST

`timepro.systemsd.co.conf` references `ssl_certificate` paths that don't exist
yet — enabling it before the certs exist makes `nginx -t` fail. So get the certs
first, using certbot's nginx authenticator (no manual webroot needed):

```bash
sudo certbot certonly --nginx \
  -d timepro.systemsd.co \
  -d api.timepro.systemsd.co \
  --non-interactive --agree-tos -m ops@systemsd.co
```

This writes `/etc/letsencrypt/live/{timepro,api.timepro}.systemsd.co/`.
(One cert can cover both names; this config expects a separate live dir per
name, which `--nginx` produces when each `-d` is its own primary. If certbot
bundles both under one dir, point both `ssl_certificate` lines at that dir, or
run two separate `certonly` commands.)

## 2. Install the vhost

```bash
sudo cp infra/nginx/timepro.systemsd.co.conf /etc/nginx/sites-available/
sudo ln -sf /etc/nginx/sites-available/timepro.systemsd.co.conf \
            /etc/nginx/sites-enabled/timepro.systemsd.co.conf
# (If this host uses conf.d instead of sites-*, copy into /etc/nginx/conf.d/.)
```

## 3. Validate + reload (never restart — OpsCore shares this nginx)

```bash
sudo nginx -t && sudo systemctl reload nginx
```

## 4. Verify

```bash
curl -sI https://timepro.systemsd.co/         # 200/307 from the web app
curl -s  https://api.timepro.systemsd.co/healthz   # {"ok":true}
curl -s  https://api.timepro.systemsd.co/readyz    # {"checks":{"db":"ok"}}
```

## Notes

- **Don't `systemctl restart nginx`** — reload only, so OpsCore's vhosts aren't
  dropped. This host is shared (see CLAUDE.md / HANDOFF gotchas).
- `client_max_body_size 25m` covers screenshot uploads via the fallback path.
- `/v1/realtime` carries the presence WebSocket — the `Upgrade`/`Connection`
  headers and 1h read timeout are required for it.
- The api enables `trustProxy`, so `X-Forwarded-Proto` from nginx is honored.
- Cert renewal is handled by the existing certbot systemd timer; the renewal
  hook should `systemctl reload nginx`.
- **A4 reminder:** set OpsCore prod `TIMEPRO_URL=https://timepro.systemsd.co`
  and restart OpsCore, or the OpsCore→TimePro login handoff redirect won't land.
