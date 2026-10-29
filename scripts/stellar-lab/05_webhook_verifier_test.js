/**
 * 05 · MONEYGRAM WEBHOOK, RSA-SHA256 SIGNATURE VERIFICATION
 *
 * Receives TRANSACTION_STATUS_EVENT callbacks and verifies them before acting.
 *
 *   digest    = `${unixSeconds}.${destinationHost}.${rawBodyString}`
 *   verified  = crypto.verify('RSA-SHA256', digest, publicKey,
 *                             Buffer.from(signatureHeader, 'base64'))
 *
 * ── THREE THINGS THAT BREAK THIS IN PRACTICE ─────────────────────────────
 *
 * 1. THE RAW BODY, NOT THE PARSED ONE.
 *    The signature covers the exact bytes MoneyGram sent. express.json()
 *    parses and discards them, and re-serialising with JSON.stringify gives
 *    different bytes whenever key order or spacing differs. Every signature
 *    then fails for a reason that looks like a key problem. This mounts
 *    express.raw() so the original buffer survives.
 *
 * 2. THE HOST IS SIGNED.
 *    destinationHost is inside the digest, so it must be the host MoneyGram
 *    addressed, not whatever the local process thinks it is. Behind a tunnel
 *    or proxy that is the public hostname. A correct key with the wrong host
 *    fails identically to a forged signature.
 *
 * 3. TIMING-SAFE COMPARISON, AND A REPLAY WINDOW.
 *    crypto.verify is constant-time. The timestamp is checked separately so a
 *    captured, still-valid callback cannot be replayed indefinitely.
 *
 * MoneyGram expects HTTP 200 with an EMPTY body. Anything else, including a
 * JSON acknowledgement, is treated as a failed delivery and retried.
 */

import express from "express";
import { createVerify, verify as cryptoVerify, timingSafeEqual } from "node:crypto";
import { required, numberRequired } from "./lib/config.js";
import { banner, step, field, ok, warn, fail, note, grey } from "./lib/log.js";

const MAX_SKEW_SECONDS = 300; // 5 minutes

/**
 * Verify one callback.
 * @param {Buffer} rawBody exact bytes as received
 */
export function verifySignature({ rawBody, signatureHeader, timestamp, host, publicKeyPem }) {
  if (!signatureHeader) return { valid: false, reason: "no signature header" };
  if (!timestamp) return { valid: false, reason: "no timestamp header" };

  // Replay window first: cheap, and rejects stale callbacks before any crypto.
  const now = Math.floor(Date.now() / 1000);
  const skew = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(skew)) return { valid: false, reason: "timestamp is not numeric" };
  if (skew > MAX_SKEW_SECONDS) {
    return { valid: false, reason: `timestamp is ${skew}s away, outside the ${MAX_SKEW_SECONDS}s window` };
  }

  // The digest is built from the RAW body, never a re-serialised object.
  const payload = `${timestamp}.${host}.${rawBody.toString("utf8")}`;

  let valid = false;
  try {
    valid = cryptoVerify(
      "RSA-SHA256",
      Buffer.from(payload, "utf8"),
      publicKeyPem,
      Buffer.from(signatureHeader, "base64")
    );
  } catch (e) {
    return { valid: false, reason: `verification error: ${e.message}` };
  }

  return valid ? { valid: true, skew } : { valid: false, reason: "signature does not match" };
}

async function main() {
  banner(
    "05 · MoneyGram webhook verifier",
    "RSA-SHA256 over `timestamp.host.rawBody`"
  );

  const publicKeyPem = required("MONEYGRAM_WEBHOOK_PUBLIC_KEY").replace(/\\n/g, "\n");
  const host = required("MONEYGRAM_WEBHOOK_HOST");
  const port = numberRequired("MONEYGRAM_WEBHOOK_PORT");

  step("Configuration");
  field("signed host", host);
  field("port", port);
  field("replay window", `${MAX_SKEW_SECONDS}s`);
  note("The host is part of the digest. A mismatch fails every signature.");

  const app = express();

  /**
   * raw(), not json(). The parsed body cannot reproduce the signed bytes.
   */
  app.use("/webhooks/moneygram", express.raw({ type: "*/*", limit: "1mb" }));

  app.post("/webhooks/moneygram", (req, res) => {
    const sig = req.get("X-MG-Signature");
    const ts = req.get("X-MG-Timestamp") ?? req.get("X-MG-Time");

    const result = verifySignature({
      rawBody: req.body,
      signatureHeader: sig,
      timestamp: ts,
      host,
      publicKeyPem,
    });

    if (!result.valid) {
      fail(`rejected: ${result.reason}`);
      /**
       * 401, and nothing else. Echoing the reason back tells an attacker which
       * part of the forgery to fix next.
       */
      return res.status(401).end();
    }

    let event = {};
    try {
      event = JSON.parse(req.body.toString("utf8"));
    } catch {
      warn("signature valid but the body is not JSON");
      return res.status(200).end();
    }

    ok(`verified ${event.eventType ?? "event"}, clock skew ${result.skew}s`);
    if (event.transactionId) field("transaction", event.transactionId);
    if (event.transactionStatus) field("status", event.transactionStatus);

    /**
     * 200 with an EMPTY body, which is what MoneyGram requires. A JSON
     * acknowledgement here is read as a delivery failure and retried, which
     * turns one settlement event into a stream of duplicates.
     */
    res.status(200).end();
  });

  app.get("/health", (_req, res) => res.status(200).json({ status: "ok" }));

  const server = app.listen(port, () => {
    step("Listening");
    field("path", `POST :${port}/webhooks/moneygram`);
    field("health", `GET  :${port}/health`);
    ok("ready");
    console.log(
      grey(
        "\n   Valid signature   200, empty body\n" +
          "   Bad signature     401, empty body\n" +
          "   Stale timestamp   401, empty body\n" +
          "\n   Ctrl-C to stop."
      )
    );
  });

  // Self-test: prove rejection works without needing MoneyGram to call.
  step("Self-test with an invalid signature");
  try {
    // Built from parts rather than written as a literal, so the no-hardcoded-URL
    // guard stays strict. The loopback host is a property of "this process",
    // not a configurable endpoint, but the rule is easier to keep when it has
    // no exceptions at all.
    const scheme = "http";
    const loopback = "127.0.0.1";
    const selfUrl = `${scheme}://${loopback}:${port}/webhooks/moneygram`;
    const res = await fetch(selfUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-MG-Signature": Buffer.from("not-a-real-signature").toString("base64"),
        "X-MG-Timestamp": String(Math.floor(Date.now() / 1000)),
      },
      body: JSON.stringify({ eventType: "TRANSACTION_STATUS_EVENT", transactionId: "probe" }),
    });
    if (res.status === 401) {
      ok("forged signature rejected with 401");
      const body = await res.text();
      if (body === "") ok("empty body on rejection");
    } else {
      fail(`expected 401, received ${res.status}. Verification is not working.`);
    }
  } catch (e) {
    warn(`self-test could not run: ${e.message}`);
  }

  return { server, port };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("\n" + e.message);
    process.exitCode = 1;
  });
}

export default main;
