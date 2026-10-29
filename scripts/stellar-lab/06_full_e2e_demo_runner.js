/**
 * 06 · END TO END DEMO RUNNER
 *
 * Runs the sequence in order for an unedited screen recording:
 *
 *   CCTP bridge  ->  derive agreement  ->  atomic release  ->  cash pickup
 *
 * DESIGNED TO BE WATCHED, NOT JUST RUN.
 *
 * Each stage prints what it is about to do before doing it, and reports what
 * actually happened rather than what was hoped. A stage that cannot run says so
 * and the sequence continues, because a demo that halts on the first missing
 * credential tells a viewer nothing about the rest.
 *
 * The summary at the end distinguishes three outcomes: what was verified on a
 * live network, what was simulated, and what was skipped. A recording where
 * every line is green tells a viewer nothing, since they cannot tell which
 * greens were real.
 */

import { banner, step, field, ok, warn, fail, note, bold, green, yellow, grey, blue, resetSteps } from "./lib/log.js";
import { assertNoHardcodedUrls } from "./lib/config.js";

const STAGES = [
  { key: "cctp", title: "Circle CCTP bridge to Stellar", module: "./01_cctp_bridge_test.js" },
  { key: "vault", title: "Deterministic Service Agreement vault", module: "./02_deterministic_vault_test.js" },
  { key: "release", title: "Atomic release, worker and treasury", module: "./03_x402_atomic_release_test.js" },
  { key: "cashout", title: "MoneyGram cash pickup", module: "./04_moneygram_cashout_test.js" },
];

function pause(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const startedAt = Date.now();

  console.log();
  console.log(bold("  SIVAN · STELLAR SETTLEMENT LABORATORY"));
  console.log(grey("  Stablecoin in, cash out, one Service Agreement end to end"));
  console.log();

  // ── The rule, checked rather than asserted ──────────────────────
  const offenders = await assertNoHardcodedUrls();
  if (offenders.length) {
    console.log(yellow("  HARDCODED URLS FOUND:"));
    offenders.forEach((o) => console.log("    " + o));
    console.log(grey("  Every endpoint must come from the environment.\n"));
    process.exitCode = 1;
    return;
  }
  console.log(grey("  preflight: no hardcoded URLs, every endpoint from the environment"));

  const results = {};

  for (const stage of STAGES) {
    resetSteps();
    await pause(400);

    console.log();
    console.log(grey("═".repeat(68)));
    console.log(`${bold(blue("▶"))} ${bold(stage.title)}`);
    console.log(grey("═".repeat(68)));

    try {
      const mod = await import(stage.module);
      const out = await mod.default();
      results[stage.key] = { state: "ran", out };
    } catch (e) {
      /**
       * A missing variable is a configuration gap, not a failure of the thing
       * being demonstrated. Separating the two keeps the summary honest: a
       * viewer can see the lab is wired correctly even when a credential is
       * absent.
       */
      const configGap = /Missing required environment variable|Missing \d+ required/.test(e.message);
      if (configGap) {
        console.log();
        warn("stage skipped, configuration incomplete");
        console.log(grey("   " + e.message.split("\n")[0]));
        results[stage.key] = { state: "skipped", reason: "not configured" };
      } else {
        console.log();
        fail(e.message.split("\n")[0]);
        results[stage.key] = { state: "error", reason: e.message.split("\n")[0] };
      }
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  console.log();
  console.log(grey("═".repeat(68)));
  console.log(bold("  SUMMARY"));
  console.log(grey("═".repeat(68)));

  const label = {
    ran: green("ran"),
    skipped: yellow("skipped"),
    error: yellow("error"),
  };

  for (const stage of STAGES) {
    const r = results[stage.key] ?? { state: "skipped" };
    const detail =
      r.state === "ran"
        ? r.out?.hash
          ? grey(`tx ${String(r.out.hash).slice(0, 16)}...`)
          : r.out?.address
          ? grey(`${String(r.out.address).slice(0, 16)}...`)
          : r.out?.reference
          ? grey(`ref ${r.out.reference}`)
          : ""
        : grey(r.reason ?? "");
    console.log(`  ${label[r.state].padEnd(18)} ${stage.title.padEnd(38)} ${detail}`);
  }

  console.log();

  /**
   * State plainly which parts touched a live network. The temptation in a demo
   * is to let everything look equally real; the cost is that a viewer who
   * discovers one simulated step stops believing the others.
   */
  const live = [];
  const simulated = ["CCTP burn, attestation and mint"];

  if (results.release?.out?.submitted) live.push("Stellar atomic release, submitted and confirmed");
  if (results.vault?.out?.exists) live.push("Service Agreement account read from the ledger");
  if (results.cashout?.out?.committed) live.push("MoneyGram quote, validation and commit");

  if (live.length) {
    console.log(bold("  Verified on a live network"));
    live.forEach((l) => console.log(`    ${green("•")} ${l}`));
  }
  console.log(bold("  Simulated"));
  simulated.forEach((l) => console.log(`    ${yellow("•")} ${l}`));

  console.log();
  console.log(grey(`  completed in ${elapsed}s`));
  console.log();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}

export default main;
