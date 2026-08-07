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
  /**
   * Solana by default - the chain the product runs on, and the one every
   * Nigerian off-ramp already quotes. Was 'base'.
   */
  defaultSettlementNetwork: z.enum(['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum']).default('solana'),
  /**
   * REMOVED, deliberately rejected rather than ignored.
   *
   * These configured a single pooled wallet/address that every virtual account
   * settled into. That made Sivan the holder of user funds, which Bridge ToS
   * 2.1(m) prohibits. Settlement is now always the individual user's own Bridge
   * wallet, resolved per customer at provisioning time.
   *
   * They are listed here so a stale client, script or saved payload that still
   * sends them fails loudly instead of appearing to configure something that no
   * longer has any effect.
   */
  bridgeWalletId: z.never({ message: 'Pooled settlement wallets are no longer supported. Virtual accounts settle into each user\'s own Bridge wallet.' }).optional(),
  destinationAddress: z.never({ message: 'Pooled settlement addresses are no longer supported. Virtual accounts settle into each user\'s own Bridge wallet.' }).optional(),
  fallbackSettlementAsset: z.enum(['usdc', 'usdt']).optional(),
  fallbackSettlementNetwork: z.enum(['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum']).optional(),
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
    // No pooled wallet or address. Settlement resolves to the user's own
    // wallet at provisioning time; see bridge-virtual-account.provider.ts.
    fallbackSettlementAsset: undefined,
    fallbackSettlementNetwork: undefined,
    highRiskAutoDisable: true,
    updatedBy: 'env',
    reason: 'Environment fallback settings',
    updatedAt: nowIso(),
  };
}

const SUPPORTED_SETTLEMENT_NETWORKS = ['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum'] as const;

function normalizeNetwork(value: string): VirtualAccountProviderSettings['defaultSettlementNetwork'] {
  const candidate = String(value ?? '').trim().toLowerCase();
  if ((SUPPORTED_SETTLEMENT_NETWORKS as readonly string[]).includes(candidate)) {
    return candidate as VirtualAccountProviderSettings['defaultSettlementNetwork'];
  }
  // Previously this fell back to 'base' silently, so a typo or an unsupported
  // value in BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL looked like it had
  // applied while settlement quietly kept using Base. Warn loudly instead.
  if (candidate) {
    console.warn(
      `[virtual-accounts] Unsupported settlement network "${value}" — falling back to "solana". ` +
      `Supported: ${SUPPORTED_SETTLEMENT_NETWORKS.join(', ')}`
    );
  }
  /**
   * The fallback and the warning MUST name the same chain.
   *
   * This returned 'base' while the message said solana - so an operator with a
   * typo in the env var would read "falling back to solana" and get Base
   * settlement. A warning that misreports the behaviour it is warning about is
   * worse than no warning.
   */
  return 'solana';
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

  // Settings saved before per-user wallets may still carry a pooled wallet or
  // address in the audit log. Strip them on read so an old record can never
  // resurrect the pooled design.
  delete (merged as any).bridgeWalletId;
  delete (merged as any).destinationAddress;

  if (options.includeSecrets) return merged;
  return redactVirtualAccountProviderSettings(merged);
}

export function redactVirtualAccountProviderSettings(settings: VirtualAccountProviderSettings) {
  const { ...rest } = settings;
  delete (rest as any).bridgeWalletId;
  delete (rest as any).destinationAddress;
  return {
    ...rest,
    // Stated explicitly so the Admin Hub can show where money actually goes,
    // rather than leaving ops to infer it from an absent field.
    settlementModel: 'per_user_wallet' as const,
    settlementNote:
      "Each virtual account settles into that user's own Bridge wallet. Sivan does not pool user funds.",
  };
}

export async function updateVirtualAccountProviderSettings(input: z.infer<typeof virtualAccountProviderSettingsSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const current = await getVirtualAccountProviderSettings({ includeSecrets: true }) as VirtualAccountProviderSettings;
  const parsed = virtualAccountProviderSettingsSchema.parse(input);
  const next: VirtualAccountProviderSettings = {
    ...current,
    ...parsed,
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
