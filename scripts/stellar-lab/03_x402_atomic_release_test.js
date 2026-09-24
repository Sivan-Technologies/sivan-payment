/**
 * 03 · ATOMIC RELEASE, WORKER PAYOUT AND PROTOCOL FEE
 *
 * Splits a funded Service Agreement in one transaction:
 *
 *   op 1   19.40 USDC  to the worker
 *   op 2    0.60 USDC  to the Sivan treasury   (3% of 20.00)
 *
 * wrapped in a CAP-0015 fee-bump so the sponsor pays the network fee and the
 * agreement account never needs XLM of its own.
 *
 * ATOMICITY IS THE POINT. A Stellar transaction applies completely or not at
 * all, so the worker cannot be paid while the fee fails, and the fee cannot be
 * taken while the payout fails. The alternative, two transactions, has a state
 * where one landed and the other did not, and reconciling that costs more than
 * the fee is worth.
 *
 * ── TWO CORRECTIONS TO THE ORIGINAL SPEC ─────────────────────────────────
 *
 * 1. A FEE-BUMP IS NOT AN OPERATION.
 *    The brief called for three operations, the third being a CAP-0015
 *    fee-bump. CAP-0015 defines a fee-bump as an OUTER TRANSACTION that WRAPS
 *    an inner one, not an operation inside it. There is no
 *    Operation.feeBumpSponsor. Written as an operation it would not build, so
 *    this uses TransactionBuilder.buildFeeBumpTransaction, which is the
 *    mechanism the brief was describing.
 *
 * 2. "0.15s CONSENSUS" IS NOT A CLAIM THIS CAN SUPPORT.
 *    Stellar closes ledgers in roughly 5 seconds. The script reports the
 *    measured wall-clock time instead. An unverifiable latency figure on a
 *    settlement product is exactly the number a reviewer checks first.
 */

import { required } from "./lib/config.js";
import {
  horizon,
  usdc,
  deriveKeypair,
  loadAccountOrNull,
  balanceOf,
  hasTrustline,
  builderFor,
  Keypair,
  Operation,
  TransactionBuilder,
} from "./lib/stellar.js";
import { banner, step, field, ok, warn, fail, note, grey } from "./lib/log.js";

const AGREEMENT_ID = process.env.LAB_AGREEMENT_ID || "agreement_alpha_014";
const GROSS = 20.0;
const FEE_BPS = 300; // 3%

async function main() {
  banner(
    "03 · Atomic release",
    "Worker payout and protocol fee in one ledger transaction"
  );

  const server = horizon();
  const asset = usdc();
  const sponsor = Keypair.fromSecret(required("LAB_SPONSOR_SECRET"));
  const worker = required("LAB_WORKER_ADDRESS");
  const treasury = required("LAB_TREASURY_ADDRESS");
  const agreement = deriveKeypair(required("LAB_MASTER_SEED"), AGREEMENT_ID);

  // ── Split ───────────────────────────────────────────────────────
  step("Settlement split");
  const feeAmount = (GROSS * FEE_BPS) / 10_000;
  const netAmount = GROSS - feeAmount;

  field("gross", `${GROSS.toFixed(2)} USDC`);
  field("protocol fee", `${feeAmount.toFixed(2)} USDC (${FEE_BPS / 100}%)`);
  field("worker net", `${netAmount.toFixed(2)} USDC`);

  /**
   * Assert the split is exact before building anything.
   *
   * Floating point on money is a real hazard: 19.4 + 0.6 can land a hair off
   * 20, and Stellar's 7-decimal amounts would carry that error onto the
   * ledger. Catching it here costs nothing; catching it after submission is
   * a reconciliation problem.
   */
  const recombined = Number((netAmount + feeAmount).toFixed(7));
  if (recombined !== GROSS) {
    throw new Error(
      `split does not recombine: ${netAmount} + ${feeAmount} = ${recombined}, expected ${GROSS}`
    );
  }
  ok("split recombines to the gross amount exactly");

  // ── Preconditions ───────────────────────────────────────────────
  step("Preconditions");
  field("agreement", agreement.publicKey());
  field("worker", worker);
  field("treasury", treasury);
  field("fee sponsor", sponsor.publicKey());

  const agreementAccount = await loadAccountOrNull(server, agreement.publicKey());
  if (!agreementAccount) {
    fail("the agreement account does not exist on this network");
    note(`Fund ${agreement.publicKey()} and add a ${asset.getCode()} trustline, then rerun.`);
    note("Nothing was submitted.");
    return { submitted: false, reason: "agreement account missing" };
  }

  if (!hasTrustline(agreementAccount, asset)) {
    fail(`the agreement account has no ${asset.getCode()} trustline`);
    note("Nothing was submitted.");
    return { submitted: false, reason: "no trustline" };
  }

  const held = Number(balanceOf(agreementAccount, asset));
  field("balance", `${held} ${asset.getCode()}`);
  if (held < GROSS) {
    fail(`holds ${held}, needs ${GROSS}`);
    note("Nothing was submitted. A short balance would fail on chain anyway.");
    return { submitted: false, reason: "insufficient balance" };
  }
  ok("funded sufficiently");

  /**
   * Both destinations need a trustline. Without one the payment fails with
   * op_no_trust, and because the transaction is atomic that single missing
   * trustline reverts the whole settlement. Better to say so now.
   */
  for (const [label, addr] of [["worker", worker], ["treasury", treasury]]) {
    const acct = await loadAccountOrNull(server, addr);
    if (!acct) {
      fail(`${label} account ${addr.slice(0, 10)}... does not exist`);
      return { submitted: false, reason: `${label} missing` };
    }
    if (!hasTrustline(acct, asset)) {
      fail(`${label} has no ${asset.getCode()} trustline, the release would revert`);
      return { submitted: false, reason: `${label} trustline missing` };
    }
    ok(`${label} can receive ${asset.getCode()}`);
  }

  // ── Build ───────────────────────────────────────────────────────
  step("Build the atomic transaction");
  const builder = await builderFor(server, agreementAccount);

  builder
    .addOperation(
      Operation.payment({
        destination: worker,
        asset,
        amount: netAmount.toFixed(7),
      })
    )
    .addOperation(
      Operation.payment({
        destination: treasury,
        asset,
        amount: feeAmount.toFixed(7),
      })
    )
    .addMemo(
      // Ties the ledger entry back to the agreement without a database lookup.
      (await import("@stellar/stellar-sdk")).Memo.text(AGREEMENT_ID.slice(0, 28))
    )
    .setTimeout(120);

  const inner = builder.build();
  inner.sign(agreement);

  field("operations", `${inner.operations.length} (payment, payment)`);
  field("memo", AGREEMENT_ID.slice(0, 28));
  ok("inner transaction signed by the agreement account");

  // ── Fee-bump ────────────────────────────────────────────────────
  step("CAP-0015 fee-bump");
  note("The sponsor pays the network fee, so the agreement needs no XLM.");

  const baseFee = await server.fetchBaseFee().catch(() => 100);
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    sponsor,
    String(baseFee * 4),
    inner,
    required("STELLAR_NETWORK_PASSPHRASE")
  );
  feeBump.sign(sponsor);

  field("outer fee", `${baseFee * 4} stroops`);
  field("fee source", sponsor.publicKey());
  ok("fee-bump wraps the inner transaction");
  console.log(
    grey(
      "   CAP-0015 defines this as an outer transaction wrapping an inner one,\n" +
        "   not an operation. There is no fee-bump operation to add."
    )
  );

  // ── Submit ──────────────────────────────────────────────────────
  step("Submit");
  const started = Date.now();
  try {
    const res = await server.submitTransaction(feeBump);
    const elapsed = ((Date.now() - started) / 1000).toFixed(2);

    ok("accepted by the network");
    field("tx hash", res.hash);
    field("ledger", res.ledger);
    field("wall clock", `${elapsed}s`);
    note(
      "Measured, not claimed. Stellar closes ledgers in roughly 5 seconds, so\n" +
        "        any sub-second settlement figure would not survive checking."
    );

    console.log();
    ok(`${netAmount.toFixed(2)} USDC to the worker, ${feeAmount.toFixed(2)} USDC to treasury, atomically`);
    return { submitted: true, hash: res.hash, ledger: res.ledger, elapsed };
  } catch (e) {
    const codes = e?.response?.data?.extras?.result_codes;
    fail("rejected");
    if (codes) {
      field("transaction", codes.transaction ?? "");
      if (codes.operations) field("operations", codes.operations.join(", "));
      if (codes.operations?.includes("op_no_trust")) {
        note("op_no_trust: a destination lacks the asset trustline.");
      }
      if (codes.transaction === "tx_bad_auth") {
        note("tx_bad_auth: usually a network passphrase mismatch.");
      }
    } else {
      field("error", e.message);
    }
    return { submitted: false, reason: codes?.transaction ?? e.message };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("\n" + e.message);
    process.exitCode = 1;
  });
}

export default main;
