import crypto from 'node:crypto';
import { env } from '../../config/env.js';

export function verifyBridgeWebhookSignature(rawBody: Buffer, signatureHeader?: string, publicKey = env.BRIDGE_WEBHOOK_PUBLIC_KEY): boolean {
  publicKey = normalizePublicKey(publicKey);
  if (!publicKey) return env.APP_ENV !== 'production';
  if (!signatureHeader) return false;

  const parts = Object.fromEntries(
    signatureHeader.split(',').map((part) => {
      const [key, ...rest] = part.trim().split('=');
      return [key, rest.join('=')];
    })
  );

  const timestamp = parts.t;
  const signatureBase64 = parts.v0;
  if (!timestamp || !signatureBase64) return false;

  const timestampMs = Number(timestamp);
  if (!Number.isFinite(timestampMs)) return false;
  if (Math.abs(Date.now() - timestampMs) > env.WEBHOOK_MAX_AGE_MS) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureBase64, 'base64');
    if (signature.length === 0) return false;
  } catch {
    return false;
  }

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);
  return crypto.verify('RSA-SHA256', signedPayload, publicKey, signature);
}


function normalizePublicKey(publicKey?: string): string {
  return (publicKey ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\n/g, '\n');
}
