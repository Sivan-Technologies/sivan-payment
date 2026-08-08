import { env } from '../../config/env.js';
import { getAdminFeeSettings } from '../../admin/admin-fees.service.js';

/**
 * What the NGN provider charges Sivan, as a percentage.
 *
 * ONE SOURCE, READ BY EVERY PROVIDER.
 *
 * This number lived in three places: `BREET_FEE_PERCENT` in the environment
 * (so changing it meant a redeploy), and `0.005` hardcoded twice inside
 * mock-ngn.provider.ts. The mock therefore disagreed with the real provider
 * whenever the rate moved, which is the worst possible place for a
 * disagreement - local testing showing a fee the user will not be charged.
 *
 * A vendor can change its pricing with an email. The fee tab is where that
 * belongs.
 *
 * FALLS BACK TO THE ENV VALUE rather than to a literal, so a deployment that
 * has never opened the fee tab keeps behaving exactly as it does today.
 */
export async function ngnProviderFeePercent(): Promise<number> {
  try {
    const settings: any = await getAdminFeeSettings();
    const configured = Number(settings?.ngnProviderFeePercent);
    // 0 is a legitimate setting - some providers bundle their fee into the
    // rate - so this checks for a usable NUMBER, not for truthiness.
    if (Number.isFinite(configured) && configured >= 0) return configured;
  } catch {
    // Settings unreadable: fall through to the environment rather than
    // failing a quote the user is waiting on.
  }
  return Number(env.BREET_FEE_PERCENT ?? 0);
}
