import { env } from '../../config/env.js';
import { MockKycLevelProvider } from './mock-kyc-level.provider.js';
import { MonnifyKycLevelProvider } from './monnify-kyc-level.provider.js';
import { FlutterwaveKycLevelProvider } from './flutterwave-kyc-level.provider.js';
import { FailoverKycLevelProvider, buildKycProviderChain } from './failover-kyc-level.provider.js';

/**
 * The provider a BVN check should go to.
 *
 * WHEN MORE THAN ONE REAL VENDOR IS CONFIGURED, THIS RETURNS A CHAIN.
 *
 * The preferred vendor still answers whenever it can - KYC_LEVEL_PROVIDER is
 * unchanged in meaning - but a provider that cannot answer at all now falls
 * through to the other instead of failing the user. That is what lets Level 2
 * ship on Flutterwave today and move itself to Monnify the moment Monnify
 * approves the account, with no deploy.
 *
 * A verdict is never failed over, only an error. See
 * failover-kyc-level.provider.ts for why that distinction is the whole safety
 * property.
 *
 * `name` is still honoured exactly when passed explicitly: callers and tests
 * that ask for one specific vendor get that vendor on its own, not a chain.
 */
export function getKycLevelProvider(name?: string) {
  if (name === 'monnify') return new MonnifyKycLevelProvider();
  if (name === 'flutterwave') return new FlutterwaveKycLevelProvider();
  if (name === 'mock') return new MockKycLevelProvider();
  if (name) return new MockKycLevelProvider();

  // No explicit request: build the chain from configuration.
  const chain = buildKycProviderChain();
  if (chain.length > 1) return new FailoverKycLevelProvider(chain);
  if (chain.length === 1) return chain[0].provider;

  // Nothing real is configured. Mock, as before - it is what the test
  // environment runs and what keeps the Level 2 step exercisable.
  return new MockKycLevelProvider();
}

/**
 * Can a BVN check actually be answered right now?
 *
 * Drives whether the Level 2 step is offered in the UI. Deliberately separate
 * from identityVerificationEnabled, which decides whether a check is REQUIRED
 * - conflating the two kept the step at "Coming soon" long after the provider
 * worked, because the button could not appear without also making the check
 * compulsory for everyone.
 *
 * The mock provider counts as configured: it is what the test environment
 * runs, and a Level 2 step that cannot be exercised outside production is a
 * step nobody can verify before launch.
 */
export function isKycLevelProviderConfigured(): boolean {
  /**
   * ANY usable vendor makes the step offerable, not just the preferred one.
   *
   * This read only KYC_LEVEL_PROVIDER, so with the preferred vendor
   * unconfigured it reported false and hid the Level 2 button - even when the
   * other vendor was configured and the chain would have answered. That is the
   * exact situation today: Monnify unapproved, Flutterwave ready.
   */
  if (buildKycProviderChain().length > 0) return true;

  const name = env.KYC_LEVEL_PROVIDER;
  if (name === 'monnify') {
    return Boolean(env.MONNIFY_API_KEY && env.MONNIFY_SECRET_KEY);
  }
  /**
   * Flutterwave needs a key AND, on the consent path, somewhere to send the
   * customer back to. A key alone is not enough: without a redirect URL the
   * consent call is refused, so reporting "configured" would put a Level 2
   * button on screen that throws the moment it is pressed.
   */
  if (name === 'flutterwave') {
    return Boolean(
      env.FLUTTERWAVE_SECRET_KEY &&
      (env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT || env.FLUTTERWAVE_BVN_REDIRECT_URL)
    );
  }
  return name === 'mock';
}
