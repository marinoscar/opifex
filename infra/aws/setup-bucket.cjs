#!/usr/bin/env node
/**
 * Idempotent provisioning for the Opifex S3 bucket.
 *
 * Creates (if missing) and configures the bucket the API uploads media to:
 *   - Block ALL public access (private bucket; access is via presigned URLs only)
 *   - Default server-side encryption (SSE-S3 / AES256)
 *   - CORS so the browser can PUT multipart parts to presigned URLs and read the
 *     ETag response header (required to complete a multipart upload)
 *   - Lifecycle rule to abort incomplete multipart uploads after 7 days
 *
 * Reads configuration from the same env vars the API uses:
 *   S3_BUCKET, S3_REGION (default us-east-1), AWS_ACCESS_KEY_ID,
 *   AWS_SECRET_ACCESS_KEY, S3_ENDPOINT (optional, for MinIO/LocalStack),
 *   APP_URL (added to CORS AllowedOrigins), CORS_EXTRA_ORIGINS (comma-separated).
 *
 * Usage (from a checkout that has @aws-sdk/client-s3 installed, e.g. apps/api):
 *   set -a; source infra/compose/.env; set +a
 *   NODE_PATH=apps/api/node_modules node infra/aws/setup-bucket.cjs
 *
 * Safe to re-run: every step is create-or-update.
 */
const fs = require('fs');
const path = require('path');
const {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketCorsCommand,
  GetBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
} = require('@aws-sdk/client-s3');

const bucket = process.env.S3_BUCKET;
const region = process.env.S3_REGION || 'us-east-1';
const endpoint = process.env.S3_ENDPOINT || undefined;
const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

if (!bucket) {
  console.error('✖ S3_BUCKET is not set. Source infra/compose/.env first.');
  process.exit(1);
}
if (!accessKeyId || !secretAccessKey) {
  console.error(
    '✖ AWS credentials missing (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY).',
  );
  process.exit(1);
}

const s3 = new S3Client({
  region,
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: !!endpoint,
});

// CORS origins: file (cors.json) is the source of truth; APP_URL + extras are merged in.
function buildCors() {
  const corsFile = path.join(__dirname, 'cors.json');
  const rules = JSON.parse(fs.readFileSync(corsFile, 'utf-8'));
  const extra = [];
  if (process.env.APP_URL) extra.push(process.env.APP_URL.replace(/\/$/, ''));
  if (process.env.CORS_EXTRA_ORIGINS) {
    extra.push(
      ...process.env.CORS_EXTRA_ORIGINS.split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    );
  }
  if (extra.length && rules[0]) {
    const set = new Set([...(rules[0].AllowedOrigins || []), ...extra]);
    rules[0].AllowedOrigins = [...set];
  }
  return rules;
}

async function bucketExists() {
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    return true;
  } catch (err) {
    const code = err?.$metadata?.httpStatusCode;
    if (code === 404 || err?.name === 'NotFound') return false;
    if (code === 403) {
      console.error(
        `✖ HeadBucket returned 403 for "${bucket}" — it likely exists but is owned by another account, or the credentials lack s3:ListBucket. Aborting to avoid clobbering.`,
      );
      process.exit(2);
    }
    throw err;
  }
}

async function main() {
  console.log(
    `→ Bucket: ${bucket}  Region: ${region}${endpoint ? `  Endpoint: ${endpoint}` : ''}`,
  );

  const exists = await bucketExists();
  if (!exists) {
    const input = { Bucket: bucket };
    // us-east-1 must NOT include a LocationConstraint; every other region must.
    if (region !== 'us-east-1') {
      input.CreateBucketConfiguration = { LocationConstraint: region };
    }
    try {
      await s3.send(new CreateBucketCommand(input));
      console.log('✔ Bucket created');
    } catch (err) {
      if (err?.name === 'BucketAlreadyOwnedByYou') {
        console.log('• Bucket already owned by you — continuing');
      } else {
        throw err;
      }
    }
  } else {
    console.log('• Bucket already exists — updating configuration');
  }

  // 1) Block all public access (private bucket; presigned URLs only)
  await s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }),
  );
  console.log('✔ Public access blocked (private bucket)');

  // 2) Default encryption (SSE-S3)
  await s3.send(
    new PutBucketEncryptionCommand({
      Bucket: bucket,
      ServerSideEncryptionConfiguration: {
        Rules: [
          { ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } },
        ],
      },
    }),
  );
  console.log('✔ Default encryption enabled (AES256)');

  // 3) CORS (browser presigned multipart PUT + ETag exposure)
  const corsRules = buildCors();
  await s3.send(
    new PutBucketCorsCommand({
      Bucket: bucket,
      CORSConfiguration: { CORSRules: corsRules },
    }),
  );
  console.log('✔ CORS applied:');
  console.log(JSON.stringify(corsRules, null, 2));

  // 4) Lifecycle: abort incomplete multipart uploads after 7 days
  await s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'abort-incomplete-multipart-uploads',
            Status: 'Enabled',
            Filter: { Prefix: '' },
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 7 },
          },
        ],
      },
    }),
  );
  console.log('✔ Lifecycle rule set (abort incomplete multipart after 7 days)');

  // Verify CORS round-trips
  const got = await s3.send(new GetBucketCorsCommand({ Bucket: bucket }));
  console.log('✔ Verified CORS on bucket:');
  console.log(JSON.stringify(got.CORSRules, null, 2));

  console.log('\n✅ Done. Bucket is provisioned and configured.');
}

main().catch((err) => {
  console.error('✖ Provisioning failed:', err?.name || '', err?.message || err);
  process.exit(1);
});
