import { env } from '../../config/env.js';
import { MockKycLevelProvider } from './mock-kyc-level.provider.js';
import { MonnifyKycLevelProvider } from './monnify-kyc-level.provider.js';
import { FlutterwaveKycLevelProvider } from './flutterwave-kyc-level.provider.js';
import { IdentifyOrgKycLevelProvider, isIdentifyOrgConfigured } from './identifyorg-kyc-level.provider.js';
import { PaystackKycLevelProvider } from './paystack-kyc-level.provider.js';
import { isPaystackConfigured } from '../../config/paystackConfig.js';
import { FailoverKycLevelProvider, buildKycProviderChain } from './failover-kyc-level.provider.js';

export function getKycLevelProvider(name?: string) {
  if (name === 'paystack') return new PaystackKycLevelProvider();
  if (name === 'monnify') return new MonnifyKycLevelProvider();
  if (name === 'flutterwave') return new FlutterwaveKycLevelProvider();
  if (name === 'identifyorg') return new IdentifyOrgKycLevelProvider();
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
  if (name === 'paystack') return isPaystackConfigured();
  /**
   * A key is all IdentifyOrg needs - no OAuth step, no redirect URL, no
   * consent page. That is also why it is the one provider whose readiness can
   * be stated from configuration alone without lying.
   */
  if (name === 'identifyorg') return isIdentifyOrgConfigured();
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
