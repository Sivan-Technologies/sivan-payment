import crypto from 'node:crypto';
import { env } from '../config/env.js';

export interface UserJwtPayload {
  sub: string;
  email?: string;
  roles?: string[];
  typ: 'user';
  iat: number;
  exp: number;
  iss: string;
  aud: string;
}

function base64url(input: Buffer | string) {
  return Buffer.from(input).toString('base64url');
}

export function signUserJwt(input: { userId: string; email?: string; roles?: string[] }) {
  const now = Math.floor(Date.now() / 1000);
  const payload: UserJwtPayload = {
    sub: input.userId,
    email: input.email,
    roles: input.roles ?? ['user'],
    typ: 'user',
    iat: now,
    exp: now + env.USER_JWT_EXPIRES_MINUTES * 60,
    iss: 'sivan-payments-api',
    aud: 'sivan-payments-user'
  };
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = base64url(JSON.stringify(header));
  const encodedPayload = base64url(JSON.stringify(payload));
  const signature = crypto
    .createHmac('sha256', env.USER_JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

export function verifyUserJwt(token: string): UserJwtPayload {
  const [encodedHeader, encodedPayload, signature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !signature) throw new Error('Invalid token');
  const expected = crypto
    .createHmac('sha256', env.USER_JWT_SECRET)
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest('base64url');
  // crypto.timingSafeEqual throws a RangeError when the buffers differ in
  // length, which would surface as a 500 instead of a 401 for any attacker
  // supplying a truncated or padded signature. Compare lengths first, then run
  // the constant-time comparison on equal-length buffers.
  const signatureBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (
    signatureBuffer.length !== expectedBuffer.length ||
    !crypto.timingSafeEqual(signatureBuffer, expectedBuffer)
  ) {
    throw new Error('Invalid token');
  }
  const payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as UserJwtPayload;
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error('Token expired');
  if (payload.iss !== 'sivan-payments-api' || payload.aud !== 'sivan-payments-user' || payload.typ !== 'user') throw new Error('Invalid token');
  return payload;
}
