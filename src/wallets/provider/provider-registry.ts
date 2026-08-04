import { env } from '../../config/env.js';
import { BridgeWalletProvider } from './bridge-wallet.provider.js';
import { MockWalletProvider } from './mock-wallet.provider.js';
import { PrivyWalletProvider } from './privy-wallet.provider.js';
import type { WalletProvider } from './wallet-provider.js';
import type { WalletProviderName } from '../types/wallet.types.js';

/**
 * Single switch point between wallet vendors.
 *
 * Adding Bridge or Privy should mean implementing WalletProvider and adding a
 * branch here. No service, route, or UI change should be required.
 *
 * Current status:
 *   mock   — implemented, used for local development and UI work
 *   bridge — pending Legal & Compliance approval and wallet pricing
 *   privy  — pending evaluation; non-custodial, likely cleaner under
 *            Bridge ToS 2.1(m) since Sivan would hold neither funds nor keys
 */
/**
 * Whether the mock wallet provider may be used in a given environment.
 *
 * Mock addresses are deterministic strings that belong to nobody. Anything
 * sent to one is permanently lost. The original guard only covered production,
 * but the test service runs APP_ENV=staging, so a real user on
 * sivan-payments-user-test could be handed a fake address presented as real.
 *
 *   development  -> allowed, this is ordinary local work
 *   anything else -> blocked unless ALLOW_MOCK_WALLETS=true is set deliberately
 *   production   -> always blocked; the override is NOT honoured, because no
 *                   environment variable should be able to point real customer
 *                   money at an address nobody controls
 *
 * Exported as a pure function of its inputs so it can be tested directly.
 * Reading process.env inside the registry made it untestable: config/env.ts
 * caches at import time, so a test mutating process.env changed nothing.
 */
export function isMockWalletAllowed(appEnv: string, allowMockFlag?: string): boolean {
  if (appEnv === 'development') return true;
  if (appEnv === 'production') return false;
  return String(allowMockFlag || '').toLowerCase() === 'true';
}

export function mockWalletBlockedMessage(appEnv: string): string {
  return (
    `Mock wallet provider is disabled outside development (APP_ENV=${appEnv}). ` +
    'Mock addresses are not real and funds sent to them cannot be recovered. ' +
    'Configure WALLET_PROVIDER=bridge or privy, or set ALLOW_MOCK_WALLETS=true to ' +
    'deliberately accept fake addresses in a non-production environment.'
  );
}

/** Single mock instance - see the comment inside getWalletProvider. */
let mockInstance: MockWalletProvider | undefined;

export function getWalletProvider(
  providerName = process.env.WALLET_PROVIDER || 'mock'
): WalletProvider {
  const normalized = providerName.trim().toLowerCase() as WalletProviderName;

  if (normalized === 'mock') {
    if (!isMockWalletAllowed(env.APP_ENV, process.env.ALLOW_MOCK_WALLETS)) {
      throw new Error(mockWalletBlockedMessage(env.APP_ENV));
    }
    /**
     * ONE INSTANCE, because the mock keeps its wallets IN MEMORY.
     *
     * This was `new MockWalletProvider()`, so every call handed back a fresh
     * object with an empty Map. A wallet created through one call did not
     * exist for the next - `getBalances` threw "Mock wallet not found", which
     * the balance reader correctly interprets as "the chain is unreachable",
     * which makes every send refuse with "We could not read your wallet
     * balance just now".
     *
     * That is why no test has ever been able to exercise a funded wallet
     * end-to-end against the mock, and it is a large part of why the
     * base-vs-ethereum bug survived to production: the one harness that could
     * have caught it could not hold a balance long enough to try.
     *
     * Bridge and Privy are stateless HTTP clients, so per-call construction is
     * harmless for them. The mock IS the state, so it must not be.
     */
    mockInstance ??= new MockWalletProvider();
    return mockInstance;
  }

  if (normalized === 'bridge') {
    // Bridge Custodial Wallets require Legal & Compliance sign-off on the fund
    // flow before production use (apidocs.bridge.xyz/platform/wallets/overview).
    // The adapter is implemented and tested, but production stays gated behind
    // an explicit acknowledgement so it cannot be switched on by accident.
    if (env.APP_ENV === 'production' && String(process.env.BRIDGE_WALLETS_APPROVED || '').toLowerCase() !== 'true') {
      throw new Error(
        'Bridge wallets are not approved for production. Bridge Legal & Compliance must approve ' +
        'the wallet fund flow first; set BRIDGE_WALLETS_APPROVED=true once they have.'
      );
    }
    return new BridgeWalletProvider();
  }

  if (normalized === 'privy') {
    // Non-custodial: the user owns the key, Sivan holds neither funds nor
    // keys. Transfers therefore return pending_user_signature rather than
    // submitting server-side - see privy-wallet.provider.ts.
    return new PrivyWalletProvider();
  }

  throw new Error(`Unsupported wallet provider: ${providerName}`);
}
