# AWS S3 bucket for Opifex

Opifex stores uploaded objects in a private S3 bucket. Browsers never talk to
the bucket directly with credentials — the API hands out pre-signed URLs and the
browser `PUT`s to those, so the bucket stays fully private while uploads bypass
the API and nginx entirely.

Default bucket: **`marin-opifex`** (set `S3_BUCKET` in `infra/compose/.env`).

## Provisioning

`setup-bucket.cjs` is idempotent — safe to re-run. It:

- creates the bucket if it is missing;
- blocks **all** public access;
- enables default server-side encryption (SSE-S3 / AES256);
- applies the CORS policy from `cors.json`, merged with `APP_URL` and any
  comma-separated `CORS_EXTRA_ORIGINS`;
- adds a lifecycle rule aborting incomplete multipart uploads after 7 days.

It reads the same environment variables the API uses: `S3_BUCKET`, `S3_REGION`
(default `us-east-1`), `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`,
`S3_ENDPOINT` (optional, MinIO/LocalStack), `APP_URL`, `CORS_EXTRA_ORIGINS`.

### On the dev VPS (no host-side `npm install`)

The repo is never `npm install`ed on the VPS — everything runs in containers —
so run the script inside the API container, where `@aws-sdk/client-s3` already
lives. Copy the whole directory in so the script can find `cors.json` beside
itself and still resolve `node_modules` from `/app/apps/api`:

```bash
cd /home/marinoscar/git/opifex/infra/compose

docker compose -f base.compose.yml -f dev.compose.yml \
  cp ../aws api:/app/apps/api/aws-setup

docker compose -f base.compose.yml -f dev.compose.yml \
  exec api node /app/apps/api/aws-setup/setup-bucket.cjs
```

### From a checkout that has dependencies installed

```bash
set -a; source infra/compose/.env; set +a
NODE_PATH=apps/api/node_modules node infra/aws/setup-bucket.cjs
```

### CORS only, with the AWS CLI

If the bucket already exists and you just need the CORS policy:

```bash
aws s3api put-bucket-cors \
  --bucket marin-opifex \
  --cors-configuration file://infra/aws/cors.json
```

## Why `ExposeHeaders: ETag` matters

Multipart uploads complete by sending S3 the `ETag` of every part. The browser
can only read a response header that CORS explicitly exposes, so without `ETag`
in `ExposeHeaders` every resumable upload fails at the completion step, even
though each individual part uploaded fine.

## Verifying

A pre-flight from an allowed origin should return the CORS headers:

```bash
curl -s -D - -o /dev/null -X OPTIONS \
  "https://marin-opifex.s3.amazonaws.com/probe" \
  -H "Origin: https://opifex.dev.marin.cr" \
  -H "Access-Control-Request-Method: PUT"
```

Expect `Access-Control-Allow-Origin` and
`Access-Control-Expose-Headers: ETag`. The same request with an unlisted
`Origin` should be rejected.

## Adding an origin

Add it to `cors.json` and re-run the script (or the `put-bucket-cors` command).
When a production hostname exists, add it here too.
