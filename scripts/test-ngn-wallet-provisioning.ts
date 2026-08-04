/**
 * A LEVEL 1 NIGERIAN COULD NOT CREATE A WALLET ON LIVE.
 *
 * Reported twice, with the same line:
 *   POST /api/payment/api/users/:id/wallets  400 (Bad Request)
 * for a user who verified with a Nigerian bank and is correctly Level 1.
 *
 * My first fix was WRONG - or rather, incomplete in a way that mattered. I
 * changed the Receive screen to stop offering the button before a payout
 * account exists. That was a real bug, but it was not THIS bug: this user HAS
 * a verified Nigerian payout account. The button was right to appear.
 *
 * Traced by evaluating the gates directly rather than reading them:
 *
 *   GATE 1  canProvisionWallet(level=BANK, bankStatus=VERIFIED)
 *             -> { eligible: true }            PASSES
 *   GATE 2  provider.supportedChains
 *             -> base/ethereum/solana          PASSES
 *   GATE 3  providerName === 'bridge'
 *             -> requires customer.providerCustomerId
 *                AND isApprovedKycStatus(kycStatus)   REFUSES
 *
 * The NGN verification path never creates a Bridge customer. That is the whole
 * point of the path - Bridge plays no part in a naira off-ramp and bills $2
 * per KYC. isApprovedKycStatus is false for undefined, kyc_not_started,
 * kyc_incomplete and kyc_under_review; only kyc_approved passes.
 *
 * So with the active wallet provider set to `bridge`, EVERY Nigerian who
 * verified by bank hits a permanent dead end. Not one broken account - a
 * wallet provider that structurally cannot serve the platform's main
 * verification path. render.yaml documents WALLET_PROVIDER as bridge with
 * BRIDGE_WALLETS_APPROVED=true.
 *
 * Two things were wrong and both are fixed:
 *   - the message. "Complete verification first" was shown to someone who HAD,
 *     and named no provider, so it read as "your KYC is broken" when the truth
 *     was "this deployment points at the wrong wallet provider". It also
 *     leaked an internal provider name to an end user.
 *   - the silence. Nothing surfaced this until a customer hit it. Now
 *     operational-health reports it as critical.
 *
 * Run: npm run test:ngn-wallet-provisioning
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canProvisionWallet } from '../src/wallets/wallet-eligibility.js';
import { CheckStatus, VerificationLevel, isApprovedKycStatus } from '../src/kyc/types/verification.types.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

let pass = 0;
let fail = 0;
function check(name: string, ok: unknown, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const state = (over: Partial<any> = {}) => ({
  level: VerificationLevel.NONE,
  identityStatus: CheckStatus.NOT_STARTED,
  bankStatus: CheckStatus.NOT_STARTED,
  bvnStatus: CheckStatus.NOT_STARTED,
  ninStatus: CheckStatus.NOT_STARTED,
  livenessStatus: CheckStatus.NOT_STARTED,
  proofOfAddressStatus: CheckStatus.NOT_STARTED,
  sourceOfFundsStatus: CheckStatus.NOT_STARTED,
  riskLevel: 'low',
  enhancedDueDiligence: false,
  ...over,
}) as any;

/** The reported user: Nigerian, bank-verified, Level 1, no Bridge customer. */
const ngnLevel1 = state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.VERIFIED });

console.log('\n── SIVAN says this user is eligible ───────────────────────────');

const eligibility = canProvisionWallet(ngnLevel1);
check('a bank-verified Nigerian at Level 1 IS eligible for a wallet',
  eligibility.eligible, JSON.stringify(eligibility));
check('so the 400 was NOT Sivan refusing them', eligibility.code === 'eligible');

console.log('\n── but the Bridge gate can never be satisfied by that path ────');

// The NGN path produces no Bridge customer, so kycStatus is one of these.
for (const status of [undefined, 'kyc_not_started', 'kyc_incomplete', 'kyc_under_review']) {
  check(`Bridge rejects kycStatus=${String(status)}`, !isApprovedKycStatus(status as any));
}
check('only kyc_approved passes, which the NGN path never produces',
  isApprovedKycStatus('kyc_approved' as any));

console.log('\n── the error must not accuse the user or leak the provider ────');

const svc = read('src/wallets/user-wallet.service.ts');
const bridgeBlock = svc.slice(svc.indexOf("if (providerName === 'bridge')"), svc.indexOf('return { user, customer };'));

check('it no longer tells a verified user to "Complete verification first"',
  !bridgeBlock.includes('Complete verification first'),
  'that message was shown to someone who had already completed it');
check('it no longer says "Bridge requires approved verification"',
  !bridgeBlock.includes('Bridge requires approved verification'));
check('the user-facing message does not name the provider',
  !/throw badRequest\([^)]*Bridge/s.test(bridgeBlock),
  'an internal vendor name is not a customer concern');
check('the user-facing message does not blame the user',
  /temporarily unavailable/i.test(bridgeBlock));
check('the real cause is logged for operators, with the provider named',
  bridgeBlock.includes('wallet.provider_cannot_serve_user') && bridgeBlock.includes("provider: 'bridge'"));
check('the log states the exact fix', /activeProvider|admin\/wallets\/controls/.test(bridgeBlock));
check('it records that Sivan itself considered the user eligible',
  bridgeBlock.includes('sivanEligible: true'),
  'without this an operator cannot tell whose gate refused');

/**
 * Deliberately NOT auto-switching provider here. Which vendor custodies user
 * funds is an operator decision, not something a request handler should change
 * silently mid-flight. Pinned so a later "helpful" fallback has to argue with
 * a test first.
 */
check('it does NOT silently fall back to another custody provider',
  !/getWalletProvider\(['"]privy['"]\)/.test(bridgeBlock));

console.log('\n── and an operator is told BEFORE a customer finds out ────────');

const health = read('src/monitoring/operational-health.service.ts');
check('operational-health has a wallet-provider signal',
  health.includes("name: 'wallet_provider_serves_ngn_users'"));
check('it reads the ACTIVE provider, not the env fallback',
  health.includes('resolveActiveWalletProvider()'),
  'the admin control overrides WALLET_PROVIDER and survives deploys');
check('bridge is the blocked case', /const blocked = provider === 'bridge'/.test(health));
check('it is critical, not a warning', /blocked \? 'critical' : 'ok'/.test(health));
check('the detail names the exact remedy',
  health.includes('activeProvider":"privy'));
check('a non-bridge provider reports ok',
  /can issue wallets to bank-verified users/.test(health));

console.log('\n── the rest of the eligibility ladder still holds ─────────────');

check('no bank account is still refused',
  !canProvisionWallet(state({ level: VerificationLevel.NONE })).eligible);
check('a stale bank check is still refused',
  !canProvisionWallet(state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.NOT_STARTED })).eligible);
check('a high-risk account is still refused',
  !canProvisionWallet(state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.VERIFIED, riskLevel: 'high' })).eligible);
check('high risk WITH enhanced due diligence is allowed',
  canProvisionWallet(state({ level: VerificationLevel.BANK, bankStatus: CheckStatus.VERIFIED, riskLevel: 'high', enhancedDueDiligence: true })).eligible);

console.log(`\n${fail === 0 ? '✅' : '❌'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
