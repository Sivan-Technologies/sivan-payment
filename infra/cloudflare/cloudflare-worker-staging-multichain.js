// ==============================================================================
// SIVAN MULTI-CHAIN STAGING GATEWAY — Cloudflare Worker
// Deploy on Routes:
//   - staging.sivantech.online/*
//   - api-staging.sivantech.online/*
//
// Features:
//   - Routes /api/payment/* to Multi-Chain Payments Backend
//   - Routes /api/v1/fraud/* to Standalone ML Fraud Engine Microservice
//   - Routes /mcp (Model Context Protocol & SSE streams) for AI agents
//   - Routes all frontend views (/pin-pad, /claim, /agreements) to Staging WebApp
//   - Full CORS, WebAuthn headers, and resilient retry logic
// ==============================================================================

// ─── DYNAMIC UPSTREAM RESOLVER ───────────────────────────────────────────────
// Sourced dynamically from Cloudflare Worker env bindings to avoid hardcoded URLs
function resolveUpstreams(env = {}) {
  return {
    escrowPrimary: env.UPSTREAM_ESCROW_API || env.ESCROW_API_URL || "https://sivan-escrow-agent-test-gb84.onrender.com",
    escrowFallback: env.UPSTREAM_ESCROW_FALLBACK || env.ESCROW_FALLBACK_API_URL || "https://sivan-escrow-agent-test-gb84.onrender.com",
    payments: env.UPSTREAM_PAYMENTS_API || env.PAYMENTS_API_URL || "https://sivan-payments-api-test.onrender.com",
    telegram: env.UPSTREAM_TELEGRAM_API || env.TELEGRAM_API_URL || "https://sivan-telegram-service-bh32.onrender.com",
    whatsapp: env.UPSTREAM_WHATSAPP_API || env.WHATSAPP_API_URL || "https://sivan-whatsapp-bot-test.onrender.com",
    fraud: env.UPSTREAM_FRAUD_ENGINE || env.FRAUD_ENGINE_URL || "https://sivan-fraud-engine-staging.onrender.com",
    frontend: env.UPSTREAM_FRONTEND_APP || env.FRONTEND_APP_URL || "https://sivan-payments-user-test.onrender.com",
    auth: env.UPSTREAM_AUTH || env.AUTH_API_URL || "https://telegram-admin-auth-z3e8.onrender.com",
    ai: env.UPSTREAM_SIVAN_AI || env.SIVAN_AI_URL || "https://ai.sivantech.online",
  };
}

// ─── CORS WHITELIST ──────────────────────────────────────────────────────────
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/staging\.sivantech\.online$/i,
  /^https:\/\/api-staging\.sivantech\.online$/i,
  /^https:\/\/app\.sivantech\.online$/i,
  /^https:\/\/sivantech\.online$/i,
  /^https:\/\/([a-z0-9-]+\.)*sivantech\.online$/i,
  /^https:\/\/sivan-[a-z0-9-]*\.onrender\.com$/i,
  /^https:\/\/sivan-[a-z0-9-]*\.vercel\.app$/i,
  /^http:\/\/localhost:\d+$/i,
  /^http:\/\/127\.0\.0\.1:\d+$/i,
];

const DEFAULT_ALLOWED_HEADERS =
  "Content-Type, Authorization, x-admin-api-key, x-admin-key, x-sivan-request-id, " +
  "x-sivan-target-service, x-sivan-identity-link-secret, x-step-up-token, sentry-trace, baggage";

const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 800;
const UPSTREAM_TIMEOUT_MS = 60000;

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function getCorsHeaders(request) {
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
    "Access-Control-Allow-Headers":
      request.headers.get("access-control-request-headers") || DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (origin && isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

function applyCors(response, request) {
  const cors = getCorsHeaders(request);
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(cors)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(url, options, timeoutMs = UPSTREAM_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
}

// ─── GATEWAY REQUEST DISPATCHER ──────────────────────────────────────────────
export default {
  async fetch(request, env, ctx) {
    const requestId =
      request.headers.get("x-sivan-request-id") ||
      `req_stg_${Math.random().toString(36).substring(2, 10)}`;

    // 1. Handle CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: getCorsHeaders(request),
      });
    }

    const url = new URL(request.url);
    const pathname = url.pathname;
    const upstreams = resolveUpstreams(env);

    const isApiHost = url.hostname.startsWith("api-staging") || url.hostname.startsWith("api.");

    let targetUpstream = upstreams.frontend;
    let fallbackUpstream = null;
    let targetPath = pathname;
    let serviceName = "frontend";

    // 2. Intelligent Route Matching
    if (pathname.startsWith("/api/v1/fraud")) {
      targetUpstream = upstreams.fraud;
      targetPath = pathname;
      serviceName = "fraud-engine";
    } else if (pathname.startsWith("/mcp")) {
      targetUpstream = upstreams.payments;
      targetPath = pathname;
      serviceName = "mcp-gateway";
    } else if (
      pathname.startsWith("/api/escrow") ||
      pathname.startsWith("/api/users/escrows") ||
      pathname === "/api/users/profile" ||
      pathname === "/api/users/payout-account" ||
      pathname === "/api/users/link-email" ||
      pathname === "/api/users/pair-whatsapp" ||
      pathname.startsWith("/api/paystack")
    ) {
      targetUpstream = upstreams.escrowPrimary;
      fallbackUpstream = upstreams.escrowFallback;
      targetPath = pathname;
      serviceName = "escrow-api";
    } else if (pathname.startsWith("/api/telegram") || pathname.startsWith("/webhooks/telegram") || pathname === "/api/notify" || pathname.startsWith("/api/notify/telegram")) {
      targetUpstream = upstreams.telegram;
      targetPath = pathname.startsWith("/api/telegram") ? (pathname.replace(/^\/api\/telegram/, "") || "/") : (pathname.startsWith("/api/notify/telegram") ? "/api/notify" : pathname);
      serviceName = "telegram-service";
    } else if (pathname.startsWith("/api/whatsapp") || pathname.startsWith("/webhooks/whatsapp") || pathname.startsWith("/webhooks/twilio") || pathname.startsWith("/webhooks/meta")) {
      targetUpstream = upstreams.whatsapp;
      targetPath = pathname.startsWith("/api/whatsapp") ? (pathname.replace(/^\/api\/whatsapp/, "") || "/") : pathname;
      serviceName = "whatsapp-service";
    } else if (pathname.startsWith("/api/admin-auth")) {
      targetUpstream = upstreams.auth;
      targetPath = pathname.replace(/^\/api\/admin-auth/, "") || "/";
      serviceName = "admin-auth";
    } else if (pathname.startsWith("/api/sivan-ai") || pathname.startsWith("/api/ai")) {
      targetUpstream = upstreams.ai;
      targetPath = pathname.startsWith("/api/sivan-ai") ? (pathname.replace(/^\/api\/sivan-ai/, "") || "/") : pathname;
      serviceName = "sivan-ai";
    } else if (pathname.startsWith("/api/payment")) {
      targetUpstream = upstreams.payments;
      targetPath = pathname.replace(/^\/api\/payment/, "") || "/";
      serviceName = "payments-api";
    } else if (isApiHost) {
      // Entire api-staging.sivantech.online domain routes to Payments Backend
      targetUpstream = upstreams.payments;
      targetPath = pathname;
      serviceName = "payments-api-host";
    } else if (pathname.startsWith("/api/")) {
      // Direct API call on web frontend domain -> Payments Backend
      targetUpstream = upstreams.payments;
      targetPath = pathname;
      serviceName = "payments-api-fallback";
    } else {
      // Frontend static assets & SPA routes (/pin-pad, /claim, /agreements, etc.)
      targetUpstream = upstreams.frontend;
      targetPath = pathname;
      serviceName = "frontend-spa";
    }

    // Clone headers and inject tracing
    const upstreamHeaders = new Headers(request.headers);
    upstreamHeaders.set("x-sivan-request-id", requestId);
    upstreamHeaders.set("x-forwarded-host", url.host);
    upstreamHeaders.set("x-sivan-gateway-env", "staging-multichain");

    // Remove hop-by-hop headers
    upstreamHeaders.delete("cf-connecting-ip");
    upstreamHeaders.delete("cf-ray");

    const fetchOptions = {
      method: request.method,
      headers: upstreamHeaders,
      body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: "follow",
    };

    const isRetryable = RETRYABLE_METHODS.has(request.method);
    const maxAttempts = isRetryable ? MAX_ATTEMPTS : 1;

    const upstreamCandidates = [targetUpstream];
    if (fallbackUpstream && fallbackUpstream !== targetUpstream) {
      upstreamCandidates.push(fallbackUpstream);
    }

    let lastError = null;

    for (const upstream of upstreamCandidates) {
      const targetUrl = new URL(targetPath + url.search, upstream);
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const upstreamResponse = await fetchWithTimeout(targetUrl.toString(), fetchOptions);

          // If backend returned 502/503 on a retryable GET, retry once or failover
          if (isRetryable && [502, 503, 504].includes(upstreamResponse.status)) {
            if (attempt < maxAttempts) {
              await sleep(RETRY_DELAY_MS);
              continue;
            }
            break;
          }

          return applyCors(upstreamResponse, request);
        } catch (err) {
          lastError = err;
          if (attempt < maxAttempts) {
            await sleep(RETRY_DELAY_MS);
          }
        }
      }
    }

    // Fallback response if upstream is unreachable
    console.error(`[${requestId}] [${serviceName}] Gateway error:`, lastError?.message || "Unknown error");

    const errorPayload = {
      error: {
        code: "GATEWAY_TIMEOUT",
        message: `The staging ${serviceName} service is temporarily unreachable.`,
        requestId,
        path: pathname,
        timestamp: new Date().toISOString(),
      },
    };

    return new Response(JSON.stringify(errorPayload), {
      status: 503,
      headers: {
        "Content-Type": "application/json",
        ...getCorsHeaders(request),
      },
    });
  },
};
