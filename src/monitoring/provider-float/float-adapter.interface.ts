import { z } from 'zod';

export type FloatCategory = 'payout' | 'utility' | 'offramp' | 'gas';
export type FloatCurrency = 'NGN' | 'GHS' | 'USD' | 'ETH' | 'SOL' | 'CELO';
export type FloatStatus = 'healthy' | 'warning' | 'critical' | 'unreachable';

export interface FloatBalanceResult {
  providerId: string;
  providerName: string;
  category: FloatCategory;
  currency: FloatCurrency;
  availableBalance: number;
  ledgerBalance?: number;
  lastCheckedAt: string;
  status: FloatStatus;
  rawMetadata?: unknown;
  error?: string;
}

export interface IProviderFloatAdapter {
  readonly providerId: string;
  readonly providerName: string;
  readonly category: FloatCategory;
  readonly defaultCurrency: FloatCurrency;

  fetchFloatBalance(): Promise<FloatBalanceResult>;
  isConfigured(): boolean;
}

export const providerFloatThresholdSchema = z.object({
  providerId: z.string(),
  name: z.string(),
  category: z.enum(['payout', 'utility', 'offramp', 'gas']),
  currency: z.enum(['NGN', 'GHS', 'USD', 'ETH', 'SOL', 'CELO']),
  warningThreshold: z.number().nonnegative(),
  criticalThreshold: z.number().nonnegative(),
  enabled: z.boolean().default(true),
  alertCooldownMinutes: z.number().int().positive().default(60),
});

export type ProviderFloatThreshold = z.infer<typeof providerFloatThresholdSchema>;

export const adminFloatSettingsSchema = z.object({
  monitors: z.record(z.string(), providerFloatThresholdSchema),
  pollIntervalSeconds: z.number().int().nonnegative().default(300),
  reason: z.string().optional(),
  updatedBy: z.string().optional(),
  updatedAt: z.string().optional(),
});

export type AdminFloatSettings = z.infer<typeof adminFloatSettingsSchema>;

