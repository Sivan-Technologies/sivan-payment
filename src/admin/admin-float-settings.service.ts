import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { nowIso } from '../shared/id.js';
import type { AdminFloatSettings, FloatBalanceResult } from '../monitoring/provider-float/float-adapter.interface.js';
import { providerFloatRegistry } from '../monitoring/provider-float/float-registry.js';

export function defaultFloatSettings(): AdminFloatSettings {
  return {
    monitors: {
      paystack_payout: {
        providerId: 'paystack_payout',
        name: 'Paystack NGN Payout Pool',
        category: 'payout',
        currency: 'NGN',
        warningThreshold: 50000,
        criticalThreshold: 10000,
        enabled: true,
        alertCooldownMinutes: 60,
      },
      vtu_utility: {
        providerId: 'vtu_utility',
        name: 'VTU Utilities & Bills Pool',
        category: 'utility',
        currency: 'NGN',
        warningThreshold: 20000,
        criticalThreshold: 5000,
        enabled: true,
        alertCooldownMinutes: 60,
      },
      privy_celo_gas: {
        providerId: 'privy_celo_gas',
        name: 'Celo Smart Wallet Gas Pool',
        category: 'gas',
        currency: 'CELO',
        warningThreshold: 10,
        criticalThreshold: 2,
        enabled: true,
        alertCooldownMinutes: 60,
      },
      sivan_offramp_pool: {
        providerId: 'sivan_offramp_pool',
        name: 'Sivan Proprietary Settlement Reserve',
        category: 'offramp',
        currency: 'NGN',
        warningThreshold: 100000,
        criticalThreshold: 25000,
        enabled: false,
        alertCooldownMinutes: 60,
      },
    },
    pollIntervalSeconds: 300,
    updatedBy: 'system',
    updatedAt: nowIso(),
  };
}

export async function getAdminFloatSettings(): Promise<AdminFloatSettings> {
  const latest = await db.latestAuditLogByAction('admin.float_settings.updated');
  if (!latest) return defaultFloatSettings();

  const stored = (latest.metadata as any)?.settings;
  const defaults = defaultFloatSettings();

  return {
    ...defaults,
    ...(stored || {}),
    monitors: {
      ...defaults.monitors,
      ...(stored?.monitors || {}),
    },
    updatedBy: latest.actorId ?? 'admin_api_key',
    updatedAt: latest.createdAt,
  };
}

export async function updateAdminFloatSettings(
  input: Partial<AdminFloatSettings>,
  context: { ipAddress?: string; userAgent?: string; updatedBy?: string; reason?: string } = {}
): Promise<AdminFloatSettings> {
  const current = await getAdminFloatSettings();
  const updatedBy = context.updatedBy || 'admin_api_key';
  const reason = context.reason || 'Update float threshold configuration';

  const next: AdminFloatSettings = {
    ...current,
    ...input,
    monitors: {
      ...current.monitors,
      ...(input.monitors || {}),
    },
    pollIntervalSeconds: input.pollIntervalSeconds ?? current.pollIntervalSeconds,
    reason,
    updatedBy,
    updatedAt: nowIso(),
  };

  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'admin.float_settings.updated',
    resourceType: 'admin_float_settings',
    resourceId: 'global',
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { previous: current, settings: next, reason },
  });

  return next;
}

export async function getLiveFloatTelemetry(): Promise<{
  settings: AdminFloatSettings;
  floats: Array<FloatBalanceResult & {
    thresholds?: { warning: number; critical: number };
    alertLevel: 'ok' | 'warning' | 'critical' | 'unreachable';
  }>;
}> {
  const settings = await getAdminFloatSettings();
  const adapters = providerFloatRegistry.getEnabled(settings);

  const results = await Promise.all(
    adapters.map(async (adapter) => {
      const balance = await adapter.fetchFloatBalance();
      const threshold = settings.monitors[adapter.providerId];

      let alertLevel: 'ok' | 'warning' | 'critical' | 'unreachable' = 'ok';
      if (balance.status === 'unreachable') {
        alertLevel = 'unreachable';
      } else if (threshold) {
        if (balance.availableBalance <= threshold.criticalThreshold) {
          alertLevel = 'critical';
        } else if (balance.availableBalance <= threshold.warningThreshold) {
          alertLevel = 'warning';
        }
      }

      return {
        ...balance,
        status: (alertLevel === 'unreachable' ? 'unreachable' : alertLevel === 'critical' ? 'critical' : alertLevel === 'warning' ? 'warning' : 'healthy') as any,
        thresholds: threshold ? { warning: threshold.warningThreshold, critical: threshold.criticalThreshold } : undefined,
        alertLevel,
      };
    })
  );

  return { settings, floats: results };
}

