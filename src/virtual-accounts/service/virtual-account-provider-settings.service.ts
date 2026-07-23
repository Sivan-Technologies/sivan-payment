import { z } from 'zod';
import { createAuditLog } from '../../audit/audit.service.js';
import { env } from '../../config/env.js';
import { db } from '../../database/json-database.js';
import { nowIso } from '../../shared/id.js';

const optionalSecretString = z.preprocess((value) => typeof value === 'string' && value.trim() === '' ? undefined : value, z.string().trim().min(6).optional());

export const virtualAccountProviderSettingsSchema = z.object({
  provider: z.enum(['mock', 'bridge', 'nomba', 'monnify', 'flutterwave']).default('bridge'),
  enabled: z.boolean().default(false),
  defaultSettlementAsset: z.enum(['usdc', 'usdt']).default('usdc'),
  defaultSettlementNetwork: z.enum(['base', 'avalanche_c_chain', 'polygon', 'ethereum']).default('base'),
  bridgeWalletId: optionalSecretString,
  destinationAddress: optionalSecretString,
  fallbackSettlementAsset: z.enum(['usdc', 'usdt']).optional(),
  fallbackSettlementNetwork: z.enum(['base', 'avalanche_c_chain', 'polygon', 'ethereum']).optional(),
  highRiskAutoDisable: z.boolean().default(true),
  updatedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().max(1000).optional(),
});

export type VirtualAccountProviderSettings = z.infer<typeof virtualAccountProviderSettingsSchema> & {
  updatedAt: string;
};

function envDefaultSettings(): VirtualAccountProviderSettings {
  return {
    provider: (env.VIRTUAL_ACCOUNT_PROVIDER === 'bridge' ? 'bridge' : env.VIRTUAL_ACCOUNT_PROVIDER) as VirtualAccountProviderSettings['provider'],
    enabled: env.VIRTUAL_ACCOUNTS_ENABLED && env.BRIDGE_VIRTUAL_ACCOUNTS_ENABLED,
    defaultSettlementAsset: (env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_CURRENCY === 'usdt' ? 'usdt' : 'usdc'),
    defaultSettlementNetwork: normalizeNetwork(env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL),
    bridgeWalletId: env.BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID || undefined,
    destinationAddress: env.BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS || undefined,
    fallbackSettlementAsset: undefined,
    fallbackSettlementNetwork: undefined,
    highRiskAutoDisable: true,
    updatedBy: 'env',
    reason: 'Environment fallback settings',
    updatedAt: nowIso(),
  };
}

function normalizeNetwork(value: string): VirtualAccountProviderSettings['defaultSettlementNetwork'] {
  if (value === 'avalanche_c_chain' || value === 'polygon' || value === 'ethereum') return value;
  return 'base';
}

function latestSettingsFromAudit(): Partial<VirtualAccountProviderSettings> | undefined {
  // This function is intentionally sync over already loaded DB shape; callers use db.read().
  return undefined;
}

export async function getVirtualAccountProviderSettings(options: { includeSecrets?: boolean } = {}) {
  const data = await db.read();
  const latest = (data.auditLogs ?? [])
    .filter((log) => log.action === 'virtual_account.provider_settings.updated')
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const saved = (latest?.metadata as any)?.settings as Partial<VirtualAccountProviderSettings> | undefined;
  const merged: VirtualAccountProviderSettings = {
    ...envDefaultSettings(),
    ...(saved ?? {}),
    updatedBy: latest?.actorId ?? saved?.updatedBy ?? envDefaultSettings().updatedBy,
    updatedAt: latest?.createdAt ?? saved?.updatedAt ?? envDefaultSettings().updatedAt,
  };

  if (options.includeSecrets) return merged;
  return redactVirtualAccountProviderSettings(merged);
}

export function redactVirtualAccountProviderSettings(settings: VirtualAccountProviderSettings) {
  return {
    ...settings,
    bridgeWalletId: maskSecret(settings.bridgeWalletId),
    destinationAddress: maskSecret(settings.destinationAddress),
    bridgeWalletIdConfigured: Boolean(settings.bridgeWalletId),
    destinationAddressConfigured: Boolean(settings.destinationAddress),
  };
}

export async function updateVirtualAccountProviderSettings(input: z.infer<typeof virtualAccountProviderSettingsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getVirtualAccountProviderSettings({ includeSecrets: true }) as VirtualAccountProviderSettings;
  const parsed = virtualAccountProviderSettingsSchema.parse(input);
  const next: VirtualAccountProviderSettings = {
    ...current,
    ...parsed,
    bridgeWalletId: parsed.bridgeWalletId || current.bridgeWalletId,
    destinationAddress: parsed.destinationAddress || current.destinationAddress,
    updatedAt: nowIso(),
  };

  await createAuditLog({
    actorType: 'admin',
    actorId: parsed.updatedBy,
    action: 'virtual_account.provider_settings.updated',
    resourceType: 'virtual_account_provider_settings',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      previous: redactVirtualAccountProviderSettings(current),
      settings: next,
      redactedSettings: redactVirtualAccountProviderSettings(next),
      reason: parsed.reason ?? 'Virtual account settlement settings update',
    },
  });

  return redactVirtualAccountProviderSettings(next);
}

function maskSecret(value?: string) {
  if (!value) return undefined;
  if (value.length <= 8) return '••••';
  return `••••${value.slice(-4)}`;
}
