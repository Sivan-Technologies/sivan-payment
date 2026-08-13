// ========================================================
// SIVAN TEST GATEWAY — Cloudflare Worker
// Deploy on: test-sivan.sivantech.online/*
//
// Why the previous version broke Sivan AI:
//
//   The payments fallback pointed at sivan-payments-api-test.onrender.com,
//   which Render has SUSPENDED. When the worker fell through to it, Render
//   returned an HTML page reading "This service has been suspended", which the
//   browser surfaced as a 503 after ~12s. The AI itself was never called:
//   sivan-ai.onrender.com answers in 0.1s, and the payments primary
//   (-x9xq) answers correctly when called directly.
//
//   Verified 2026-07-30, every fallback host is suspended:
//     sivan-escrow-agent-test.onrender.com    503 x-render-routing: suspend
//     sivan-payments-api-test.onrender.com    503 x-render-routing: suspend
//     sivan-whatsapp-bot-test.onrender.com    503 x-render-routing: suspend
//   while every primary returns 200. A fallback that can never succeed is not
//   resilience, it is a guaranteed delay before failing, so all of them are
//   removed rather than repointed.
//
// Also fixed from the previous file:
//   - 4 syntax errors of the form  console.log`...`)  and  fetch`...`, {
//     The file as-shared does not parse; wrangler would reject it. Checked
//     here with `node --check` before shipping.
//   - Retries on non-idempotent methods, which can duplicate a write
//   - CORS "*" fallback, which is invalid alongside Allow-Credentials
// ========================================================

// ---------------------------------------------------------------- upstreams
const TEST_ESCROW   = "https://sivan-escrow-agent-test-gb84.onrender.com";
const TEST_PAYMENTS = "https://sivan-payments-api-test-x9xq.onrender.com";
const TEST_AUTH     = "https://telegram-admin-auth-z3e8.onrender.com";
const TEST_BOT      = "https://sivan-whatsapp-bot-test-du5x.onrender.com";
const TEST_SIVAN_AI = "https://sivan-ai.onrender.com";

// Only these origins may send credentialed requests. This list is the only
// thing standing between a hostile page and an authenticated request to the
// payment API using a logged-in user's own browser. Add specific product
// prefixes, never a bare *.vercel.app.
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

const DEFAULT_ALLOWED_HEADERS =
  "Content-Type, Authorization, x-admin-api-key, x-admin-key, x-sivan-request-id, " +
  "x-sivan-target-service, x-sivan-admin-email, x-sivan-admin-role, x-sivan-admin-module, " +
  "x-sivan-admin-hub, x-sivan-ai-key, x-sivan-identity-link-secret, sentry-trace, baggage";

// Safe to repeat because repeating them changes nothing. Everything else can
// create or move money.
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
      request.headers.get("access-control-request-headers") || DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  // Only echo an origin we trust. An unknown origin gets no allow-origin
  // header at all, which the browser treats as a refusal.
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
      return withCorsHeaders(gatewayStatusResponse("test-sivan-gateway"), request);
    }

    if (url.pathname === "/health/deep") {
      return withCorsHeaders(
        await gatewayHealthResponse({
          service: "test-sivan-gateway",
          upstreams: {
            escrow: [TEST_ESCROW, "/api/health"],
            payment: [TEST_PAYMENTS, "/health"],
            auth: [TEST_AUTH, "/health"],
            bot: [TEST_BOT, "/api/health"],
            sivanAi: [TEST_SIVAN_AI, "/health"],
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
    // Let the origin set its own Host; forwarding the gateway Host breaks some
    // upstreams and defeats Render's routing.
    headers.delete("host");

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
  let host = TEST_ESCROW;
  let upstreamPath = url.pathname;
  let serviceName = "escrow-backend";

  if (url.pathname === "/webhooks/twilio-debugger") {
    host = TEST_ESCROW;
    upstreamPath = url.pathname;
    serviceName = "escrow-backend";
  } else if (
    targetService === "whatsapp-bot" ||
    url.pathname.startsWith("/webhooks/twilio") ||
    url.pathname === "/api/notify" ||
    url.pathname === "/api/whatsapp-provider"
  ) {
    host = TEST_BOT;
    upstreamPath = url.pathname;
    serviceName = "whatsapp-bot";
  } else if (
    url.pathname === "/api/webhooks/breet" ||
    url.pathname === "/api/webhooks/paj"
  ) {
    // NGN provider webhooks go STRAIGHT to the payments API, path unchanged.
    //
    // Must be evaluated before the /api/payment rules, and must NOT be
    // rewritten: Breet and PajRamp are configured with a literal URL in their
    // dashboards and will POST exactly that. Any prefix stripping here would
    // deliver to a path the API does not serve.
    //
    // Without this rule the request falls through to the escrow backend and
    // 404s. Breet treats a non-2xx as a failure and retries with backoff for
    // 24 hours, then marks the event permanently failed - so a missing route
    // does not look like an outage, it looks like silence.
    //
    // Header forwarding matters as much as the path. Breet authenticates with
    // a static x-webhook-secret header rather than a body signature, and the
    // payments API re-fetches the transaction from Breet before crediting
    // anything. Both depend on headers arriving unmodified, which they do -
    // only Host is stripped.
    host = TEST_PAYMENTS;
    upstreamPath = url.pathname;
    serviceName = "payments-api";
  } else if (
    targetService === "payments" ||
    url.pathname.startsWith("/api/admin/payment") ||
    url.pathname.startsWith("/api/payment")
  ) {
    // Evaluated BEFORE the escrow prefixes: "/api/admin/payment..." would
    // otherwise be captured by a broader rule.
    //
    //   /api/payment/api/users/{id}/ace/support -> /api/users/{id}/ace/support
    //   /api/payment/api/fees/offramp           -> /api/fees/offramp
    //   /api/admin/payment/health               -> /health
    host = TEST_PAYMENTS;
    upstreamPath =
      url.pathname.replace(/^\/api\/admin\/payment/, "").replace(/^\/api\/payment/, "") || "/";
    serviceName = "payments-api";
  } else if (
    url.pathname.startsWith("/api/admin/escrow") ||
    url.pathname.startsWith("/api/escrow")
  ) {
    host = TEST_ESCROW;
    upstreamPath =
      url.pathname.replace(/^\/api\/admin\/escrow/, "").replace(/^\/api\/escrow/, "") || "/";
    if (upstreamPath === "/health") upstreamPath = "/api/health";
    serviceName = "escrow-backend";
  } else if (
    targetService === "sivan-ai" ||
    url.pathname.startsWith("/api/sivan-ai") ||
    url.pathname.startsWith("/sivan-ai")
  ) {
    host = TEST_SIVAN_AI;
    upstreamPath =
      url.pathname.replace(/^\/api\/sivan-ai/, "").replace(/^\/sivan-ai/, "") || "/";
    serviceName = "sivan-ai";
  } else if (
    url.pathname.startsWith("/api/admin/auth-service") ||
    url.pathname.startsWith("/auth")
  ) {
    host = TEST_AUTH;
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
  // A write must be attempted exactly once. Retrying a POST that may already
  // have been applied upstream is how duplicate records get created.
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

      // A timeout on a write is ambiguous: the upstream may have applied it.
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
  // Free-tier services cold-start, so allow a little longer than a warm
  // health check would need, but not so long that /health/deep risks the
  // Worker wall-clock limit.
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
