# SSL & Nginx Reverse Proxy Setup for opifex.dev.marin.cr

This covers deploying Opifex to the shared `dev.marin.cr` VPS. Production is not
set up yet; when it is, it will follow the separate `/opt/infra` model used by
the other `*.marin.cr` apps rather than the one described here.

## Overview

Opifex runs behind a two-tier Nginx reverse proxy on the `dev.marin.cr` VPS,
sharing the wildcard SSL certificate and subdomain routing with the other
projects on that host (Knecta, Knotes, Clipboard, ShellKeep, MemoriaHub, …).
The pattern is the same one MemoriaHub uses.

```
Internet (HTTPS :443)
|
v
Host Nginx (systemd; SSL termination, wildcard cert for *.dev.marin.cr)
|
|   map $host -> $backend_port:
|     opifex.dev.marin.cr  -> 127.0.0.1:8328
|
v  127.0.0.1:8328
Docker Compose stack (app-network + devnet)
+-- Nginx container (port 80 -> published as 8328, client_max_body_size 128m)
|   +-- /api  -> API container (port 3000)
|   +-- /     -> Web container (Vite dev server :5173)
+-- API container (NestJS + Fastify)  [joined to devnet]
+-- Web container (React + Vite)
+-- (no DB container -- uses the external shared PostgreSQL via devnet)
```

**Key characteristics**

- **No database container.** Opifex uses the shared PostgreSQL container
  (hostname `postgres`) on the `devnet` Docker network, like Knecta and Knotes.
  The API container joins both `app-network` and `devnet`.
- **Development mode.** The host serves the Vite dev server, so this deployment
  runs `NODE_ENV=development`. That has a security consequence — see
  [Test auth](#test-auth-must-be-disabled-here).
- **Uploads.** The simple-upload endpoint (`POST /api/storage/objects`) is capped
  at 100 MB by the `@fastify/multipart` limit in `apps/api/src/main.ts`; the
  internal Nginx allows 128 MB so oversized requests reach the API and get a JSON
  error instead of Nginx's HTML 413. Resumable uploads use pre-signed URLs
  straight to S3 and never pass through Nginx.
- **S3 storage.** Objects live in the dedicated `marin-opifex` bucket. See
  [`infra/aws/README.md`](../infra/aws/README.md).

## Port assignment

The authoritative list is the host Nginx `map` block in
`/etc/nginx/sites-available/dev-wildcard`. This table is a copy and can drift —
check the live file before claiming a port.

| Project | Port | Subdomain |
|---------|------|-----------|
| ModelGate | 8318 | modelgate.dev.marin.cr |
| Knecta | 8319 | knecta.dev.marin.cr |
| Clipboard | 8320 | clipboard.dev.marin.cr |
| Semantic Convert | 8321 | semantic.dev.marin.cr |
| *(8322 unassigned — a gap of unknown cause; left alone)* | | |
| ShellKeep | 8323 | shellkeep.dev.marin.cr |
| Store Front (raul1) | 8324 | raul1.dev.marin.cr |
| Store Front (raul2) | 8325 | raul2.dev.marin.cr |
| Knotes | 8326 | knotes.dev.marin.cr |
| MemoriaHub | 8327 | memoriahub.dev.marin.cr |
| **Opifex** | **8328** | **opifex.dev.marin.cr** |

## Step 0: Prerequisites

```bash
docker ps --format '{{.Names}}' | grep -x postgres        # shared PG must be running
docker network ls | grep -w devnet || docker network create devnet
ss -ltnp | grep -E ':83(1[89]|2[0-9])' || true            # confirm 8328 is free
grep -n '83[0-9][0-9]' /etc/nginx/sites-available/dev-wildcard
```

## Step 1: Update the host Nginx map

Add Opifex to the `map` block in `/etc/nginx/sites-available/dev-wildcard`:

```nginx
map $host $backend_port {
    ...
    memoriahub.dev.marin.cr   8327;
    opifex.dev.marin.cr       8328;    # <-- add this
    ...
}
```

Back up first, then test and reload:

```bash
sudo cp /etc/nginx/sites-available/dev-wildcard \
        /etc/nginx/sites-available/dev-wildcard.bak.$(date +%F)
sudo nano /etc/nginx/sites-available/dev-wildcard
sudo nginx -t && sudo systemctl reload nginx
```

No DNS change is needed — `*.dev.marin.cr` already resolves to the VPS. No new
certificate is needed — the wildcard covers all subdomains.

> **The host Nginx must stay healthy.** `nginx.service`'s `ExecStartPre` runs
> `nginx -t` across **every** site in `sites-enabled/`, so a broken config in any
> unrelated site prevents the whole service from starting and takes every
> `*.dev.marin.cr` subdomain offline. Always `nginx -t` before reloading, and
> prefer `reload` over `restart`. If subdomains go dark, check
> `systemctl status nginx` and `sudo nginx -t`, fix the offending site, then
> `sudo systemctl start nginx`.

## Step 2: Register the Google OAuth callback

In the [Google Cloud Console](https://console.cloud.google.com/apis/credentials),
add this authorized redirect URI to the shared OAuth client:

```
https://opifex.dev.marin.cr/api/auth/google/callback
```

It must match `GOOGLE_CALLBACK_URL` in `.env` exactly, or login fails with
`redirect_uri_mismatch`.

## Step 3: Create the database

Opifex uses the shared PostgreSQL container. Creating the database is a one-off:

```bash
docker exec postgres psql -U admin -d postgres -c "CREATE DATABASE opifex;"
docker exec postgres psql -U admin -d postgres -c '\l' | grep opifex
```

## Step 4: Configure the environment

```bash
cd /home/marinoscar/git/opifex/infra/compose
cp .env.example .env
chmod 600 .env

# Generate two DIFFERENT secrets — never reuse another app's
openssl rand -base64 32     # -> JWT_SECRET
openssl rand -base64 32     # -> COOKIE_SECRET
```

`.env.example` documents every variable. The ones that must change for this host:

| Variable | Value | Where it comes from |
|---|---|---|
| `COMPOSE_PROJECT_NAME` | `opifex` | literal — **mandatory**, see below |
| `NGINX_PORT` | `8328` | literal, after the port check |
| `NODE_ENV` | `development` | literal (Vite dev server) |
| `APP_URL` | `https://opifex.dev.marin.cr` | literal |
| `CORS_ORIGIN` | `https://opifex.dev.marin.cr` | literal |
| `POSTGRES_HOST` | `postgres` | literal — devnet DNS |
| `POSTGRES_USER` | `admin` | shared PostgreSQL user |
| `POSTGRES_PASSWORD` | — | copy from another app's `.env` on this host |
| `POSTGRES_DB` | `opifex` | literal |
| `POSTGRES_SSL` | `false` | literal — same Docker network |
| `JWT_SECRET` | — | **generate** |
| `COOKIE_SECRET` | — | **generate** (a second, different one) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | — | copy from the shared OAuth client |
| `GOOGLE_CALLBACK_URL` | `https://opifex.dev.marin.cr/api/auth/google/callback` | literal |
| `INITIAL_ADMIN_EMAIL` | your Google address | first login with it becomes Admin |
| `TEST_AUTH_ENABLED` | `false` | literal — **security-critical**, see below |
| `S3_BUCKET` | `marin-opifex` | literal |
| `S3_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | — | copy from the shared AWS credentials |
| `OTEL_ENABLED` | `false` | literal — no collector in this stack |

> **`COMPOSE_PROJECT_NAME` is not optional.** Compose derives the project name
> from the directory holding the compose file, which is `compose` for every app
> using this layout. Without an explicit name, `docker compose up` here can treat
> a sibling app's containers as orphans of this project and remove them. Set it
> before the first `up`.

### Test auth must be disabled here

`POST /api/auth/test/login` bypasses OAuth **and** the email allowlist and can
issue an admin session for any address. It is registered whenever
`NODE_ENV !== 'production'` — which this deployment is, because it serves the
Vite dev server. Set `TEST_AUTH_ENABLED=false`; the API honours it and leaves
the module unregistered, so the route 404s.

## Step 5: Deploy

```bash
cd /home/marinoscar/git/opifex/infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up -d --build
docker compose -f base.compose.yml -f dev.compose.yml ps
```

## Step 6: Apply migrations and seed

Seeding is **mandatory before the first login** — it creates the roles and
permissions, and without them user creation fails with `Default role not found`.

```bash
docker compose -f base.compose.yml -f dev.compose.yml exec api npm run prisma:migrate
docker compose -f base.compose.yml -f dev.compose.yml exec api npm run prisma:seed
```

## Step 7: Provision the S3 bucket

See [`infra/aws/README.md`](../infra/aws/README.md):

```bash
docker compose -f base.compose.yml -f dev.compose.yml cp ../aws api:/app/apps/api/aws-setup
docker compose -f base.compose.yml -f dev.compose.yml exec api node /app/apps/api/aws-setup/setup-bucket.cjs
```

## Step 8: Verify

```bash
# Against the published container port, on the host
curl -s http://localhost:8328/api/health/live
curl -s http://localhost:8328/api/health/ready

# End-to-end through the host Nginx + SSL
curl -s https://opifex.dev.marin.cr/api/health/ready
curl -sI https://opifex.dev.marin.cr/ | head -1

# The test-auth bypass must be gone
curl -so /dev/null -w '%{http_code}\n' -X POST https://opifex.dev.marin.cr/api/auth/test/login   # expect 404

# Neighbours must be unaffected by the nginx reload
curl -s https://memoriahub.dev.marin.cr/api/health/live

# Seed landed?
docker exec postgres psql -U admin -d opifex -c 'select name from roles;'
```

Then open `https://opifex.dev.marin.cr/` and sign in with Google using the
`INITIAL_ADMIN_EMAIL` account — it becomes Admin on first login. The API
reference is at `https://opifex.dev.marin.cr/api/docs`.

## Redeploying

```bash
cd /home/marinoscar/git/opifex
git pull --ff-only
cd infra/compose
docker compose -f base.compose.yml -f dev.compose.yml up -d --build
# only if apps/api/prisma/migrations/ changed:
docker compose -f base.compose.yml -f dev.compose.yml exec api npm run prisma:migrate
```

The internal Nginx re-resolves the `api` and `web` container names through
Docker's DNS every 10s, so a rebuild no longer strands it on stale IPs.

## Troubleshooting

**502 Bad Gateway**
- Containers down: `docker compose -f base.compose.yml -f dev.compose.yml ps`
- Port mismatch: confirm `NGINX_PORT=8328` in `.env` matches the host Nginx map.

**Every subdomain is unreachable**
- The host Nginx service is down. `systemctl status nginx`, then `sudo nginx -t`
  to find the offending site config, fix it, `sudo systemctl start nginx`.

**Another app's containers disappeared**
- `COMPOSE_PROJECT_NAME` was unset. Set it, then bring the other app back up.

**`Blocked request. This host is not allowed.`**
- `opifex.dev.marin.cr` is missing from `allowedHosts` in
  `apps/web/vite.config.ts`. It is baked into the image, so redeploy with
  `--build`.

**Database connection refused**
- `docker network ls | grep devnet`
- `docker compose ... exec api sh -c "nc -zv postgres 5432"`
- `docker exec postgres psql -U admin -d postgres -c '\l' | grep opifex`

**413 Request Entity Too Large**
- Confirm `client_max_body_size 128m` in `infra/nginx/nginx.conf` and that the
  host `dev-wildcard` config permits at least as much. For large files use the
  resumable flow (`POST /api/storage/objects/upload/init`), which streams to S3.

**Google OAuth errors**
- `https://opifex.dev.marin.cr/api/auth/google/callback` must be registered on
  the OAuth client and match `GOOGLE_CALLBACK_URL` exactly.

**Uploads succeed but completing a multipart upload fails**
- The bucket CORS policy is missing `ETag` in `ExposeHeaders`. Re-run
  `setup-bucket.cjs`.

## File reference

| File | Purpose |
|------|---------|
| `/etc/nginx/sites-available/dev-wildcard` | Host reverse proxy — subdomain→port map + SSL |
| `/etc/letsencrypt/live/dev.marin.cr/` | Wildcard SSL certificate and key |
| `infra/nginx/nginx.conf` | Docker-internal routing, resolver, body-size limit |
| `infra/compose/base.compose.yml` | Base services; `env_file: .env`; api on devnet |
| `infra/compose/dev.compose.yml` | Development overrides (Vite, hot reload) |
| `infra/compose/.env` | Environment (DB, Google OAuth, AWS S3) — never committed |
| `infra/aws/` | S3 bucket provisioning and CORS policy |
