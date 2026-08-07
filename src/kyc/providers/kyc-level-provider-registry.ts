import { env } from '../../config/env.js';
import { MockKycLevelProvider } from './mock-kyc-level.provider.js';
import { MonnifyKycLevelProvider } from './monnify-kyc-level.provider.js';
import { FlutterwaveKycLevelProvider } from './flutterwave-kyc-level.provider.js';

export function getKycLevelProvider(name = env.KYC_LEVEL_PROVIDER) {
  if (name === 'monnify') return new MonnifyKycLevelProvider();
  if (name === 'flutterwave') return new FlutterwaveKycLevelProvider();
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
