// ========================================================
// SIVAN TEST GATEWAY — Cloudflare Worker
// Corrected 2026-07-28
//
// Fixes applied vs the version you shared:
//   1. 10x SyntaxError: console.log`...`)  ->  console.log(`...`)
//      (the file as-shared does not parse; `wrangler deploy` rejects it)
//   2. fetch`${host}${path}`, {...}  ->  fetch(`${host}${path}`, {...})
//   3. /health/deep reported healthy upstreams as "degraded"
//   4. Fallback responses were double-wrapped in CORS headers
//   5. CORS: "*" origin is invalid with Allow-Credentials: true
//   6. Cold-start retry made clients wait up to ~65s; now bounded
//   7. Retries on non-idempotent methods could double-submit
//   8. /health/deep checked upstreams serially-ish and took 22s; now bounded
// ========================================================

// ========================================================
// PRIMARY TEST SERVICES (Render)
// ========================================================
const TEST_ESCROW_PRIMARY   = "https://sivan-escrow-agent-test-gb84.onrender.com";
const TEST_PAYMENTS_PRIMARY = "https://sivan-payments-api-test-x9xq.onrender.com";
const TEST_AUTH_PRIMARY     = "https://telegram-admin-auth-z3e8.onrender.com";
const TEST_BOT_PRIMARY      = "https://sivan-whatsapp-bot-test-du5x.onrender.com";
const TEST_SIVAN_AI_PRIMARY = "https://sivan-ai.onrender.com";

// ========================================================
// SECONDARY TEST FALLBACKS
// ========================================================
const TEST_ESCROW_FALLBACK   = "https://sivan-escrow-agent-test.onrender.com";
const TEST_PAYMENTS_FALLBACK = "https://sivan-payments-api-test.onrender.com";
const TEST_AUTH_FALLBACK     = "https://telegram-admin-auth-test.onrender.com";
const TEST_BOT_FALLBACK      = "https://sivan-whatsapp-bot-test.onrender.com";
const TEST_SIVAN_AI_FALLBACK = "https://sivan-ai.onrender.com";

// Origins allowed to send credentialed requests.
// NOTE: reflecting an arbitrary Origin while sending
// Access-Control-Allow-Credentials: true is unsafe, and the literal "*"
// is rejected by browsers in credentialed mode.
// Any Sivan-owned Vercel deployment. The `-[a-z0-9]+` tail also matches
// Vercel preview URLs (e.g. sivan-payments-user-test-abc123.vercel.app),
// which would otherwise be blocked on every preview deploy.
//
// NOTE: this list is the only thing standing between a hostile page and a
// credentialed request to the payment API. Add specific product prefixes,
// never a bare `*.vercel.app`.
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
  "x-sivan-admin-hub, sentry-trace, baggage";

function isAllowedOrigin(origin) {
  if (!origin) return false;
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

function getCorsHeaders(request) {
  const origin = request.headers.get("origin");
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
    "Access-Control-Allow-Headers":
      request.headers.get("access-control-request-headers") || DEFAULT_ALLOWED_HEADERS,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };

  if (isAllowedOrigin(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Credentials"] = "true";
  } else if (!origin) {
    // Non-browser / same-origin caller: no credentials implied.
    headers["Access-Control-Allow-Origin"] = "*";
  }
  // Disallowed origin: emit no Allow-Origin so the browser blocks it.

  return headers;
}

function handleCorsPreflight(request) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: getCorsHeaders(request) });
  }
  return null;
}

function withCorsHeaders(response, request) {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(getCorsHeaders(request))) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

export default {
  async fetch(request, env, ctx) {
    const corsPreflight = handleCorsPreflight(request);
    if (corsPreflight) return corsPreflight;

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
      const res = await gatewayHealthResponse({
        service: "test-sivan-gateway",
        upstreams: {
          escrow:  [TEST_ESCROW_PRIMARY,   TEST_ESCROW_FALLBACK,   "/api/health"],
          payment: [TEST_PAYMENTS_PRIMARY, TEST_PAYMENTS_FALLBACK, "/health"],
          auth:    [TEST_AUTH_PRIMARY,     TEST_AUTH_FALLBACK,     "/api/health"],
          bot:     [TEST_BOT_PRIMARY,      TEST_BOT_FALLBACK,      "/api/health"],
          sivanAi: [TEST_SIVAN_AI_PRIMARY, TEST_SIVAN_AI_FALLBACK, "/health"],
        },
      });
      return withCorsHeaders(res, request);
    }

    let primaryHost = TEST_ESCROW_PRIMARY;
    let fallbackHost = TEST_ESCROW_FALLBACK;
    let upstreamPath = url.pathname;
    let serviceName = "escrow-backend";

    const targetService = request.headers.get("x-sivan-target-service");

    if (url.pathname === "/webhooks/twilio-debugger") {
      primaryHost = TEST_ESCROW_PRIMARY;
      fallbackHost = TEST_ESCROW_FALLBACK;
      upstreamPath = url.pathname;
      serviceName = "escrow-backend";
    } else if (
      targetService === "whatsapp-bot" ||
      url.pathname.startsWith("/webhooks/twilio") ||
      url.pathname === "/api/notify" ||
      url.pathname === "/api/whatsapp-provider"
    ) {
      primaryHost = TEST_BOT_PRIMARY;
      fallbackHost = TEST_BOT_FALLBACK;
      upstreamPath = url.pathname;
      serviceName = "whatsapp-bot";
    } else if (
      targetService === "payments" ||
      url.pathname.startsWith("/api/admin/payment") ||
      url.pathname.startsWith("/api/payment")
    ) {
      // NOTE: payments is evaluated BEFORE the escrow prefix match, because
      // "/api/admin/payment..." would otherwise be captured by a broader rule.
      primaryHost = TEST_PAYMENTS_PRIMARY;
      fallbackHost = TEST_PAYMENTS_FALLBACK;
      upstreamPath =
        url.pathname.replace(/^\/api\/admin\/payment/, "").replace(/^\/api\/payment/, "") || "/";
      serviceName = "payments-api";
    } else if (
      url.pathname.startsWith("/api/admin/escrow") ||
      url.pathname.startsWith("/api/escrow")
    ) {
      primaryHost = TEST_ESCROW_PRIMARY;
      fallbackHost = TEST_ESCROW_FALLBACK;
      if (url.pathname.startsWith("/api/admin/escrow")) {
        upstreamPath = url.pathname.replace(/^\/api\/admin\/escrow/, "/api/admin");
      } else if (url.pathname.startsWith("/api/escrow/")) {
        upstreamPath = url.pathname.replace(/^\/api\/escrow\//, "/api/escrows/");
      } else if (url.pathname === "/api/escrow") {
        upstreamPath = "/api/escrows";
      } else {
        upstreamPath = url.pathname;
      }
      if (upstreamPath === "/health") upstreamPath = "/api/health";
      serviceName = "escrow-backend";
    } else if (
      targetService === "sivan-ai" ||
      url.pathname.startsWith("/api/sivan-ai") ||
      url.pathname.startsWith("/sivan-ai")
    ) {
      primaryHost = TEST_SIVAN_AI_PRIMARY;
      fallbackHost = TEST_SIVAN_AI_FALLBACK;
      upstreamPath =
        url.pathname.replace(/^\/api\/sivan-ai/, "").replace(/^\/sivan-ai/, "") || "/";
      serviceName = "sivan-ai";
    } else if (
      url.pathname.startsWith("/api/admin/auth-service") ||
      url.pathname.startsWith("/auth")
    ) {
      primaryHost = TEST_AUTH_PRIMARY;
      fallbackHost = TEST_AUTH_FALLBACK;
      upstreamPath = url.pathname.replace(/^\/api\/admin\/auth-service/, "") || "/";
      if (upstreamPath === "/health") upstreamPath = "/api/health";
      serviceName = "telegram-auth";
    }

    const requestId =
      request.headers.get("x-sivan-request-id") || `siv-req-${crypto.randomUUID()}`;

    const headers = new Headers(request.headers);
    headers.set("x-sivan-request-id", requestId);
    // Let the origin set its own Host; forwarding the gateway Host breaks
    // some upstreams and defeats Render's routing.
    headers.delete("host");

    let requestBody = null;
    if (!["GET", "HEAD"].includes(request.method)) {
      requestBody = await request.arrayBuffer();
    }

    const targetUrl = `${primaryHost}${upstreamPath}${url.search}`;
    console.log(
      `[${requestId}] [${serviceName}] Incoming: ${request.method} ${url.pathname} -> ${targetUrl}`
    );

    const response = await fetchPrimaryWithRetry(
      targetUrl, request, headers, requestBody, requestId,
      serviceName, primaryHost, fallbackHost, url, upstreamPath
    );
    return withCorsHeaders(response, request);
  },
};

// Retrying a POST/PUT/PATCH/DELETE that may already have been applied upstream
// risks duplicate writes (double payouts, duplicate escrows). Only retry reads,
// unless the upstream explicitly told us it was suspended/cold.
function isIdempotent(method) {
  return ["GET", "HEAD", "OPTIONS"].includes(method);
}

async function fetchPrimaryWithRetry(
  targetUrl, request, headers, requestBody, requestId,
  serviceName, primaryHost, fallbackHost, url, upstreamPath
) {
  const MAX_PRIMARY_ATTEMPTS = 3;
  const RETRY_DELAY_MS = 1200;   // was 2500 — 3 attempts x (20s + 2.5s) could exceed 65s
  const UPSTREAM_TIMEOUT_MS = 12000; // was 20000

  for (let attempt = 1; attempt <= MAX_PRIMARY_ATTEMPTS; attempt++) {
    console.log(
      `[${requestId}] [${serviceName}] Primary attempt ${attempt}/${MAX_PRIMARY_ATTEMPTS}: ${request.method} ${targetUrl}`
    );
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    try {
      const response = await fetch(targetUrl, {
        method: request.method,
        headers,
        body: requestBody,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const renderRouting = response.headers.get("x-render-routing") || "";
      const isSuspended =
        renderRouting === "suspend" || [502, 503, 504].includes(response.status);

      if (!isSuspended) {
        console.log(
          `[${requestId}] [${serviceName}] PRIMARY ok (status ${response.status}) attempt ${attempt}`
        );
        return response;
      }

      console.warn(
        `[${requestId}] [${serviceName}] Primary ${primaryHost} cold/suspended (status ${response.status}, render: ${renderRouting || "none"}) attempt ${attempt}/${MAX_PRIMARY_ATTEMPTS}`
      );

      // A suspended/cold upstream did NOT execute the request, so retrying a
      // write here is safe.
      if (attempt < MAX_PRIMARY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    } catch (err) {
      clearTimeout(timeoutId);
      console.warn(
        `[${requestId}] [${serviceName}] Primary ${primaryHost} attempt ${attempt}/${MAX_PRIMARY_ATTEMPTS} failed: ${err.message}`
      );

      // A timeout/abort on a write is ambiguous — the upstream may have
      // applied it. Do not retry; fail over once and let the client decide.
      if (!isIdempotent(request.method)) {
        console.warn(
          `[${requestId}] [${serviceName}] Non-idempotent ${request.method} — skipping retries to avoid duplicate writes`
        );
        break;
      }

      if (attempt < MAX_PRIMARY_ATTEMPTS) {
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
    }
  }

  console.warn(
    `[${requestId}] [${serviceName}] Primary ${primaryHost} exhausted. Routing to FALLBACK.`
  );
  return await fetchFallback(
    request, url, fallbackHost, upstreamPath, requestBody, headers, requestId, serviceName
  );
}

async function fetchFallback(
  request, url, fallbackHost, upstreamPath, requestBody, headers, requestId, serviceName
) {
  const fallbackUrl = `${fallbackHost}${upstreamPath}${url.search}`;
  console.log(`[${requestId}] [${serviceName}] FALLBACK: ${request.method} ${fallbackUrl}`);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12000);

  try {
    const response = await fetch(fallbackUrl, {
      method: request.method,
      headers,
      body: requestBody,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    console.log(`[${requestId}] [${serviceName}] FALLBACK status ${response.status}`);
    // Return bare — the caller applies CORS once. Wrapping here too produced
    // duplicated header handling on the fallback path only.
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`[${requestId}] [${serviceName}] FALLBACK failed: ${err.message}`);
    return new Response(
      JSON.stringify({
        error: "ALL_UPSTREAMS_UNAVAILABLE",
        message: `Primary backend ${serviceName} is waking up or suspended, and fallback is unreachable. Try again in 10 seconds.`,
        service: serviceName,
        requestId,
      }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }
}

async function gatewayHealthResponse(config) {
  const entries = await Promise.all(
    Object.entries(config.upstreams).map(async ([name, [primary, fallback, path]]) => {
      const primaryResult = await checkUpstream(primary, path);
      if (primaryResult.ok) return [name, "ok"];

      const fallbackResult = await checkUpstream(fallback, path);
      // Previously any primary miss reported "degraded" even when the primary
      // was actually healthy but slow, and a healthy fallback still surfaced a
      // confusing status. Be explicit about which tier is serving.
      if (fallbackResult.ok) return [name, "fallback"];
      return [name, "down"];
    })
  );

  const upstreams = Object.fromEntries(entries);
  const values = Object.values(upstreams);
  const anyDown = values.includes("down");
  const anyFallback = values.includes("fallback");

  return new Response(
    JSON.stringify({
      status: anyDown ? "degraded" : anyFallback ? "fallback" : "ok",
      service: config.service,
      upstreams,
      checkedAt: new Date().toISOString(),
    }),
    {
      // Only 503 when something is genuinely unreachable. Serving from a
      // healthy fallback is not an outage.
      status: anyDown ? 503 : 200,
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
  // 15s x 5 upstreams x 2 tiers made /health/deep take ~22s and risk the
  // Worker CPU/wall limit. 6s is plenty for a health endpoint.
  const timeoutId = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${host}${path}`, {
      method: "GET",
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });
    clearTimeout(timeoutId);
    return { ok: response.ok, status: response.status };
  } catch (_err) {
    clearTimeout(timeoutId);
    return { ok: false, status: 0 };
  }
}
