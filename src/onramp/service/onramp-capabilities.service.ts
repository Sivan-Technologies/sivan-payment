import { isAssetSupportedOnChain, listPaymentControls } from '../../controls/payment-controls.service.js';
import { getOnrampControls } from './onramp-controls.service.js';
import { buildOnrampCapabilities } from './onramp-capabilities.js';

// Configuration only: order creation still enforces identity, terms and financial rules.
export async function getOnrampCapabilities() {
  const [controls, onramp] = await Promise.all([listPaymentControls(), getOnrampControls()]);
  return buildOnrampCapabilities(controls, onramp.oneTimePaymentInstructionsEnabled, isAssetSupportedOnChain);
}
