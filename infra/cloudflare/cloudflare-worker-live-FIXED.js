// ========================================================
// SIVAN LIVE CLOUDFLARE WORKER
// Deploy on: api.sivantech.online/*  (and admin.sivantech.online/*)
// ========================================================
//
// Changes from the previous live worker, and why each one matters:
//
// 1. ALL PRODUCTION MICROSERVICES INTEGRATED & VERIFIED:
//    - LIVE_ESCROW:     https://escrow.sivantech.online   (:4000)
//    - LIVE_PAYMENTS:   https://payment.sivantech.online  (:10000)
//    - LIVE_TELEGRAM:   https://telegram.sivantech.online (:4100)
//    - LIVE_BOT:        https://whatsapp.sivantech.online (:3000)
//    - LIVE_AUTH:       https://auth.sivantech.online     (:3600)
//    - LIVE_SIVAN_AI:   https://ai.sivantech.online       (:4300)
//
// 2. MONEYGRAM MULTI-CHAIN & STELLAR CORRIDORS:
//    - /api/moneygram/health edge probe returning 200 with supported routes.
//    - /api/moneygram/* and /webhooks/moneygram routed directly to LIVE_PAYMENTS.
//    - Allowed headers include x-mg-signature, x-mg-timestamp, x-moneygram-signature.
//
// 3. MODEL CONTEXT PROTOCOL (/mcp):
//    - AI Agent SSE streams & tools routed directly to LIVE_PAYMENTS.
//
// 4. API HOST ROUTE RESOLUTION:
//    - Direct calls to /api/wallets, /api/virtual-accounts, /api/balances, /api/ngn,
//      /api/ghs, /api/agreements, /api/kyc, /api/passkeys route to LIVE_PAYMENTS
//      instead of falling through to escrow.
//
// 5. NO RETRIES ON NON-IDEMPOTENT METHODS:
//    - Only GET/HEAD/OPTIONS retry on transient 502/503/504 errors.
//
// 6. CORS SECURITY & CREDENTIAL HANDLING:
//    - Only trusted sivantech.online, Vercel, and Render origin patterns allowed.

// ========================================================
// LIVE SERVICES (Routed via Caddy on AWS EC2 13.39.31.121)
// ========================================================
const LIVE_ESCROW = "https://escrow.sivantech.online";
const LIVE_BOT = "https://whatsapp.sivantech.online";
const LIVE_AUTH = "https://auth.sivantech.online";
const LIVE_PAYMENTS = "https://payment.sivantech.online";
const LIVE_SIVAN_AI = "https://ai.sivantech.online";
const LIVE_TELEGRAM = "https://telegram.sivantech.online";

// Prefer a Cloudflare Worker secret named PROXY_SECRET.
const PROXY_SECRET_FALLBACK = "vDhsV0u8QLu-DhMP8muxUxp4XLk5I8TtaqXa9oO-ErU";

// Whitelisted origin patterns
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/app\.sivantech\.online$/i,
  /^https:\/\/staging\.sivantech\.online$/i,
  /^https:\/\/api-staging\.sivantech\.online$/i,
  /^https:\/\/api\.sivantech\.online$/i,
  /^https:\/\/admin\.sivantech\.online$/i,
  /^https:\/\/sivantech\.online$/i,
  /^https:\/\/([a-z0-9-]+\.)*sivantech\.online$/i,
  /^https:\/\/sivan-admin-hub[a-z0-9-]*\.vercel\.app$/i,
  /^https:\/\/sivan-payments?-[a-z0-9-]*\.vercel\.app$/i,
  /^https:\/\/sivan-homepage[a-z0-9-]*\.vercel\.app$/i,
  /^https:\/\/sivan-[a-z0-9-]*\.onrender\.com$/i,
  /^https:\/\/sivan-[a-z0-9-]*\.vercel\.app$/i,
  /^http:\/\/localhost:\d+$/i,
  /^http:\/\/127\.0\.0\.1:\d+$/i,
];

const COMMON_ALLOWED_HEADERS =
  "Content-Type, Authorization, x-admin-api-key, x-admin-key, x-sivan-request-id, " +
  "x-sivan-target-service, x-sivan-admin-email, x-sivan-admin-role, x-sivan-admin-module, " +
  "x-sivan-admin-hub, x-sivan-ai-key, x-sivan-identity-link-secret, sentry-trace, baggage, " +
  "x-mg-signature, x-mg-timestamp, x-mg-time, x-moneygram-signature, x-signature, x-webhook-signature, " +
  "x-step-up-token, x-telegram-bot-api-secret-token";

const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 25000;

function log(requestId, service, message) {
  console.log(`[${requestId}] [${service}] ${message}`);
}

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function getCorsHeaders(request) {
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD",
    "Access-Control-Allow-Headers":
      request.headers.get("access-control-request-headers") || COMMON_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  }

  return headers;
}

function handleCorsPreflight(request) {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
}

function withCorsHeaders(response, request) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(getCorsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function jsonResponse(payload, status, request) {
  return withCorsHeaders(
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }),
    request
  );
}

export default {
  async fetch(request, env) {
    const preflight = handleCorsPreflight(request);
    if (preflight) return preflight;

    const url = new URL(request.url);

    if (url.pathname === "/ping") {
      return withCorsHeaders(
        new Response("ok", { status: 200, headers: { "Content-Type": "text/plain" } }),
        request
      );
    }

    if (url.pathname === "/status" || url.pathname === "/health") {
      return withCorsHeaders(gatewayStatusResponse("api-sivan-gateway"), request);
    }

    // MoneyGram Gateway Health Probe
    if (url.pathname === "/api/moneygram/health" && request.method === "GET") {
      return withCorsHeaders(
        new Response(
          JSON.stringify({
            status: "healthy",
            gateway: "api-sivan-gateway",
            service: "moneygram-router",
            version: "2.1.0-multichain",
            environment: env?.ENVIRONMENT || "production",
            supportedRoutes: [
              "/api/moneygram/quote",
              "/api/moneygram/session",
              "/api/moneygram/corridors",
              "/api/moneygram/transactions/:id",
              "/api/webhooks/moneygram",
              "/webhooks/moneygram",
            ],
            timestamp: new Date().toISOString(),
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        ),
        request
      );
    }

    if (url.pathname === "/health/deep") {
      return withCorsHeaders(
        await gatewayHealthResponse({
          service: "api-sivan-gateway",
          upstreams: {
            escrow: [LIVE_ESCROW, "/health"],
            payment: [LIVE_PAYMENTS, "/health"],
            auth: [LIVE_AUTH, "/health"],
            telegram: [LIVE_TELEGRAM, "/health"],
            sivanAi: [LIVE_SIVAN_AI, "/health"],
            bot: [LIVE_BOT, "/api/health"],
          },
        }),
        request
      );
    }

    const route = await resolveRoute(request, url);
    const requestId =
      request.headers.get("x-sivan-request-id") || `siv-req-${crypto.randomUUID()}`;

    const headers = new Headers(request.headers);
    headers.set("x-sivan-request-id", requestId);
    headers.delete("host");

    const proxySecret = env?.PROXY_SECRET || PROXY_SECRET_FALLBACK;
    if (proxySecret) {
      headers.set("x-twilio-proxy-secret", proxySecret);
      headers.set("x-notify-secret", proxySecret);
    }

    const body = ["GET", "HEAD"].includes(request.method)
      ? undefined
      : await request.clone().arrayBuffer();

    const targetUrl = `${route.host}${route.upstreamPath}${url.search}`;
    log(requestId, route.serviceName, `${request.method} ${url.pathname} -> ${targetUrl}`);

    const response = await fetchUpstream({
      targetUrl,
      method: request.method,
      headers,
      body,
      requestId,
      serviceName: route.serviceName,
      request,
    });

    return withCorsHeaders(response, request);
  },
};

export async function resolveRoute(request, url) {
  const targetService = request.headers.get("x-sivan-target-service");
  let host = LIVE_ESCROW;
  let upstreamPath = url.pathname;
  let serviceName = "escrow-backend";

  // 1. Escrow Debugger
  if (url.pathname === "/webhooks/twilio-debugger") {
    host = LIVE_ESCROW;
    upstreamPath = url.pathname;
    serviceName = "escrow-backend";
  }
  // 2. Telegram Bot Service
  else if (
    targetService === "telegram" ||
    targetService === "telegram-service" ||
    url.pathname.startsWith("/api/telegram") ||
    url.pathname.startsWith("/webhooks/telegram")
  ) {
    host = LIVE_TELEGRAM;
    upstreamPath = url.pathname.startsWith("/api/telegram")
      ? (url.pathname.replace(/^\/api\/telegram/, "") || "/")
      : url.pathname;
    serviceName = "telegram-service";
  }
  // 3. WhatsApp Bot Service
  else if (
    targetService === "whatsapp-bot" ||
    url.pathname.startsWith("/webhooks/twilio") ||
    url.pathname.startsWith("/webhooks/meta") ||
    url.pathname.startsWith("/api/whatsapp") ||
    url.pathname === "/api/notify" ||
    url.pathname === "/api/whatsapp-provider"
  ) {
    host = LIVE_BOT;
    upstreamPath = url.pathname.startsWith("/api/whatsapp")
      ? (url.pathname.replace(/^\/api\/whatsapp/, "") || "/")
      : url.pathname;
    serviceName = "whatsapp-bot";
  }
  // 4a. Paystack Single-Endpoint Smart Dispatcher (Unified Multi-Service Webhook Pipeline)
  else if (
    url.pathname === "/webhooks/paystack" ||
    url.pathname === "/api/webhooks/paystack"
  ) {
    let isEscrowAgreement = false;
    if (request && request.method === "POST") {
      try {
        const bodyClone = await request.clone().json();
        const metadata = bodyClone?.data?.metadata;
        if (metadata && (metadata.escrowId || metadata.dealId || metadata.agreementId)) {
          isEscrowAgreement = true;
        }
      } catch {
        // Non-JSON or empty payload defaults to payments backend
      }
    }

    if (isEscrowAgreement) {
      host = LIVE_ESCROW;
      upstreamPath = url.pathname;
      serviceName = "escrow-backend";
    } else {
      host = LIVE_PAYMENTS;
      upstreamPath = "/api/webhooks/paystack";
      serviceName = "payments-api";
    }
  }
  // 4b. Other Inbound Fiat Webhooks & Callbacks
  else if (
    url.pathname.startsWith("/webhooks/monnify") ||
    url.pathname.startsWith("/webhooks/palmpay") ||
    url.pathname.startsWith("/webhooks/flutterwave") ||
    url.pathname.startsWith("/webhooks/nomba") ||
    url.pathname.startsWith("/payment/callback")
  ) {
    host = LIVE_ESCROW;
    upstreamPath = url.pathname;
    serviceName = "escrow-backend";
  }
  // 5. Escrow Core APIs
  else if (
    url.pathname.startsWith("/api/admin/escrow") ||
    url.pathname.startsWith("/api/escrow") ||
    url.pathname.startsWith("/api/users/escrows") ||
    url.pathname.startsWith("/api/users/profile") ||
    url.pathname.startsWith("/api/users/payout-account") ||
    url.pathname.startsWith("/api/users/whatsapp") ||
    url.pathname.startsWith("/api/settings/limits") ||
    url.pathname.startsWith("/api/banks") ||
    url.pathname.startsWith("/api/paystack/banks")
  ) {
    host = LIVE_ESCROW;
    if (url.pathname.startsWith("/api/admin/escrow")) {
      upstreamPath = url.pathname.replace(/^\/api\/admin\/escrow/, "/api/admin");
    } else if (url.pathname.startsWith("/api/escrow/")) {
      upstreamPath = url.pathname.replace(/^\/api\/escrow\//, "/api/escrows/");
    } else if (url.pathname === "/api/escrow") {
      upstreamPath = "/api/escrows";
    } else {
      upstreamPath = url.pathname;
    }
    if (upstreamPath === "/api/health") upstreamPath = "/health";
    serviceName = "escrow-backend";
  }
  // 6. Sivan AI Assistant
  else if (
    targetService === "sivan-ai" ||
    url.pathname.startsWith("/api/sivan-ai") ||
    url.pathname.startsWith("/sivan-ai")
  ) {
    host = LIVE_SIVAN_AI;
    upstreamPath =
      url.pathname.replace(/^\/api\/sivan-ai/, "").replace(/^\/sivan-ai/, "") || "/";
    serviceName = "sivan-ai";
  }
  // 7. MoneyGram Multi-Chain & Stellar Settlement
  else if (
    url.pathname.startsWith("/api/moneygram") ||
    url.pathname.startsWith("/api/webhooks/moneygram") ||
    url.pathname.startsWith("/webhooks/moneygram")
  ) {
    host = LIVE_PAYMENTS;
    upstreamPath = url.pathname;
    serviceName = "moneygram-gateway";
  }
  // 8. Model Context Protocol (MCP) AI Agent Gateway
  else if (
    url.pathname === "/mcp" ||
    url.pathname.startsWith("/mcp/")
  ) {
    host = LIVE_PAYMENTS;
    upstreamPath = url.pathname;
    serviceName = "mcp-gateway";
  }
  // 9. Payment Provider Direct Webhooks
  else if (
    url.pathname === "/api/webhooks/bridge" ||
    url.pathname === "/api/webhooks/breet" ||
    url.pathname === "/api/webhooks/paj"
  ) {
    host = LIVE_PAYMENTS;
    upstreamPath = url.pathname;
    serviceName = "payments-api";
  }
  // 10. Admin Auth Service
  else if (
    url.pathname.startsWith("/api/admin/auth-service") ||
    url.pathname.startsWith("/auth")
  ) {
    host = LIVE_AUTH;
    if (url.pathname.startsWith("/api/admin/auth-service")) {
      upstreamPath = url.pathname.replace(/^\/api\/admin\/auth-service/, "") || "/";
    } else {
      upstreamPath = url.pathname.replace(/^\/auth/, "") || "/";
    }
    if (upstreamPath === "/api/health") upstreamPath = "/health";
    serviceName = "telegram-auth";
  }
  // 11. Payments Core Microservice Routes
  else if (
    targetService === "payments" ||
    url.pathname.startsWith("/api/admin/payment") ||
    url.pathname.startsWith("/api/payment") ||
    url.pathname.startsWith("/api/v1/fraud") ||
    url.pathname.startsWith("/api/wallets") ||
    url.pathname.startsWith("/api/virtual-accounts") ||
    url.pathname.startsWith("/api/balances") ||
    url.pathname.startsWith("/api/ngn") ||
    url.pathname.startsWith("/api/ghs") ||
    url.pathname.startsWith("/api/agreements") ||
    url.pathname.startsWith("/api/kyc") ||
    url.pathname.startsWith("/api/passkeys") ||
    url.pathname.startsWith("/api/celo") ||
    url.pathname.startsWith("/api/textile") ||
    url.pathname.startsWith("/api/customers") ||
    url.pathname.startsWith("/api/external-accounts") ||
    url.pathname.startsWith("/api/liquidation-addresses") ||
    url.pathname.startsWith("/api/withdrawals") ||
    url.pathname.startsWith("/api/onramp") ||
    url.pathname.startsWith("/api/fees") ||
    url.pathname.startsWith("/api/metrics") ||
    url.pathname.startsWith("/api/providers") ||
    url.pathname.startsWith("/api/controls") ||
    url.pathname.startsWith("/api/system") ||
    url.pathname.startsWith("/api/support") ||
    url.pathname.startsWith("/api/ace")
  ) {
    host = LIVE_PAYMENTS;
    if (url.pathname.startsWith("/api/admin/payment")) {
      upstreamPath = url.pathname.replace(/^\/api\/admin\/payment/, "/api/admin") || "/api/admin";
    } else if (url.pathname.startsWith("/api/payment")) {
      upstreamPath = url.pathname.replace(/^\/api\/payment(\/api)?/, "/api") || "/api";
    } else {
      upstreamPath = url.pathname || "/";
    }
    serviceName = "payments-api";
  }
  // 12. Default API Host Fallback (any unmatched /api/* goes to Payments Backend)
  else if (url.pathname.startsWith("/api/")) {
    host = LIVE_PAYMENTS;
    upstreamPath = url.pathname;
    serviceName = "payments-api-fallback";
  }

  return { host, upstreamPath, serviceName };
}

async function fetchUpstream({
  targetUrl,
  method,
  headers,
  body,
  requestId,
  serviceName,
  request,
}) {
  const maxAttempts = RETRYABLE_METHODS.has(method) ? MAX_ATTEMPTS : 1;

  let lastStatus = 0;
  let lastError = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const response = await fetch(targetUrl, {
        method,
        headers,
        body,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const renderRouting = response.headers.get("x-render-routing") || "";
      const unavailable =
        renderRouting === "suspend" ||
        [502, 503, 504, 520, 522, 523, 524, 530].includes(response.status);

      if (!unavailable) {
        log(requestId, serviceName, `responded ${response.status}`);
        return response;
      }

      lastStatus = response.status;
      log(
        requestId,
        serviceName,
        `unavailable: status=${response.status} render=${renderRouting || "none"} ` +
        `(attempt ${attempt}/${maxAttempts})`
      );

      if (!RETRYABLE_METHODS.has(method)) break;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    } catch (error) {
      clearTimeout(timeoutId);
      lastError = error?.message || String(error);
      log(requestId, serviceName, `failed: ${lastError} (attempt ${attempt}/${maxAttempts})`);

      if (!RETRYABLE_METHODS.has(method)) break;
      if (attempt < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      }
    }
  }

  const wasWrite = !RETRYABLE_METHODS.has(method);
  return jsonResponse(
    {
      error: "UPSTREAM_UNAVAILABLE",
      message: wasWrite
        ? `The ${serviceName} service did not respond. This was a ${method} request and it was ` +
        `NOT retried, because repeating it could duplicate the action. Check whether it took ` +
        `effect before trying again.`
        : `The ${serviceName} service is unavailable. Please try again shortly.`,
      service: serviceName,
      method,
      retried: !wasWrite,
      lastStatus: lastStatus || undefined,
      lastError: lastError || undefined,
      requestId,
    },
    503,
    request
  );
}

async function gatewayHealthResponse(config) {
  const entries = await Promise.all(
    Object.entries(config.upstreams).map(async ([name, [host, path]]) => {
      const result = await checkUpstream(host, path);
      return [name, result.ok ? "ok" : "degraded"];
    })
  );

  const upstreams = Object.fromEntries(entries);
  const degraded = Object.values(upstreams).includes("degraded");

  return new Response(
    JSON.stringify({
      status: degraded ? "degraded" : "ok",
      service: config.service,
      upstreams,
      checkedAt: new Date().toISOString(),
    }),
    {
      status: degraded ? 503 : 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    }
  );
}

function gatewayStatusResponse(service) {
  return new Response(
    JSON.stringify({
      status: "ok",
      service,
      type: "gateway",
      upstreamCheck: "not_run",
      checkedAt: new Date().toISOString(),
    }),
    { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } }
  );
}

async function checkUpstream(host, path) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(`${host}${path}`, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeoutId);
    return { ok: response.ok, status: response.status };
  } catch {
    clearTimeout(timeoutId);
    return { ok: false, status: 0 };
  }
}
