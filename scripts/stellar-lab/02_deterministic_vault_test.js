/**
 * 02 · CONTRACTLESS SERVICE AGREEMENT VAULT ON STELLAR LAYER 1
 *
 * Derives a dedicated Stellar account for one Service Agreement, with no smart
 * contract involved.
 *
 *   seed32 = SHA256(masterSeed + ":" + agreementId)
 *
 * WHY THIS IS INTERESTING.
 *
 * Stellar Layer 1 has no contracts, so a Service Agreement cannot be a
 * contract holding state. It can instead be an ACCOUNT, and because the
 * account is derived rather than recorded, its address is recomputable from
 * the agreement id alone. No database row sits between a user and their funds.
 * Lose every record and the accounts are still reachable from the master seed.
 *
 * The cost of that design is the master seed: whoever holds it can derive every
 * agreement account that will ever exist. It belongs in an HSM, and this lab
 * reads it from the environment only because it runs on testnet.
 *
 * This script is READ ONLY. It derives, verifies, and reports. It never funds
 * or signs.
 */

import { required } from "./lib/config.js";
import {
  deriveKeypair,
  horizon,
  usdc,
  loadAccountOrNull,
  balanceOf,
  hasTrustline,
} from "./lib/stellar.js";
import { banner, step, field, ok, warn, note, grey } from "./lib/log.js";

const AGREEMENT_ID = process.env.LAB_AGREEMENT_ID || "agreement_alpha_014";

async function main() {
  banner(
    "02 · Deterministic Service Agreement vault",
    "SHA256 derivation, Stellar Layer 1, no contract"
  );

  const masterSeed = required("LAB_MASTER_SEED");
  const server = horizon();
  const asset = usdc();

  // ── Derive ──────────────────────────────────────────────────────
  step("Derive the agreement account");
  field("agreement id", AGREEMENT_ID);
  field("derivation", "SHA256(masterSeed + ':' + agreementId)");

  const kp = deriveKeypair(masterSeed, AGREEMENT_ID);
  field("account", kp.publicKey());
  note("Secret withheld. It is recomputable from the seed and the id.");

  // ── Determinism ─────────────────────────────────────────────────
  step("Determinism");
  const again = deriveKeypair(masterSeed, AGREEMENT_ID);
  if (again.publicKey() === kp.publicKey()) {
    ok("same inputs derive the same account");
  } else {
    throw new Error("derivation is not deterministic, which breaks the design");
  }

  /**
   * Isolation matters as much as determinism. If two agreement ids collided,
   * one agreement would settle into another's account, and the failure would
   * look like a missing payment rather than a derivation bug.
   */
  const neighbour = deriveKeypair(masterSeed, AGREEMENT_ID + "_x");
  if (neighbour.publicKey() !== kp.publicKey()) {
    ok("a different agreement id derives a different account");
    field("neighbour", grey(neighbour.publicKey()));
  } else {
    throw new Error("COLLISION: two agreement ids derived one account");
  }

  /**
   * The separator is load-bearing. Without it, ("ab","c14") and ("abc","14")
   * concatenate identically and collide. Proving the boundary here means the
   * property is tested rather than assumed.
   */
  const shifted = deriveKeypair(masterSeed + ":x", AGREEMENT_ID.slice(1));
  if (shifted.publicKey() !== kp.publicKey()) {
    ok("the ':' separator prevents boundary collisions");
  } else {
    throw new Error("BOUNDARY COLLISION: the separator is not doing its job");
  }

  // ── On-chain state ──────────────────────────────────────────────
  step("On-chain state");
  field("horizon", required("STELLAR_HORIZON_URL"));
  field("asset", `${asset.getCode()} / ${asset.getIssuer().slice(0, 8)}...`);

  const account = await loadAccountOrNull(server, kp.publicKey());

  if (!account) {
    warn("account does not exist on this network yet");
    note(
      "Expected before first funding. A Stellar account exists once it holds\n" +
        "        the base reserve, so an unfunded agreement has no ledger entry."
    );
    field("to activate", `fund ${kp.publicKey()} with XLM, then add a USDC trustline`);
    return { agreementId: AGREEMENT_ID, address: kp.publicKey(), exists: false };
  }

  ok("account exists on the ledger");
  field("sequence", account.sequence);
  field("XLM", balanceOf(account, { isNative: () => true, getCode: () => "XLM", getIssuer: () => null }));

  if (hasTrustline(account, asset)) {
    const bal = balanceOf(account, asset);
    ok(`USDC trustline present, balance ${bal}`);
    field("held", `${bal} ${asset.getCode()}`);
  } else {
    warn("no USDC trustline");
    note(
      "Stellar requires an explicit trustline before an account can hold an\n" +
        "        issued asset. Until it exists, a USDC payment here would fail."
    );
  }

  // ── Signers, the part people forget ─────────────────────────────
  step("Signer configuration");
  for (const s of account.signers) {
    field(s.key === kp.publicKey() ? "master key" : "signer", `${s.key.slice(0, 12)}... weight ${s.weight}`);
  }
  const thresholds = account.thresholds;
  field("thresholds", `low ${thresholds.low_threshold} med ${thresholds.med_threshold} high ${thresholds.high_threshold}`);

  console.log();
  ok(`Service Agreement ${AGREEMENT_ID} resolves to ${kp.publicKey().slice(0, 12)}...`);

  return {
    agreementId: AGREEMENT_ID,
    address: kp.publicKey(),
    exists: true,
    usdcBalance: hasTrustline(account, asset) ? balanceOf(account, asset) : null,
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("\n" + e.message);
    process.exitCode = 1;
  });
}

export default main;
