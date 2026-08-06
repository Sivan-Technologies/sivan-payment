import { env } from '../../config/env.js';
import { MockKycLevelProvider } from './mock-kyc-level.provider.js';
import { MonnifyKycLevelProvider } from './monnify-kyc-level.provider.js';

export function getKycLevelProvider(name = env.KYC_LEVEL_PROVIDER) {
  if (name === 'monnify') return new MonnifyKycLevelProvider();
  return new MockKycLevelProvider();
}
