import { env } from '../config/env.js';
import { BridgeProvider } from './bridge/bridge.provider.js';
import { MockBridgeProvider } from './bridge/mock-bridge.provider.js';
import type { OfframpProvider } from './offramp-provider.interface.js';
import { chooseOfframpProvider, type OfframpProviderSelectionContext, type ProviderRoutingDecision } from './provider-routing.js';

export type OfframpProviderRequest = string | OfframpProviderSelectionContext;

export function getOfframpProvider(input: OfframpProviderRequest = env.DEFAULT_OFFRAMP_PROVIDER): OfframpProvider {
  const providerName = typeof input === 'string' ? input : chooseOfframpProvider(input).providerName;

  if (providerName !== 'bridge') {
    throw new Error(`Unsupported off-ramp provider: ${providerName}`);
  }

  return env.BRIDGE_MOCK_MODE ? new MockBridgeProvider() : new BridgeProvider();
}

export function routeOfframpProvider(context: OfframpProviderSelectionContext): ProviderRoutingDecision {
  return chooseOfframpProvider(context);
}
