/**
 * 01 · CIRCLE CCTP BURN AND MINT, SOURCE CHAIN TO STELLAR
 *
 * Exercises the shape of a CCTP transfer: burn on the source chain, wait for
 * Circle's attestation, mint on Stellar.
 *
 * WHAT IS REAL HERE AND WHAT IS NOT.
 *
 * The burn and the mint are SIMULATED. Performing them for real needs a funded
 * source-chain key and a live TokenMessenger, which is outside what a
 * self-contained lab should carry.
 *
 * The attestation poll is REAL when CCTP_ATTESTATION_API_URL is reachable: it
 * calls Circle's service with a message hash and reports exactly what comes
 * back, including a miss.
 *
 * Simulated values are printed with a [simulated] marker. A mock that looks
 * identical to a real result is how a demo starts asserting things that never
 * happened, so the distinction is visible in the output rather than buried in
 * a comment.
 */

import { createHash, randomBytes } from "node:crypto";
import { required, numberRequired } from "./lib/config.js";
import { banner, step, field, ok, warn, note, simulated, grey } from "./lib/log.js";

const AMOUNT_USDC = 25;

async function main() {
  banner(
    "01 · Circle CCTP bridge",
    "Burn on the source chain, attest, mint on Stellar"
  );

  const cfg = {
    sourceRpc: required("CCTP_SOURCE_RPC_URL"),
    sourceDomain: numberRequired("CCTP_SOURCE_DOMAIN"),
    destDomain: numberRequired("CCTP_DESTINATION_DOMAIN"),
    tokenMessenger: required("CCTP_TOKEN_MESSENGER_ADDRESS"),
    attestationApi: required("CCTP_ATTESTATION_API_URL"),
  };

  step("Configuration");
  field("source RPC", cfg.sourceRpc);
  field("source domain", cfg.sourceDomain);
  field("destination domain", cfg.destDomain);
  field("TokenMessenger", cfg.tokenMessenger);
  field("attestation API", cfg.attestationApi);

  // ── Is the source chain reachable? ──────────────────────────────
  step("Source chain reachability");
  let chainId = null;
  try {
    const res = await fetch(cfg.sourceRpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const j = await res.json();
    chainId = j?.result ? parseInt(j.result, 16) : null;
    if (chainId) ok(`reachable, chainId ${chainId}`);
    else warn(`responded without a chainId: ${JSON.stringify(j).slice(0, 80)}`);
  } catch (e) {
    warn(`unreachable: ${e.message}`);
    note("The burn below is simulated regardless, so the run continues.");
  }

  // ── Burn ────────────────────────────────────────────────────────
  step(`Burn ${AMOUNT_USDC} USDC on the source chain`);
  const nonce = BigInt("0x" + randomBytes(8).toString("hex"));
  const burnTxHash = "0x" + randomBytes(32).toString("hex");

  /**
   * The CCTP message commits to the route and the amount. Hashing the same
   * fields Circle hashes keeps the simulated value structurally honest: it is
   * the right shape and derived from the right inputs, even though no burn
   * occurred.
   */
  const messageBody = [
    cfg.sourceDomain,
    cfg.destDomain,
    nonce.toString(),
    cfg.tokenMessenger,
    AMOUNT_USDC * 1_000_000, // USDC is 6 decimals
  ].join(":");
  const messageHash = "0x" + createHash("sha256").update(messageBody).digest("hex");

  simulated("burn tx", burnTxHash);
  field("amount", `${AMOUNT_USDC} USDC (${AMOUNT_USDC * 1_000_000} base units)`);
  field("nonce", nonce.toString());
  field("message hash", messageHash);

  // ── Attestation ─────────────────────────────────────────────────
  step("Circle attestation");
  note("Circle observes the burn and signs a message the destination accepts.");

  const attestationUrl = `${cfg.attestationApi.replace(/\/$/, "")}/attestations/${messageHash}`;
  field("polling", attestationUrl);

  let attestation = null;
  try {
    const res = await fetch(attestationUrl, { signal: AbortSignal.timeout(10_000) });
    const body = await res.text();
    if (res.ok) {
      const j = JSON.parse(body);
      if (j.status === "complete" && j.attestation) {
        attestation = j.attestation;
        ok(`attested: ${attestation.slice(0, 26)}...`);
      } else {
        warn(`status "${j.status}", no signature yet`);
      }
    } else {
      /**
       * A 404 is the CORRECT answer here and not a failure of the lab. The
       * message hash is synthetic, so Circle has never seen the burn it refers
       * to. Reporting it plainly is more useful than dressing it up.
       */
      warn(`HTTP ${res.status}, expected for a synthetic message hash`);
      note("Circle has no record of a burn that did not happen.");
    }
  } catch (e) {
    warn(`attestation service unreachable: ${e.message}`);
  }

  if (!attestation) {
    attestation = "0x" + randomBytes(65).toString("hex");
    simulated("attestation", attestation.slice(0, 26) + "...");
  }

  // ── Mint ────────────────────────────────────────────────────────
  step("Mint on Stellar");
  const mintTxHash = createHash("sha256")
    .update(messageHash + attestation)
    .digest("hex");

  simulated("mint tx", mintTxHash);
  field("destination", `Stellar, domain ${cfg.destDomain}`);
  field("credited", `${AMOUNT_USDC} USDC`);

  console.log();
  ok(`CCTP route exercised: domain ${cfg.sourceDomain} to ${cfg.destDomain}`);
  console.log(
    grey(
      "   Burn, attestation and mint are simulated. Wiring a real burn needs a\n" +
        "   funded source-chain key, which this lab deliberately does not hold."
    )
  );

  return { burnTxHash, messageHash, attestation, mintTxHash, amount: AMOUNT_USDC };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("\n" + e.message);
    process.exitCode = 1;
  });
}

export default main;
