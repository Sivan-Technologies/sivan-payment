import { env } from '../config/env.js';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfterSeconds: number;
  key: string;
}

interface RateLimitPolicy {
  name: string;
  windowMs: number;
  max: number;
}

export function getRateLimitPolicy(method: string, url: string): RateLimitPolicy | null {
  if (!env.RATE_LIMIT_ENABLED) return null;
  if (url === '/health') return null;

  // Keep Bridge webhook capacity high enough for retries/bursts.
  if (url.startsWith('/api/webhooks/bridge')) {
    return { name: 'webhook', windowMs: 60_000, max: env.RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE };
  }

  // OTP endpoints are the most abuse-sensitive.
  if (method === 'POST' && url.startsWith('/api/auth/email/start')) {
    return { name: 'auth_start', windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS, max: env.RATE_LIMIT_AUTH_START_MAX };
  }

  if (method === 'POST' && url.startsWith('/api/auth/email/verify')) {
    return { name: 'auth_verify', windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS, max: env.RATE_LIMIT_AUTH_VERIFY_MAX };
  }

  if (url.startsWith('/api/admin')) {
    return { name: 'admin', windowMs: 60_000, max: env.RATE_LIMIT_ADMIN_MAX_PER_MINUTE };
  }

  return { name: 'default', windowMs: 60_000, max: env.RATE_LIMIT_DEFAULT_MAX_PER_MINUTE };
}

export function checkRateLimit(input: {
  ip: string;
  method: string;
  url: string;
  email?: string;
}): RateLimitDecision | null {
  const policy = getRateLimitPolicy(input.method, input.url);
  if (!policy) return null;

  const identity = input.email ? `${input.ip}:${input.email.toLowerCase()}` : input.ip;
  const key = `${policy.name}:${identity}`;
  const now = Date.now();
  const existing = buckets.get(key);

  if (!existing || existing.resetAt <= now) {
    const bucket = { count: 1, resetAt: now + policy.windowMs };
    buckets.set(key, bucket);
    pruneExpiredBuckets(now);
    return {
      allowed: true,
      limit: policy.max,
      remaining: Math.max(policy.max - 1, 0),
      resetAt: bucket.resetAt,
      retryAfterSeconds: 0,
      key
    };
  }

  existing.count += 1;
  const remaining = Math.max(policy.max - existing.count, 0);
  const retryAfterSeconds = Math.ceil((existing.resetAt - now) / 1000);

  return {
    allowed: existing.count <= policy.max,
    limit: policy.max,
    remaining,
    resetAt: existing.resetAt,
    retryAfterSeconds,
    key
  };
}

function pruneExpiredBuckets(now: number) {
  // Opportunistic cleanup to avoid unbounded memory growth.
  if (buckets.size < 10_000) return;
  for (const [key, bucket] of buckets.entries()) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}
