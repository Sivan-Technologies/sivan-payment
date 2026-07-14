import crypto from 'node:crypto';
import { z } from 'zod';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env.js';
import { badRequest } from '../shared/errors.js';

const allowedTypes = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/heic',
  'application/pdf'
]);

export const createSupportUploadUrlSchema = z.object({
  userId: z.string().min(1),
  fileName: z.string().min(1).max(180),
  contentType: z.string().min(3).max(120),
  sizeBytes: z.coerce.number().int().positive()
});

function extension(fileName: string) {
  const clean = fileName.toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  const ext = clean.split('.').pop();
  return ext && ext !== clean ? `.${ext.slice(0, 12)}` : '';
}

function publicUrlForKey(key: string) {
  return env.R2_PUBLIC_BASE_URL ? `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}` : undefined;
}

export async function createSupportAttachmentUploadUrl(input: z.infer<typeof createSupportUploadUrlSchema>) {
  if (!allowedTypes.has(input.contentType)) {
    throw badRequest('Unsupported attachment type. Upload PNG, JPG, WEBP, HEIC, or PDF.');
  }
  if (input.sizeBytes > env.SUPPORT_ATTACHMENT_MAX_BYTES) {
    throw badRequest(`Attachment is too large. Maximum size is ${Math.round(env.SUPPORT_ATTACHMENT_MAX_BYTES / 1024 / 1024)}MB.`);
  }

  const objectKey = `support/${input.userId}/${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}${extension(input.fileName)}`;

  if (env.SUPPORT_UPLOAD_PROVIDER === 'mock') {
    return {
      provider: 'mock',
      method: 'PUT',
      uploadUrl: `https://mock-upload.sivan.local/${objectKey}`,
      publicUrl: `https://mock-cdn.sivan.local/${objectKey}`,
      objectKey,
      expiresInSeconds: 900,
      headers: { 'Content-Type': input.contentType }
    };
  }

  if (env.SUPPORT_UPLOAD_PROVIDER !== 'r2') {
    throw badRequest('Support uploads are not configured. Paste a screenshot/receipt URL instead.');
  }

  const missing = [
    ['R2_ENDPOINT', env.R2_ENDPOINT],
    ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID],
    ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY],
    ['R2_BUCKET', env.R2_BUCKET]
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw badRequest(`Support upload storage is missing: ${missing.join(', ')}`);

  const client = new S3Client({
    region: env.R2_REGION || 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: {
      accessKeyId: env.R2_ACCESS_KEY_ID,
      secretAccessKey: env.R2_SECRET_ACCESS_KEY
    }
  });
  const command = new PutObjectCommand({
    Bucket: env.R2_BUCKET,
    Key: objectKey,
    ContentType: input.contentType,
    Metadata: {
      user_id: input.userId,
      original_name: input.fileName.slice(0, 120)
    }
  });
  const uploadUrl = await getSignedUrl(client, command, { expiresIn: 900 });
  return {
    provider: 'r2',
    method: 'PUT',
    uploadUrl,
    publicUrl: publicUrlForKey(objectKey),
    objectKey,
    expiresInSeconds: 900,
    headers: { 'Content-Type': input.contentType }
  };
}
