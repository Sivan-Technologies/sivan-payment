import { env } from '../../config/env.js';
import { EversendNgnProvider } from './eversend.provider.js';
import { LinkioNgnProvider } from './linkio.provider.js';
import { MockNgnProvider } from './mock-ngn.provider.js';
import { NombaNgnProvider } from './nomba.provider.js';
import type { NgnProviderName } from '../types/ngn.types.js';

export function getNgnProvider(name: NgnProviderName = env.NGN_PROVIDER as NgnProviderName) {
  if (name === 'linkio') return new LinkioNgnProvider();
  if (name === 'eversend') return new EversendNgnProvider();
  if (name === 'nomba') return new NombaNgnProvider();
  return new MockNgnProvider();
}
