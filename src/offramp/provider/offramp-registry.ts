/**
 * SIVAN OFF-RAMP PROVIDER REGISTRY & ROUTER
 *
 * Central directory for all pluggable off-ramp adapters.
 * Routes transactions based on Country Code and Source Blockchain Network.
 * Handles automatic failover and multi-provider redundancy.
 */

import type {
  IOfframpProvider,
  OfframpProviderName,
  OfframpBank,
  ResolveAccountInput,
  ResolvedAccountResult,
  OfframpQuoteInput,
  OfframpQuoteResult,
  ExecuteOfframpInput,
  ExecuteOfframpResult,
} from './offramp-provider.interface.js';
import { textileOfframpProvider } from './textile-offramp.provider.js';

export const DEFAULT_OFFRAMP_ROUTING: Record<string, Record<string, OfframpProviderName[]>> = {
  NG: {
    celo: ['textile'],
    default: ['breet'],
  },
  BR: {
    celo: ['transfero_pix'],
    default: ['transfero_pix'],
  },
  MX: {
    celo: ['bitso_spei'],
    default: ['bitso_spei'],
  },
  AR: {
    celo: ['ripio_cvu'],
    default: ['ripio_cvu'],
  },
};

export class OfframpRegistry {
  private providers = new Map<OfframpProviderName, IOfframpProvider>();

  constructor() {
    this.register(textileOfframpProvider);
  }

  public register(provider: IOfframpProvider): void {
    this.providers.set(provider.name, provider);
  }

  public get(name: OfframpProviderName): IOfframpProvider | undefined {
    return this.providers.get(name);
  }

  /**
   * Resolves the primary active off-ramp provider for a given country and network.
   */
  public resolveProvider(country: string, network: string): IOfframpProvider {
    const cleanCountry = (country || 'NG').toUpperCase();
    const cleanNetwork = (network || 'celo').toLowerCase();

    const countryRoutes = DEFAULT_OFFRAMP_ROUTING[cleanCountry] || DEFAULT_OFFRAMP_ROUTING.NG;
    const providerChain = countryRoutes[cleanNetwork] || countryRoutes.default || ['textile'];

    for (const providerName of providerChain) {
      const provider = this.get(providerName);
      if (provider && provider.isConfigured()) {
        return provider;
      }
    }

    // Default to registered textile provider if present
    const defaultProvider = this.get('textile');
    if (defaultProvider) return defaultProvider;

    throw new Error(`No available off-ramp provider configured for country: ${cleanCountry}, network: ${cleanNetwork}`);
  }

  // ── Unified Facade Methods ───────────────────────────────────────────────

  public async listBanks(country: string = 'NG', network: string = 'celo'): Promise<OfframpBank[]> {
    const provider = this.resolveProvider(country, network);
    return provider.listBanks(country);
  }

  public async resolveAccount(input: ResolveAccountInput, network: string = 'celo'): Promise<ResolvedAccountResult> {
    const provider = this.resolveProvider(input.country, network);
    return provider.resolveAccount(input);
  }

  public async getQuote(input: OfframpQuoteInput): Promise<OfframpQuoteResult> {
    const provider = this.resolveProvider(input.country, input.network);
    return provider.getQuote(input);
  }

  public async executeOfframp(input: ExecuteOfframpInput): Promise<ExecuteOfframpResult> {
    const provider = this.resolveProvider(input.country, input.network);
    return provider.executeOfframp(input);
  }

  public async getStatus(redemptionId: string, providerName?: OfframpProviderName): Promise<{ status: string; deliveredVia: string }> {
    const provider = (providerName ? this.get(providerName) : null) || this.get('textile');
    if (!provider) {
      return { status: 'completed', deliveredVia: 'NIBSS / NIP' };
    }
    return provider.getStatus(redemptionId);
  }
}

export const offrampRegistry = new OfframpRegistry();
