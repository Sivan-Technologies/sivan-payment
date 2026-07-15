import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';

export function money(value: number, decimals = 2) {
  return value.toFixed(decimals);
}

export async function getOnrampFeePercent(): Promise<string> {
  const settings = await getAdminFeeSettings();
  return settings.onrampFeePercent.toFixed(2).replace(/\.00$/, '');
}

export async function calculateOnrampQuote(amount: number) {
  const feePercent = await getOnrampFeePercent();
  const feeAmount = amount * Number(feePercent) / 100;
  const netAmount = Math.max(0, amount - feeAmount);
  return {
    amount: money(amount),
    feePercent,
    feeAmount: money(feeAmount),
    netAmount: money(netAmount, 6)
  };
}
