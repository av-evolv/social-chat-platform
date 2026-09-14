import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import {
  S3Client, HeadBucketCommand, PutBucketCorsCommand,
  CreateMultipartUploadCommand, UploadPartCommand, ListPartsCommand,
  CompleteMultipartUploadCommand, AbortMultipartUploadCommand,
  HeadObjectCommand, GetObjectCommand, DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

function required(name) {
  const value = process.env[name];
  assert.ok(value, `Set ${name} in .env`);
  return value;
}

const Bucket = required('GARAGE_DEFAULT_BUCKET');
const origin = required('CLIENT_ORIGIN');
const apiOrigin = required('API_ORIGIN');
const config = {
  region: required('S3_REGION'),
  forcePathStyle: true,
  // Garage does not implement every optional AWS checksum extension.
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: {
    accessKeyId: required('GARAGE_DEFAULT_ACCESS_KEY'),
    secretAccessKey: required('GARAGE_DEFAULT_SECRET_KEY'),
  },
};
const storage = new S3Client({ ...config, endpoint: required('S3_ENDPOINT') });
const signer = new S3Client({ ...config, endpoint: required('S3_PUBLIC_ENDPOINT') });
const commandOptions = () => ({ abortSignal: AbortSignal.timeout(10_000) });
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(10_000) });

async function eventually(action) {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { return await action(); }
    catch (error) {
      if (attempt === 29) throw error;
      await delay(1000);
    }
  }
}

const Key = `larynx-smoke/${randomUUID()}`;
let UploadId;
try {
  for (const path of ['/health/live', '/health/ready']) {
    await eventually(async () => assert.equal((await request(`${apiOrigin}${path}`)).status, 200));
  }
  assert.equal((await request(`${apiOrigin}/api/conversations`)).status, 404);
  assert.equal((await request(origin)).status, 200);
  console.log('Client delivery and API liveness/readiness passed; no placeholder product endpoint.');

  await eventually(() => storage.send(new HeadBucketCommand({ Bucket }), commandOptions()));
  // Development/CI bucket configuration only, never a production provisioning script.
  await storage.send(new PutBucketCorsCommand({
    Bucket,
    CORSConfiguration: { CORSRules: [{
      AllowedOrigins: [origin], AllowedMethods: ['GET', 'HEAD', 'PUT'],
      AllowedHeaders: ['content-type', 'x-amz-*'], ExposeHeaders: ['ETag'], MaxAgeSeconds: 300,
    }] },
  }), commandOptions());

  ({ UploadId } = await storage.send(new CreateMultipartUploadCommand({
    Bucket, Key, ContentType: 'application/octet-stream',
  }), commandOptions()));
  assert.ok(UploadId);
  // Random bytes stand in for client ciphertext. This verifies transport, not E2EE.
  const bodies = [randomBytes(5 * 1024 * 1024), randomBytes(12345)];
  const parts = [];
  for (let index = 0; index < bodies.length; index++) {
    const PartNumber = index + 1;
    const url = await getSignedUrl(signer, new UploadPartCommand({ Bucket, Key, UploadId, PartNumber }), { expiresIn: 60 });
    if (index === 0) {
      const preflight = await request(url, {
        method: 'OPTIONS',
        headers: { Origin: origin, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' },
      });
      assert.ok(preflight.ok, 'Upload CORS preflight succeeds');
      assert.equal(preflight.headers.get('access-control-allow-origin'), origin);
    }
    const uploaded = await request(url, {
      method: 'PUT', body: bodies[index], headers: { Origin: origin, 'Content-Type': 'application/octet-stream' },
    });
    assert.ok(uploaded.ok, `Signed part ${PartNumber} upload succeeds`);
    assert.ok(uploaded.headers.get('etag'));
    parts.push({ PartNumber, ETag: uploaded.headers.get('etag') });
    // Reconstruct coordinator state from persisted parts before continuing the transfer.
    const listed = await storage.send(new ListPartsCommand({ Bucket, Key, UploadId }), commandOptions());
    assert.deepEqual(listed.Parts.map(({ PartNumber, ETag }) => ({ PartNumber, ETag })), parts);
  }
  await storage.send(new CompleteMultipartUploadCommand({ Bucket, Key, UploadId, MultipartUpload: { Parts: parts } }), commandOptions());
  UploadId = undefined;
  const head = await storage.send(new HeadObjectCommand({ Bucket, Key }), commandOptions());
  assert.equal(head.ContentLength, bodies.reduce((sum, body) => sum + body.length, 0));
  const downloadUrl = await getSignedUrl(signer, new GetObjectCommand({ Bucket, Key }), { expiresIn: 60 });
  const downloaded = await request(downloadUrl, { headers: { Origin: origin } });
  assert.equal(downloaded.status, 200);
  assert.equal(downloaded.headers.get('access-control-allow-origin'), origin);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), Buffer.concat(bodies));
  const unsignedUrl = new URL(downloadUrl);
  unsignedUrl.search = '';
  assert.equal((await request(unsignedUrl)).status, 403, 'Unsigned private object access is denied');
  await storage.send(new DeleteObjectCommand({ Bucket, Key }), commandOptions());
  await assert.rejects(storage.send(new HeadObjectCommand({ Bucket, Key }), commandOptions()),
    (error) => error.$metadata?.httpStatusCode === 404);
  console.log('Garage signed multipart upload, part recovery, CORS, metadata validation, signed download, access denial and deletion passed.');
} finally {
  // Cleanup only this invocation's uniquely named object/upload, including failure paths.
  try {
    if (UploadId) await storage.send(new AbortMultipartUploadCommand({ Bucket, Key, UploadId }), commandOptions());
  } finally {
    try { await storage.send(new DeleteObjectCommand({ Bucket, Key }), commandOptions()); }
    finally { storage.destroy(); signer.destroy(); }
  }
}
