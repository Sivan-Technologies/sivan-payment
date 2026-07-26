import crypto from 'node:crypto';
import { z } from 'zod';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { getUser } from './users.service.js';

const avatarTypes = new Set(['image/jpeg', 'image/png', 'image/webp']);
const maxAvatarBytes = 5 * 1024 * 1024;

export const createAvatarUploadUrlSchema = z.object({
  fileName: z.string().min(1).max(180),
  contentType: z.string().min(3).max(80),
  sizeBytes: z.coerce.number().int().positive()
});

export const confirmAvatarUploadSchema = z.object({
  objectKey: z.string().min(8).max(500),
  publicUrl: z.string().url().optional()
});

function extension(fileName: string, contentType: string) {
  const byType: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
  return byType[contentType] ?? (fileName.toLowerCase().endsWith('.png') ? '.png' : fileName.toLowerCase().endsWith('.webp') ? '.webp' : '.jpg');
}

function publicUrlForKey(key: string) {
  return env.R2_PUBLIC_BASE_URL ? `${env.R2_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}` : undefined;
}

function r2Client() {
  return new S3Client({
    region: env.R2_REGION || 'auto',
    endpoint: env.R2_ENDPOINT,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID, secretAccessKey: env.R2_SECRET_ACCESS_KEY }
  });
}

function assertR2Configured() {
  const missing = [
    ['R2_ENDPOINT', env.R2_ENDPOINT],
    ['R2_ACCESS_KEY_ID', env.R2_ACCESS_KEY_ID],
    ['R2_SECRET_ACCESS_KEY', env.R2_SECRET_ACCESS_KEY],
    ['R2_BUCKET', env.R2_BUCKET]
  ].filter(([, value]) => !value).map(([key]) => key);
  if (missing.length) throw badRequest(`Avatar upload storage is missing: ${missing.join(', ')}`);
}

export async function createAvatarUploadUrl(userId: string, input: z.infer<typeof createAvatarUploadUrlSchema>) {
  await getUser(userId).catch(() => { throw notFound('User'); });
  if (!avatarTypes.has(input.contentType)) throw badRequest('Unsupported profile photo type. Upload JPG, PNG, or WEBP.');
  if (input.sizeBytes > maxAvatarBytes) throw badRequest('Profile photo is too large. Maximum size is 5MB.');
  const objectKey = `avatars/${userId}/${Date.now()}-${crypto.randomUUID()}${extension(input.fileName, input.contentType)}`;

  if (env.SUPPORT_UPLOAD_PROVIDER === 'mock') {
    return { provider: 'mock', method: 'PUT', uploadUrl: `https://mock-upload.sivan.local/${objectKey}`, publicUrl: `https://mock-cdn.sivan.local/${objectKey}`, objectKey, expiresInSeconds: 900, headers: { 'Content-Type': input.contentType } };
  }
  if (env.SUPPORT_UPLOAD_PROVIDER !== 'r2') throw badRequest('Profile photo uploads are not configured.');
  assertR2Configured();
  const command = new PutObjectCommand({ Bucket: env.R2_BUCKET, Key: objectKey, ContentType: input.contentType, Metadata: { user_id: userId, usage: 'avatar' } });
  const uploadUrl = await getSignedUrl(r2Client(), command, { expiresIn: 900 });
  return { provider: 'r2', method: 'PUT', uploadUrl, publicUrl: publicUrlForKey(objectKey), objectKey, expiresInSeconds: 900, headers: { 'Content-Type': input.contentType } };
}

export async function confirmAvatarUpload(userId: string, input: z.infer<typeof confirmAvatarUploadSchema>) {
  const user = await getUser(userId);
  if (!input.objectKey.startsWith(`avatars/${userId}/`)) throw forbidden('Avatar object key does not belong to this user');
  const now = nowIso();
  const next = { ...user, avatarUrl: input.publicUrl || publicUrlForKey(input.objectKey), avatarObjectKey: input.objectKey, avatarUpdatedAt: now, updatedAt: now };
  if (!next.avatarUrl) throw badRequest('Avatar public URL is not configured. Set R2_PUBLIC_BASE_URL or provide publicUrl.');
  await db.updateUserRecord(next);
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'user.avatar_updated', resourceType: 'user', resourceId: userId, severity: 'info', metadata: { objectKey: input.objectKey } });
  return next;
}

export async function removeAvatar(userId: string) {
  const user = await getUser(userId);
  const now = nowIso();
  const next = { ...user, avatarUrl: undefined, avatarObjectKey: undefined, avatarUpdatedAt: now, updatedAt: now };
  await db.updateUserRecord(next);
  await createAuditLog({ actorType: 'user', actorId: userId, action: 'user.avatar_removed', resourceType: 'user', resourceId: userId, severity: 'info', metadata: { previousObjectKey: user.avatarObjectKey } });
  return next;
}
