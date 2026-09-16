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
  if (method === 'OPTIONS') return null;
  const path = url.split('?')[0];
  if (path === '/health') return null;
  // Polled every minute by an uptime monitor. Rate limiting the thing that
  // tells you the system is broken is how an outage becomes invisible.
  if (path === '/health/operational' || path === '/health/db') return null;

  // Read-only API calls are used heavily by dashboards for bootstrap, focus,
  // visibility, and status refreshes. Throttling them in the in-process user-action
  // bucket creates noisy 429s that browsers surface as CORS failures. Keep abuse
  // controls on mutation/auth/webhook/admin paths here; let CDN/edge protection
  // handle abusive read-only scraping before it reaches the app.
  if ((method === 'GET' || method === 'HEAD') && !path.startsWith('/api/admin')) return null;

  // Keep Bridge webhook capacity high enough for retries/bursts.
  if (path.startsWith('/api/webhooks/bridge')) {
    return { name: 'webhook', windowMs: 60_000, max: env.RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE };
  }

  // Service agreements (creation, funding, delivery, release, dispute, cancel)
  // WebMCP AI agents and frontend interactions require elevated burst throughput.
  if (path.startsWith('/api/agreements')) {
    return { name: 'agreements', windowMs: 60_000, max: env.RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE };
  }

  // Session refresh tokens (background sliding session renewals)
  if (method === 'POST' && (path.startsWith('/api/auth/session/refresh') || path.startsWith('/api/auth/refresh'))) {
    return { name: 'session_refresh', windowMs: 60_000, max: env.RATE_LIMIT_DEFAULT_MAX_PER_MINUTE };
  }

  /**
   * Pairing-code redemption, called by the WhatsApp and Telegram bots.
   *
   * Uses the webhook allowance rather than the default bucket because the
   * shape of the traffic is the same: ONE upstream service relaying many
   * users, all arriving from a single IP. The default per-IP bucket would
   * throttle every user at once as soon as the bot got busy, and a user whose
   * code was refused for that reason cannot tell it from a bad code.
   *
   * This bounds a flood; it is not the brute-force control. A code is
   * SVP-XXXX-99 over a 24-letter, 8-digit alphabet (~21M combinations) and
   * both routes already require the service secret, so an attacker needs the
   * bot's credential before they can guess at all. A per-telegramUserId
   * attempt limit in the service would be the tighter control and is worth
   * adding, but belongs next to the token lookup rather than here.
   */
  if (method === 'POST' && path.startsWith('/api/identity/link-')) {
    return { name: 'identity_redeem', windowMs: 60_000, max: env.RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE };
  }

  /**
   * Withdrawal PIN verification.
   *
   * The service already locks an ACCOUNT after a few wrong PINs, which stops
   * guessing many PINs against one person. It does not stop the opposite
   * shape: one likely PIN tried against thousands of accounts. Each account
   * sees a single failure and never locks, so without a limit here that costs
   * an attacker nothing.
   *
   * Keyed on IP, deliberately tighter than the redeem policy above. A real bot
   * sends one of these when a user is confirming a payment they are already
   * looking at, so a low ceiling per minute is far above legitimate use and far
   * below useful for spraying.
   *
   * NOT a substitute for the per-account lockout - it is the other half. An
   * attacker with many IPs defeats this alone; an attacker with one IP defeats
   * the lockout alone.
   */
  if (method === 'POST' && path === '/api/identity/verify-pin') {
    return { name: 'withdrawal_pin_verify', windowMs: 60_000, max: 10 };
  }

  // OTP endpoints are the most abuse-sensitive.
  if (method === 'POST' && path.startsWith('/api/auth/email/start')) {
    return { name: 'auth_start', windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS, max: env.RATE_LIMIT_AUTH_START_MAX };
  }

  if (method === 'POST' && path.startsWith('/api/auth/email/verify')) {
    return { name: 'auth_verify', windowMs: env.RATE_LIMIT_AUTH_WINDOW_MS, max: env.RATE_LIMIT_AUTH_VERIFY_MAX };
  }

  if (path.startsWith('/api/admin')) {
    return { name: 'admin', windowMs: 60_000, max: env.RATE_LIMIT_ADMIN_MAX_PER_MINUTE };
  }

  return { name: 'default', windowMs: 60_000, max: env.RATE_LIMIT_DEFAULT_MAX_PER_MINUTE };
}

export function checkRateLimit(input: {
  ip: string;
  method: string;
  url: string;
  email?: string;
  userId?: string;
}): RateLimitDecision | null {
  const policy = getRateLimitPolicy(input.method, input.url);
  if (!policy) return null;

  const identity = input.userId
    ? `usr_${input.userId}`
    : (input.email ? `${input.ip}:${input.email.toLowerCase()}` : input.ip);
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
