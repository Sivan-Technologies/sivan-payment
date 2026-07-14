import { env } from '../../config/env.js';

export function money(value: number, decimals = 2) {
  return value.toFixed(decimals);
}

export function getOnrampFeePercent(): string {
  const configured = env.SIVAN_ONRAMP_FEE_PERCENT || env.SIVAN_OFFRAMP_FEE_PERCENT || 0;
  return configured.toFixed(2).replace(/\.00$/, '');
}

export function calculateOnrampQuote(amount: number) {
  const feePercent = getOnrampFeePercent();
  const feeAmount = amount * Number(feePercent) / 100;
  const netAmount = Math.max(0, amount - feeAmount);
  return {
    amount: money(amount),
    feePercent,
    feeAmount: money(feeAmount),
    netAmount: money(netAmount, 6)
  };
}
