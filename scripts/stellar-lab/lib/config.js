/**
 * CONFIGURATION. THE ONLY PLACE THIS LAB READS THE ENVIRONMENT.
 *
 * NO HARDCODED URLs. NO DEFAULTS. NO FALLBACKS.
 *
 * Every endpoint, key and address is required from the environment and the
 * process exits if one is missing. There is deliberately no `|| "https://..."`
 * anywhere in this lab.
 *
 * Why the rule is absolute rather than a preference:
 *
 *   A default URL is invisible when it is wrong. If a script falls back to a
 *   built-in Horizon endpoint, it keeps running after someone points the lab at
 *   a different network, and the output still looks correct. The failure only
 *   surfaces later, in the form of a transaction submitted to a network nobody
 *   intended.
 *
 *   A published address with no code behind it is the same class of problem. It
 *   reads as plausible, survives a glance, and is only discovered when funds
 *   have already moved.
 *
 * So: absent configuration is a loud, immediate stop, and never a quiet
 * substitution.
 */

import { config as loadDotenv } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const LAB_ROOT = join(HERE, "..");

// Only this lab's own .env. The parent application's environment is never read.
const ENV_PATH = join(LAB_ROOT, ".env");
if (existsSync(ENV_PATH)) loadDotenv({ path: ENV_PATH });

/** Everything this lab can be asked for, with what it is for. */
const SPEC = {
  // ── Stellar network ───────────────────────────────────────────────
  STELLAR_HORIZON_URL: "Horizon REST endpoint for the target network",
  STELLAR_NETWORK_PASSPHRASE:
    'Network passphrase, e.g. "Test SDF Network ; September 2015". Binds a signature to one network, so it must never be guessed',
  STELLAR_USDC_ISSUER: "Issuer account of the USDC asset on this network",
  STELLAR_USDC_ASSET_CODE: "Asset code, normally USDC",

  // ── Lab actors ────────────────────────────────────────────────────
  LAB_MASTER_SEED:
    "Seed for deterministic Service Agreement keypair derivation. TEST ONLY",
  LAB_SPONSOR_SECRET:
    "Secret key of the account that funds and fee-sponsors lab transactions",
  LAB_WORKER_ADDRESS: "Public key receiving the worker payout",
  LAB_TREASURY_ADDRESS: "Public key receiving the Sivan protocol fee",

  // ── Circle CCTP ───────────────────────────────────────────────────
  CCTP_SOURCE_RPC_URL: "JSON-RPC endpoint of the CCTP source chain",
  CCTP_SOURCE_DOMAIN: "Circle numeric domain id of the source chain",
  CCTP_DESTINATION_DOMAIN: "Circle numeric domain id of Stellar",
  CCTP_TOKEN_MESSENGER_ADDRESS: "TokenMessenger contract on the source chain",
  CCTP_ATTESTATION_API_URL: "Circle attestation service base URL",

  // ── MoneyGram ─────────────────────────────────────────────────────
  MONEYGRAM_API_BASE_URL: "MoneyGram API base URL for the target environment",
  MONEYGRAM_PARTNER_ID: "Partner identifier issued by MoneyGram",
  MONEYGRAM_API_KEY: "API key for the MoneyGram environment",
  MONEYGRAM_WEBHOOK_PUBLIC_KEY:
    "MoneyGram RSA public key, PEM, used to verify webhook signatures",
  MONEYGRAM_WEBHOOK_HOST:
    "Host this lab is reachable at. Signed into the webhook digest, so it must match exactly",
  MONEYGRAM_WEBHOOK_PORT: "Local port for the webhook listener",
};

const missing = [];

/**
 * Read one variable. Throws rather than returning a default.
 * @param {keyof SPEC} name
 */
export function required(name) {
  const value = (process.env[name] ?? "").trim();
  if (!value) {
    throw new Error(
      `Missing required environment variable: ${name}\n` +
        `  Purpose: ${SPEC[name] ?? "see .env.example"}\n` +
        `  This lab has no default for it, on purpose. A silent fallback to a\n` +
        `  built-in endpoint is how a test ends up running against the wrong\n` +
        `  network while still reporting success.\n` +
        `  Fix: cp .env.example .env`
    );
  }
  return value;
}

/** Read several at once and report every missing one together. */
export function requireAll(names) {
  const out = {};
  const absent = [];
  for (const n of names) {
    const v = (process.env[n] ?? "").trim();
    if (!v) absent.push(n);
    else out[n] = v;
  }
  if (absent.length) {
    const lines = absent.map((n) => `    ${n}  ${SPEC[n] ?? ""}`).join("\n");
    throw new Error(
      `Missing ${absent.length} required environment variable(s):\n${lines}\n\n` +
        `  No defaults exist in this lab. Run: cp .env.example .env`
    );
  }
  return out;
}

export function numberRequired(name) {
  const raw = required(name);
  const n = Number(raw);
  if (!Number.isFinite(n)) {
    throw new Error(`${name} must be numeric, received "${raw}"`);
  }
  return n;
}

/**
 * Assert nothing in this lab hardcodes a URL.
 *
 * Run by the preflight so the rule is enforced by a check rather than by
 * remembering it. A convention nobody enforces decays one edit at a time.
 */
export async function assertNoHardcodedUrls() {
  const { readdir, readFile } = await import("node:fs/promises");
  const offenders = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) { await walk(p); continue; }
      if (!e.name.endsWith(".js")) continue;
      const text = await readFile(p, "utf8");
      text.split("\n").forEach((line, i) => {
        // A URL literal is only a problem in code. Comments and the .env
        // example are documentation, which is where URLs belong.
        const trimmed = line.trim();
        if (trimmed.startsWith("*") || trimmed.startsWith("//")) return;
        const m = line.match(/["'`](https?:\/\/[^"'`]+)["'`]/);
        if (m) offenders.push(`${e.name}:${i + 1}  ${m[1]}`);
      });
    }
  };
  await walk(LAB_ROOT);
  return offenders;
}

/** Human-readable preflight. Exits non-zero if the lab cannot run. */
async function preflight() {
  console.log("Stellar lab preflight\n");

  const offenders = await assertNoHardcodedUrls();
  if (offenders.length) {
    console.error("HARDCODED URLS FOUND IN CODE:");
    offenders.forEach((o) => console.error("  " + o));
    console.error("\nEvery endpoint must come from the environment.");
    process.exitCode = 1;
    return;
  }
  console.log("  no hardcoded URLs in lab source");

  const names = Object.keys(SPEC);
  const absent = names.filter((n) => !(process.env[n] ?? "").trim());
  const present = names.length - absent.length;
  console.log(`  ${present} of ${names.length} variables configured`);

  if (absent.length) {
    console.log("\n  not yet set:");
    absent.forEach((n) => console.log(`    ${n.padEnd(32)} ${SPEC[n]}`));
    console.log(
      "\n  Individual scripts require only their own subset, so some of these\n" +
        "  may not block the test you want to run."
    );
  } else {
    console.log("\n  fully configured");
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  preflight().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
}
