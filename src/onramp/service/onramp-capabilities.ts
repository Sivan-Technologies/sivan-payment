import { createOnrampOrderSchema } from '../types/onramp.schemas.js';
import { defaultOnrampRail } from './onramp-rails.service.js';
type Controls = {
  payoutCurrencies: Array<{currency: string; enabled: boolean}>;
  sourceAssets: Array<{asset: string; enabled: boolean}>;
  sourceNetworks: Array<{network: string; enabled: boolean}>;
};
// Pure capability projection, shared with isolated contract tests. No provider calls.
export function buildOnrampCapabilities(controls: Controls, enabled: boolean,
  supports: (asset: 'usdc' | 'usdt', network: ReturnType<typeof createOnrampOrderSchema.parse>['destinationChain']) => boolean) {
  const schema = createOnrampOrderSchema.shape;
  return {
    enabled,
    requiresIdentityVerification: true,
    currencies: enabled ? schema.sourceCurrency.removeDefault().options
      .filter(currency => controls.payoutCurrencies.some(item => item.currency === currency && item.enabled))
      .map(currency => ({ currency, rails: [defaultOnrampRail(currency)] })) : [],
    assets: enabled ? schema.destinationCurrency.removeDefault().options.flatMap(asset => {
      if (!controls.sourceAssets.some(item => item.asset === asset && item.enabled)) return [];
      const networks = schema.destinationChain.removeDefault().options.filter(network =>
        controls.sourceNetworks.some(item => item.network === network && item.enabled) && supports(asset, network));
      return networks.length ? [{ asset, networks }] : [];
    }) : [],
  };
}
