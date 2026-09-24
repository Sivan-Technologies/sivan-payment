/**
 * Stellar helpers for the lab.
 *
 * Everything network-dependent is read from the environment. This module holds
 * no endpoint, no passphrase and no asset issuer of its own.
 */

import {
  Horizon,
  Keypair,
  Asset,
  Networks,
  TransactionBuilder,
  Operation,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { createHash } from "node:crypto";
import { required } from "./config.js";

export function horizon() {
  return new Horizon.Server(required("STELLAR_HORIZON_URL"));
}

export function networkPassphrase() {
  const p = required("STELLAR_NETWORK_PASSPHRASE");
  /**
   * Warn if the passphrase is not one Stellar publishes.
   *
   * The passphrase is mixed into every signature, so a wrong one produces
   * signatures that are valid for a network nobody is running. That fails in a
   * confusing way, far from the cause, which is worth a line of defence here.
   */
  const known = Object.values(Networks);
  if (!known.includes(p)) {
    console.warn(
      `   WARN network passphrase "${p}" is not a standard Stellar network.\n` +
        `        Signatures will only be valid on a network using it.`
    );
  }
  return p;
}

export function usdc() {
  return new Asset(
    required("STELLAR_USDC_ASSET_CODE"),
    required("STELLAR_USDC_ISSUER")
  );
}

/**
 * DETERMINISTIC SERVICE AGREEMENT KEYPAIR.
 *
 *   seed32 = SHA256(masterSeed || ":" || agreementId)
 *
 * The same pair of inputs always yields the same account, so a Service
 * Agreement address can be recomputed from the agreement id rather than stored.
 * That removes a database as a point of failure between a user and their funds.
 *
 * The separator is not cosmetic. Without it, ("abc", "12") and ("ab", "c12")
 * hash identically, so two different agreements would derive the same account
 * and settle into each other. A single byte prevents that collision class.
 *
 * TEST ONLY. A real deployment derives inside an HSM or KMS and the master seed
 * never exists in a process this lab could read.
 */
export function deriveKeypair(masterSeed, agreementId) {
  if (!masterSeed) throw new Error("deriveKeypair: masterSeed is required");
  if (!agreementId) throw new Error("deriveKeypair: agreementId is required");
  const raw = createHash("sha256")
    .update(`${masterSeed}:${agreementId}`, "utf8")
    .digest();
  return Keypair.fromRawEd25519Seed(raw);
}

/** Load an account, returning null rather than throwing when it does not exist. */
export async function loadAccountOrNull(server, address) {
  try {
    return await server.loadAccount(address);
  } catch (e) {
    if (e?.response?.status === 404) return null;
    throw e;
  }
}

/** Balance of one asset on an account, as a string. "0" when no trustline. */
export function balanceOf(account, asset) {
  const line = account.balances.find(
    (b) =>
      (b.asset_type === "native" && asset.isNative()) ||
      (b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer())
  );
  return line ? line.balance : "0";
}

export function hasTrustline(account, asset) {
  return account.balances.some(
    (b) =>
      b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer()
  );
}

export async function builderFor(server, sourceAccount, feeMultiplier = 2) {
  const base = await server.fetchBaseFee().catch(() => Number(BASE_FEE));
  return new TransactionBuilder(sourceAccount, {
    fee: String(base * feeMultiplier),
    networkPassphrase: networkPassphrase(),
  });
}

export { Keypair, Asset, Operation, TransactionBuilder, BASE_FEE };
