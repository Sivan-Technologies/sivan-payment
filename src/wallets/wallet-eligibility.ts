/**
 * When may a user be given a wallet?
 *
 * THE ANSWER: at basic information. Level 1 - name plus a payout bank account
 * that resolved to a real account name. Not at signup, and not gated on full
 * KYC.
 *
 * WHY NOT AT SIGNUP
 *
 * A wallet at signup means provisioning a key for every email address that
 * ever touched the product, including the ones that never come back. Privy
 * prices per monthly-active wallet rather than per created wallet, so the cost
 * is small - but an address handed to an unidentified person is still an
 * address Sivan cannot answer questions about later. "Who owns this wallet"
 * should always have an answer.
 *
 * WHY NOT AT FULL KYC
 *
 * Because a wallet address is not a financial permission. It is somewhere to
 * receive tokens. What a user may DO with what arrives - off-ramp, escrow,
 * amounts - is decided by the verification level and the ledger, every time,
 * at the point of action. Coupling wallet creation to KYC would mean a
 * compliance rule change forces a wallet migration, which is exactly the
 * mistake the current Bridge setup made: every KYC-approved record carries a
 * mock_cust_* provider id, so Receive 404s for every user.
 *
 * WHY LEVEL 1 IS THE RIGHT LINE
 *
 * A resolved payout account is not a weak signal. Since the CBN directive
 * effective 1 March 2024, a Nigerian bank account cannot transact without
 * BVN/NIN linkage - so an account that resolves is one a licensed bank has
 * already verified. Sivan inherits a real identity check for the price of a
 * name lookup, and knows where this person's money is supposed to go.
 *
 * THE SEPARATION THIS PRESERVES
 *
 *   wallet exists        -> Level 1
 *   receive tokens       -> Level 1
 *   move value out       -> whatever the flow requires, checked at that moment
 *
 * A user can therefore hold a funded wallet they are not yet cleared to
 * off-ramp from. That is intentional. The funds are theirs, the ledger records
 * them, and the limit applies to the action rather than to the container.
 */

import { CheckStatus, VerificationLevel } from '../kyc/types/verification.types.js';
import type { VerificationState } from '../kyc/types/verification.types.js';

export type WalletEligibilityCode =
  | 'eligible'
  | 'needs_bank_verification'
  | 'blocked_risk'
  | 'blocked_check_failed';

export interface WalletEligibility {
  eligible: boolean;
  code: WalletEligibilityCode;
  /** Safe to show a user. States what is needed, not what failed internally. */
  reason: string;
}

/** Minimum level at which a wallet may be provisioned. */
export const WALLET_MINIMUM_LEVEL = VerificationLevel.BANK;

export function canProvisionWallet(state: VerificationState): WalletEligibility {
  // High risk stops provisioning outright.
  if (state.riskLevel === 'high' && !state.enhancedDueDiligence) {
    return {
      eligible: false,
      code: 'blocked_risk',
      reason: 'This account needs a manual review before a wallet can be created.',
    };
  }

  if (state.bankStatus === CheckStatus.FAILED || state.bankStatus === CheckStatus.EXPIRED) {
    return {
      eligible: false,
      code: 'blocked_check_failed',
      reason: 'Your payout account needs attention before a wallet can be created.',
    };
  }

  return { eligible: true, code: 'eligible', reason: 'Account is eligible for wallet provisioning.' };
}

/**
 * Wallets to provision for an eligible user.
 *
 * TWO KEYS, THREE CHAINS. Solana signs on ed25519 and EVM on secp256k1, so
 * Solana is genuinely a separate key. Ethereum and Base are the same curve AND
 * the same address, so one EVM wallet serves both - asking Privy for each
 * separately returns the same wallet, and treating them as two would create a
 * second deposit address nobody watches.
 */
export function walletsToProvision(): { chain: 'solana' | 'ethereum'; alsoServes: string[] }[] {
  return [
    { chain: 'ethereum', alsoServes: ['base'] },
    { chain: 'solana', alsoServes: [] },
  ];
}
