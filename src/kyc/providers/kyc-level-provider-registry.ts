import { env } from '../../config/env.js';
import { MockKycLevelProvider } from './mock-kyc-level.provider.js';
import { MonnifyKycLevelProvider } from './monnify-kyc-level.provider.js';

export function getKycLevelProvider(name = env.KYC_LEVEL_PROVIDER) {
  if (name === 'monnify') return new MonnifyKycLevelProvider();
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
  return name === 'mock';
}
