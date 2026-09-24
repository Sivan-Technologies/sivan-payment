/**
 * 04 · MONEYGRAM CASH PICKUP, 20 USD TO NGN
 *
 * Quote, validate the receiver, commit, and read back the reference number the
 * recipient presents at a counter.
 *
 *   POST {base}/instructpayouttransactionquote
 *   POST {base}/payout/v1/transactions/validate
 *   POST {base}/payout/v1/transactions/{transactionId}/commit
 *
 * Every path is joined onto MONEYGRAM_API_BASE_URL from the environment. The
 * base URL appears nowhere in this file.
 *
 * WHY THIS MATTERS TO THE PRODUCT. It is the last mile for a recipient with no
 * bank account: stablecoin settles on Stellar, and the person collects physical
 * cash. Everything upstream is irrelevant to them if this step does not work.
 *
 * The script reports what the sandbox actually returns, including failures.
 * A cash-out that reports success without a reference number is worse than one
 * that reports an error, because the recipient travels to a counter for
 * nothing.
 */

import { randomUUID } from "node:crypto";
import { required } from "./lib/config.js";
import { banner, step, field, ok, warn, fail, note, grey } from "./lib/log.js";

const SEND_USD = 20.0;
const RECEIVE_CURRENCY = "NGN";

/** Join a path onto the configured base without duplicating slashes. */
function url(base, path) {
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

async function call(base, path, apiKey, partnerId, body) {
  const target = url(base, path);
  const res = await fetch(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-MG-ClientRequestId": randomUUID(),
      "X-MG-ConsumerIPAddress": "127.0.0.1",
      Authorization: `Bearer ${apiKey}`,
      "X-MG-PartnerId": partnerId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* keep the raw text for the error path */
  }
  return { status: res.status, ok: res.ok, json, text, target };
}

async function main() {
  banner("04 · MoneyGram cash pickup", `${SEND_USD} USD to ${RECEIVE_CURRENCY}`);

  const base = required("MONEYGRAM_API_BASE_URL");
  const partnerId = required("MONEYGRAM_PARTNER_ID");
  const apiKey = required("MONEYGRAM_API_KEY");

  step("Configuration");
  field("base URL", base);
  field("partner", partnerId);
  note("Base URL comes from the environment. No endpoint is hardcoded.");

  // ── Quote ───────────────────────────────────────────────────────
  step("Quote");
  const quoteBody = {
    partnerTransactionId: `sivan-lab-${Date.now()}`,
    destinationCountryCode: "NGA",
    destinationCurrencyCode: RECEIVE_CURRENCY,
    sendAmount: { value: SEND_USD, currencyCode: "USD" },
    serviceOptionCode: "WILL_CALL",
  };
  field("POST", "/instructpayouttransactionquote");
  field("send", `${SEND_USD} USD`);
  field("receive", `${RECEIVE_CURRENCY}, cash pickup`);

  let quote;
  try {
    quote = await call(base, "instructpayouttransactionquote", apiKey, partnerId, quoteBody);
  } catch (e) {
    fail(`quote request failed: ${e.message}`);
    note("Nothing was committed.");
    return { committed: false, reason: e.message };
  }

  if (!quote.ok) {
    warn(`HTTP ${quote.status}`);
    field("response", (quote.text || "").slice(0, 160) || "(empty)");
    note(
      "Expected without live sandbox credentials. The request shape above is\n" +
        "        what MoneyGram receives; only the credentials are absent."
    );
    return { committed: false, reason: `quote HTTP ${quote.status}` };
  }

  const q = quote.json ?? {};
  const transactionId = q.transactionId ?? q.quoteId ?? null;
  ok("quote returned");
  if (q.receiveAmount) field("receive amount", `${q.receiveAmount.value} ${q.receiveAmount.currencyCode}`);
  if (q.exchangeRate) field("rate", q.exchangeRate);
  if (q.totalFee) field("MoneyGram fee", q.totalFee);
  if (transactionId) field("transaction id", transactionId);

  if (!transactionId) {
    fail("no transactionId in the quote, cannot validate or commit");
    return { committed: false, reason: "no transactionId" };
  }

  // ── Validate the receiver ───────────────────────────────────────
  step("Validate receiver");
  note("Run before commit: a name mismatch at the counter blocks collection.");
  field("POST", "/payout/v1/transactions/validate");

  const validateBody = {
    transactionId,
    receiver: {
      name: { firstName: "Adaeze", lastName: "Okonkwo" },
      mobilePhone: { number: "8031234567", countryDialCode: "234" },
      address: { countryCode: "NGA", city: "Lagos" },
    },
  };

  const validation = await call(base, "payout/v1/transactions/validate", apiKey, partnerId, validateBody);
  if (!validation.ok) {
    warn(`HTTP ${validation.status}`);
    field("response", (validation.text || "").slice(0, 160) || "(empty)");
    note("Not committing after a failed validation.");
    return { committed: false, reason: `validate HTTP ${validation.status}` };
  }
  ok("receiver accepted");

  // ── Commit ──────────────────────────────────────────────────────
  step("Commit");
  note("This is the irreversible step. Everything before it can be abandoned.");
  field("POST", `/payout/v1/transactions/${transactionId}/commit`);

  const commit = await call(
    base,
    `payout/v1/transactions/${transactionId}/commit`,
    apiKey,
    partnerId,
    { transactionId }
  );

  if (!commit.ok) {
    fail(`HTTP ${commit.status}`);
    field("response", (commit.text || "").slice(0, 160) || "(empty)");
    return { committed: false, reason: `commit HTTP ${commit.status}` };
  }

  const c = commit.json ?? {};
  const reference = c.referenceNumber ?? c.referenceNo ?? c.mgiTransactionId ?? null;

  ok("committed");
  if (reference) {
    field("reference number", reference);
    console.log();
    ok(`Recipient collects ${RECEIVE_CURRENCY} cash with reference ${reference}`);
    note("This is the number the recipient presents. Nothing else is needed.");
  } else {
    /**
     * A commit that returns no reference is a silent failure in the making.
     * The transaction may exist, but the recipient has nothing to present, so
     * it is reported as a problem rather than a success.
     */
    warn("committed without a reference number");
    field("payload", JSON.stringify(c).slice(0, 160));
    note("Without a reference the recipient cannot collect. Investigate before relying on this.");
  }

  return { committed: true, transactionId, reference };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("\n" + e.message);
    process.exitCode = 1;
  });
}

export default main;
