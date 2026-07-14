import type { Currency, Chain } from '../../database/types.js';

export function defaultOnrampRail(currency: Currency) {
  if (currency === 'eur') return 'sepa';
  if (currency === 'gbp') return 'faster_payments';
  return 'ach_push';
}

export function bridgeRailForChain(chain: Chain) {
  return chain === 'avalanche_c_chain' ? 'avalanche_c_chain' : chain;
}
