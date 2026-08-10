// ========================================================
// SIVAN LIVE CLOUDFLARE WORKER
// Deploy on: api.sivantech.online/*  (and admin.sivantech.online/*)
// ========================================================
//
// Changes from the previous live worker, and why each one matters:
//
// 1. FALLBACK HOSTS REMOVED.
//    Every one of them was verified dead on 2026-07-29:
//      sivan-escrow-agent-live.onrender.com    503 x-render-routing: suspend
//      sivan-whatsapp-bot-live.onrender.com    503 x-render-routing: suspend
//      sivan-payments-api-live.onrender.com    503 x-render-routing: suspend
//      telegram-admin-auth-live.onrender.com   404 x-render-routing: no-server
//      sivan-ai.onrender.com                   200 (but identical to primary)
//    A fallback that can never succeed is not resilience, it is latency. The
//    old flow spent 2 primary attempts + 1.5s sleep + a doomed fallback call
//    before failing, which pushed past Cloudflare's edge limit and surfaced in
//    the browser as a 503 / ERR_NETWORK_CHANGED. Restore a fallback here only
//    when a real standby host exists.
//
// 2. NO RETRIES ON NON-IDEMPOTENT METHODS.
//    The old worker retried every method. POST /reprovision is not idempotent:
//    each call provisions a NEW Bridge virtual account at $2/month that still
//    accepts deposits. Two 503s in the admin hub on 2026-07-29 created two
//    surplus accounts this way. GET/HEAD/OPTIONS are safe to retry; nothing
//    else is.
//
// 3. CORS IS NO LONGER A BARE ORIGIN REFLECTION.
//    `Access-Control-Allow-Origin: <any origin>` combined with
//    `Allow-Credentials: true` lets ANY website make credentialed calls to the
//    admin API using a logged-in admin's browser. Now allowlisted.
//
// 4. Syntax fixed: `console.log\`...\`)` was a tagged template plus a stray
//    paren. Logging is via a helper that actually produces a string.
//
// 5. Timeout reduced 20s -> 12s. Cloudflare gives ~30s at the edge; two 20s
//    attempts could never both complete.

// ========================================================
// LIVE SERVICES
// ========================================================
const LIVE_ESCROW = "https://escrow.sivantech.online";
const LIVE_BOT = "https://whatsapp.sivantech.online";
const LIVE_AUTH = "https://auth.sivantech.online";
const LIVE_PAYMENTS = "https://payment.sivantech.online";
const LIVE_SIVAN_AI = "https://ai.sivantech.online";

// Prefer a Cloudflare Worker secret named PROXY_SECRET. This literal is a
// deployment convenience only and SHOULD BE REMOVED once the secret is set;
// anyone reading the worker source can otherwise impersonate the gateway.
const PROXY_SECRET_FALLBACK = "vDhsV0u8QLu-DhMP8muxUxp4XLk5I8TtaqXa9oO-ErU";

// Only these origins may make credentialed cross-origin calls. This list is
// the only thing standing between a hostile page and an authenticated request
// to the admin API using a logged-in admin's own browser. Add specific
// prefixes, never a bare `*.vercel.app`.
const ALLOWED_ORIGIN_PATTERNS = [
  /^https:\/\/sivan-admin-hub[a-z0-9-]*\.vercel\.app$/i,
  /^https:\/\/sivan-payments?-[a-z0-9-]*\.vercel\.app$/i,
  /^https:\/\/sivan-homepage[a-z0-9-]*\.vercel\.app$/i,
  // RENDER-HOSTED FRONTENDS WERE MISSING ENTIRELY.
  //
  // The Sivan frontends are deployed to BOTH Vercel and Render, but only the
  // vercel.app patterns were ever added here - so every browser call from
  // sivan-payments-user-test.onrender.com and its live twin was blocked at
  // this gateway. The page loaded and then failed at every fetch, which reads
  // to a user as "the app is broken" and to an engineer as a backend fault.
  // The API's own CORS_ORIGIN already allowed these; the gateway in front of
  // it did not, and the gateway answers the preflight.
  //
  // Caught in a browser: the verification page on the Render frontend showed
  // Bridge copy to a pending Nigerian because the summary call never
  // completed. The same commit passed 11/11 on Vercel.
  //
  // Anchored to the sivan- product prefix, never a bare *.onrender.com, which
  // any stranger can deploy to.
  /^https:\/\/sivan-[a-z0-9-]*\.onrender\.com$/i,
  /^https:\/\/([a-z0-9-]+\.)*sivantech\.online$/i,
  /^http:\/\/localhost:\d+$/i,
  /^http:\/\/127\.0\.0\.1:\d+$/i,
];

const COMMON_ALLOWED_HEADERS =
  "Content-Type, Authorization, x-admin-api-key, x-admin-key, x-sivan-request-id, " +
  "x-sivan-target-service, x-sivan-admin-email, x-sivan-admin-role, x-sivan-admin-module, " +
  "x-sivan-admin-hub, x-sivan-ai-key, x-sivan-identity-link-secret, sentry-trace, baggage";

// Retrying these is safe because repeating them changes nothing. Everything
// else can create or move money.
const RETRYABLE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1000;
const UPSTREAM_TIMEOUT_MS = 12000;

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
    // Responses differ per origin, so they must never be cached across origins.
    Vary: "Origin",
  };

  // Only echo an origin we actually trust. An unknown origin gets no
  // allow-origin header at all, which the browser treats as a refusal.
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

    if (url.pathname === "/health/deep") {
      return withCorsHeaders(
        await gatewayHealthResponse({
          service: "api-sivan-gateway",
          upstreams: {
            escrow: [LIVE_ESCROW, "/health"],
            payment: [LIVE_PAYMENTS, "/health"],
            auth: [LIVE_AUTH, "/health"],
            sivanAi: [LIVE_SIVAN_AI, "/health"],
            bot: [LIVE_BOT, "/api/health"],
          },
        }),
        request
      );
    }

    const route = resolveRoute(request, url);
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

function resolveRoute(request, url) {
  const targetService = request.headers.get("x-sivan-target-service");
  let host = LIVE_ESCROW;
  let upstreamPath = url.pathname;
  let serviceName = "escrow-backend";

  if (url.pathname === "/webhooks/twilio-debugger") {
    host = LIVE_ESCROW;
    upstreamPath = url.pathname;
    serviceName = "escrow-backend";
  } else if (
    targetService === "whatsapp-bot" ||
    url.pathname.startsWith("/webhooks/twilio") ||
    url.pathname === "/api/notify" ||
    url.pathname === "/api/whatsapp-provider"
  ) {
    host = LIVE_BOT;
    upstreamPath = url.pathname;
    serviceName = "whatsapp-bot";
  } else if (
    url.pathname.startsWith("/webhooks/monnify") ||
    url.pathname.startsWith("/webhooks/palmpay") ||
    url.pathname.startsWith("/webhooks/flutterwave") ||
    url.pathname.startsWith("/webhooks/nomba") ||
    url.pathname.startsWith("/webhooks/paystack") ||
    url.pathname.startsWith("/payment/callback")
  ) {
    host = LIVE_ESCROW;
    upstreamPath = url.pathname;
    serviceName = "escrow-backend";
  } else if (
    url.pathname.startsWith("/api/admin/escrow") ||
    url.pathname.startsWith("/api/escrow")
  ) {
    host = LIVE_ESCROW;
    upstreamPath =
      url.pathname.replace(/^\/api\/admin\/escrow/, "").replace(/^\/api\/escrow/, "") || "/";
    if (upstreamPath === "/api/health") upstreamPath = "/health";
    serviceName = "escrow-backend";
  } else if (
    targetService === "sivan-ai" ||
    url.pathname.startsWith("/api/sivan-ai") ||
    url.pathname.startsWith("/sivan-ai")
  ) {
    host = LIVE_SIVAN_AI;
    upstreamPath =
      url.pathname.replace(/^\/api\/sivan-ai/, "").replace(/^\/sivan-ai/, "") || "/";
    serviceName = "sivan-ai";
  } else if (url.pathname === "/api/webhooks/bridge") {
    host = LIVE_PAYMENTS;
    upstreamPath = "/api/webhooks/bridge";
    serviceName = "payments-api";
  } else if (
    url.pathname === "/api/webhooks/breet" ||
    url.pathname === "/api/webhooks/paj"
  ) {
    // NGN provider webhooks -> payments API, path unchanged.
    //
    // Not rewritten: Breet and PajRamp POST the literal URL configured in their
    // dashboards, so stripping a prefix would deliver to a path the API does
    // not serve. Without this rule the request falls through to escrow and
    // 404s; Breet then retries with backoff for 24 hours and gives up, which
    // reads as silence rather than as an outage.
    //
    // Breet authenticates with a static x-webhook-secret header rather than a
    // body signature, and the payments API re-fetches the transaction from
    // Breet before crediting. Both need headers intact - only Host is stripped.
    host = LIVE_PAYMENTS;
    upstreamPath = url.pathname;
    serviceName = "payments-api";
  } else if (
    targetService === "payments" ||
    url.pathname.startsWith("/api/admin/payment") ||
    url.pathname.startsWith("/api/payment")
  ) {
    host = LIVE_PAYMENTS;
    // /api/payment/api/system/status        -> /api/system/status
    // /api/admin/payment/api/admin/whatever -> /api/admin/whatever
    // /api/admin/payment/health             -> /health
    // Do not prepend /api/admin here; the caller already includes it.
    upstreamPath =
      url.pathname.replace(/^\/api\/admin\/payment/, "").replace(/^\/api\/payment/, "") || "/";
    serviceName = "payments-api";
  } else if (
    url.pathname.startsWith("/api/admin/auth-service") ||
    url.pathname.startsWith("/auth")
  ) {
    host = LIVE_AUTH;
    if (url.pathname.startsWith("/api/admin/auth-service")) {
      // The Telegram auth service expects the /auth/* prefix, so it is kept.
      upstreamPath = url.pathname.replace(/^\/api\/admin\/auth-service/, "") || "/";
    } else {
      upstreamPath = url.pathname.replace(/^\/auth/, "") || "/";
    }
    if (upstreamPath === "/api/health") upstreamPath = "/health";
    serviceName = "telegram-auth";
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
  // A write must be attempted exactly once. Retrying POST /reprovision is how
  // surplus Bridge virtual accounts get created.
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

      // A write that reached a failing upstream must NOT be repeated: the
      // request may well have been processed before the error surfaced.
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

  // Deliberately explicit for writes: the caller must know the request may or
  // may not have been applied, so that a blind retry is not the obvious move.
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
