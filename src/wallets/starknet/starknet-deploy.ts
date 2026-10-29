/**
 * STARKNET ACCOUNT DEPLOYMENT.
 *
 * THE PROBLEM THIS SOLVES, because it has no EVM equivalent.
 *
 * On EVM an address is a hash of a public key. It exists implicitly, and the
 * moment you hold the key you can spend. On Starknet an ACCOUNT IS A SMART
 * CONTRACT: it holds the signature-checking logic, which is what makes native
 * account abstraction possible in the first place.
 *
 * The address is computed in advance from the key, a class hash and a salt,
 * but until a deployment transaction runs there is NO CONTRACT AT IT. The
 * asymmetry, verified against mainnet on a fresh address:
 *
 *   starknet_getClassHashAt  ->  "Contract not found"   cannot send
 *   balanceOf on USDC        ->  ["0x0","0x0"]          CAN receive
 *
 * Receiving works because the token merely writes a number into a storage map
 * keyed by the address. Sending does not, because there is no contract to
 * verify the signature.
 *
 * So the failure lands exactly at onboarding: a new user can be paid, and then
 * cannot move the money. Paying their gas does not help, because the
 * transaction has nothing to execute against.
 *
 * SNIP-29 breaks the chicken and egg. The paymaster accepts a
 * `deploy_and_invoke` transaction carrying a `deployment` payload, and
 * deploys the account AND runs the transfer atomically, sponsored. Confirmed
 * against the live endpoint: sending type "deploy_and_invoke" returns
 * `missing field 'deployment'` rather than "unknown type", so the shape is
 * supported and simply needs the payload.
 *
 * THE SAFETY PROPERTY THAT MATTERS MOST
 *
 * Deployment data that derives a DIFFERENT address than the one we funded
 * would deploy a working account somewhere else and strand the user's money at
 * an address that can still never spend. Nothing would error. So every
 * deployment is checked against the expected address before it is submitted,
 * and a mismatch refuses rather than proceeding. See assertDeploymentMatches.
 */

import { hash as snHash, CallData } from 'starknet';
import { normaliseStarknetAddress } from '../address-validation.js';

/**
 * The account contract class hash Privy deploys for Starknet wallets.
 *
 * Deliberately env-driven with NO default. A wrong class hash derives a wrong
 * address, and the failure is silent in the worst way: the deployment succeeds
 * and the funds are at an address the user does not control. Better to refuse
 * to build a deployment at all than to guess which account implementation the
 * provider uses.
 *
 * Obtain it from a Privy Starknet wallet creation response, or from Privy's
 * documentation for the account implementation they deploy.
 */
export function accountClassHash(): string {
  const v = (process.env.STARKNET_ACCOUNT_CLASS_HASH || '').trim();
  if (!v) {
    throw new Error(
      'STARKNET_ACCOUNT_CLASS_HASH is not set. It is required to deploy a Starknet ' +
        'account and cannot be guessed: a wrong class hash derives a different ' +
        'address, which would deploy a working account the user does not control.'
    );
  }
  return v;
}

export interface AccountDeployment {
  /** The counterfactual address this deployment must produce. */
  address: string;
  class_hash: string;
  salt: string;
  /** Constructor calldata, felts. */
  calldata: string[];
  /** Present when the provider supplies its own deployment signature. */
  sigdata?: string[];
  version: number;
}

/**
 * Derive the counterfactual address for an account.
 *
 * Pure and deterministic: the same inputs always produce the same address,
 * which is the property that makes the check in assertDeploymentMatches
 * meaningful.
 *
 * `deployerAddress` is 0 for a self-deploying account, which is the standard
 * case. A non-zero deployer produces a different address, so it is explicit
 * rather than assumed.
 */
export function deriveAccountAddress(input: {
  publicKey: string;
  classHash: string;
  salt?: string;
  constructorCalldata?: string[];
  deployerAddress?: string;
}): string {
  const salt = input.salt ?? input.publicKey;
  const calldata =
    input.constructorCalldata ?? CallData.compile({ publicKey: input.publicKey });
  const raw = snHash.calculateContractAddressFromHash(
    salt,
    input.classHash,
    calldata,
    input.deployerAddress ?? 0
  );
  return normaliseStarknetAddress(raw);
}

/**
 * Refuse unless the deployment derives EXACTLY the address we are funding.
 *
 * This is the guard the whole file exists for. Compared as felts rather than
 * strings, because Starknet drops leading zeros and 0x123 and 0x0123 are the
 * same account: a string comparison here would reject valid deployments and,
 * worse, could be "fixed" by loosening it into something that accepts wrong
 * ones.
 */
export function assertDeploymentMatches(
  deployment: AccountDeployment,
  expectedAddress: string
): void {
  const derived = deriveAccountAddress({
    publicKey: deployment.calldata[0],
    classHash: deployment.class_hash,
    salt: deployment.salt,
    constructorCalldata: deployment.calldata,
  });
  if (BigInt(derived) !== BigInt(expectedAddress)) {
    throw new Error(
      'Starknet deployment data does not derive the funded address. ' +
        `Expected ${normaliseStarknetAddress(expectedAddress)}, deployment derives ${derived}. ` +
        'Refusing: deploying this would create an account the user does not control ' +
        'and strand any funds already sent to the expected address.'
    );
  }
}

/**
 * Build the deployment payload for a wallet.
 *
 * `publicKey` must come from the provider's wallet record, not be recomputed,
 * because the provider chose the salt and constructor arguments when it
 * derived the address it gave us.
 */
export function buildAccountDeployment(input: {
  address: string;
  publicKey: string;
  classHash?: string;
  salt?: string;
  constructorCalldata?: string[];
}): AccountDeployment {
  if (!input.publicKey) {
    throw new Error(
      'Cannot build a Starknet deployment without the wallet public key. ' +
        'It comes from the Privy wallet record and determines the address.'
    );
  }
  const classHash = input.classHash ?? accountClassHash();
  const calldata =
    input.constructorCalldata ?? (CallData.compile({ publicKey: input.publicKey }) as string[]);

  const deployment: AccountDeployment = {
    address: normaliseStarknetAddress(input.address),
    class_hash: classHash,
    salt: input.salt ?? input.publicKey,
    calldata: calldata.map(String),
    version: 1,
  };

  // Never return a payload that has not been proven to derive this address.
  assertDeploymentMatches(deployment, input.address);
  return deployment;
}
