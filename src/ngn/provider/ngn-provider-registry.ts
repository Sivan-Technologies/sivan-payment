import { env } from '../../config/env.js';
import { EversendNgnProvider } from './eversend.provider.js';
import { LinkioNgnProvider } from './linkio.provider.js';
import { MockNgnProvider } from './mock-ngn.provider.js';
import { NombaNgnProvider } from './nomba.provider.js';
import { PajNgnProvider } from './paj.provider.js';
import { BreetNgnProvider } from './breet.provider.js';
import type { NgnProviderName } from '../types/ngn.types.js';
import type { NgnProviderAdapter } from './ngn-provider.js';

/**
 * Returns the adapter INTERFACE, not the union of concrete classes.
 *
 * The inferred union meant an optional capability declared on the interface -
 * listSettlements - was invisible to callers unless every provider happened to
 * implement it, so the reconciler could not even ask whether it existed.
 * Typing the return as the contract is what makes an optional capability
 * usable as one.
 */
export function getNgnProvider(name: NgnProviderName = env.NGN_PROVIDER as NgnProviderName): NgnProviderAdapter {
  if (name === 'linkio') return new LinkioNgnProvider();
  if (name === 'eversend') return new EversendNgnProvider();
  if (name === 'nomba') return new NombaNgnProvider();
  if (name === 'paj') return new PajNgnProvider();
  if (name === 'breet') return new BreetNgnProvider();
  return new MockNgnProvider();
}
