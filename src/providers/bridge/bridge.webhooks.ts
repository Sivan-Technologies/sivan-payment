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
    if (signature.length === 0 || signature.toString('base64') !== signatureBase64) return false;
  } catch {
    return false;
  }

  const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf8'), rawBody]);

  // Bridge's TypeScript/Go samples verify the RSA-SHA256 signature over a SHA256 digest
  // of `${timestamp}.${rawBody}`. Keep a raw-payload fallback for older/internal tests.
  return verifyBridgeDigestSignature(signedPayload, signature, publicKey) || verifyRawRsaSignature(signedPayload, signature, publicKey);
}

function verifyBridgeDigestSignature(signedPayload: Buffer, signature: Buffer, publicKey: string): boolean {
  try {
    const digest = crypto.createHash('sha256').update(signedPayload).digest();
    const verifier = crypto.createVerify('RSA-SHA256');
    verifier.update(digest);
    verifier.end();
    return verifier.verify(publicKey, signature);
  } catch {
    return false;
  }
}

function verifyRawRsaSignature(signedPayload: Buffer, signature: Buffer, publicKey: string): boolean {
  try {
    return crypto.verify('RSA-SHA256', signedPayload, publicKey, signature);
  } catch {
    return false;
  }
}

function normalizePublicKey(publicKey?: string): string {
  return (publicKey ?? '')
    .trim()
    .replace(/^[']|[']$/g, '')
    .replace(/^\"|\"$/g, '')
    .replace(/\\n/g, '\n');
}
