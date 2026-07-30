import { env } from '../config/env.js';
import { BridgeProvider } from './bridge/bridge.provider.js';
import { MockBridgeProvider } from './bridge/mock-bridge.provider.js';
import type { OfframpProvider } from './offramp-provider.interface.js';
import { chooseOfframpProvider, type OfframpProviderSelectionContext, type ProviderRoutingDecision } from './provider-routing.js';

export type OfframpProviderRequest = string | OfframpProviderSelectionContext;

/**
 * Mock providers invent customer ids, KYC approvals and transfers. In
 * production that means fabricated compliance records and money movement that
 * never happened, so the mock is refused outright rather than gated on a flag
 * someone could set by accident.
 *
 * Sandbox is a real Bridge environment, not a mock: BRIDGE_BASE_URL points at
 * api.sandbox.bridge.xyz and returns genuine customers, wallets and virtual
 * accounts. Using the mock there would test nothing.
 */
export function isMockOfframpAllowed(appEnv: string): boolean {
  return appEnv !== 'production';
}

export function mockOfframpBlockedMessage(appEnv: string, reason: string): string {
  return (
    `Mock off-ramp provider is not permitted when APP_ENV=${appEnv} (${reason}). It fabricates ` +
    'customer ids, KYC approvals and transfers. Set DEFAULT_OFFRAMP_PROVIDER=bridge and ' +
    'BRIDGE_MOCK_MODE=false, with a real BRIDGE_API_KEY.'
  );
}

function assertMockAllowed(reason: string): void {
  if (!isMockOfframpAllowed(env.APP_ENV)) {
    throw new Error(mockOfframpBlockedMessage(env.APP_ENV, reason));
  }
}

export function getOfframpProvider(input: OfframpProviderRequest = env.DEFAULT_OFFRAMP_PROVIDER): OfframpProvider {
  const providerName = typeof input === 'string' ? input : chooseOfframpProvider(input).providerName;

  // Previously this returned the mock before any environment check, so an
  // explicit 'mock' request bypassed BRIDGE_MOCK_MODE entirely.
  if (providerName === 'mock') {
    assertMockAllowed("provider explicitly requested as 'mock'");
    return new MockBridgeProvider();
  }

  if (providerName !== 'bridge') {
    throw new Error(`Unsupported off-ramp provider: ${providerName}`);
  }

  if (env.BRIDGE_MOCK_MODE) {
    assertMockAllowed('BRIDGE_MOCK_MODE=true');
    return new MockBridgeProvider();
  }

  return new BridgeProvider();
}

export function routeOfframpProvider(context: OfframpProviderSelectionContext): ProviderRoutingDecision {
  return chooseOfframpProvider(context);
}
