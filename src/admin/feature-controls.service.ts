import { nowIso } from '../shared/id.js';
import { MONEYGRAM_GLOBAL_CORRIDORS } from '../moneygram/data/corridors.data.js';
import { db } from '../database/json-database.js';
import { createAuditLog } from '../audit/audit.service.js';
import { getUtilityRouting } from '../ngn/provider/utility-registry.js';

export interface MoneyGramControls {
  enabled: boolean;
  minipayEnabled: boolean;
  telegramEnabled: boolean;
  whatsappEnabled: boolean;
  webappEnabled: boolean;
  maintenanceMode: boolean;
  maintenanceReason: string;
  corridors: string[];
  platformFeePercent: number;
  minAmountUsdc: number;
  maxAmountUsdc: number;
  cashInMinAmountUsdc?: number;
  cashInMaxAmountUsdc?: number;
  updatedAt: string;
  updatedBy: string;
}

export interface UtilitiesControls {
  enabled: boolean;
  airtimeEnabled: boolean;
  dataEnabled: boolean;
  electricityEnabled: boolean;
  cableTvEnabled: boolean;
  primaryProvider: 'paystack' | 'smeapi' | string;
  fallbackProvider: 'paystack' | 'smeapi' | 'none' | string;
  maintenanceMode: boolean;
  maintenanceReason: string;
  discountPercent: number;
  updatedAt: string;
  updatedBy: string;
}

export interface MoneyGramTransactionRecord {
  id: string;
  mode: 'withdraw' | 'deposit';
  amountUsdc: number;
  targetCurrency: string;
  targetAmount: number;
  channel: 'minipay' | 'telegram' | 'whatsapp' | 'webapp' | 'api';
  userAddressOrId: string;
  pickupPin?: string;
  status: 'pending_user_transfer_start' | 'pending_user_transfer_complete' | 'ready_for_pickup' | 'completed' | 'refunded' | 'expired';
  moreInfoUrl: string;
  createdAt: string;
  updatedAt: string;
}

export interface UtilityTransactionRecord {
  id: string;
  category: 'airtime' | 'data' | 'electricity' | 'cable_tv';
  provider: string;
  serviceId: string;
  accountOrPhone: string;
  amountNgn: number;
  amountUsdc: number;
  channel: 'minipay' | 'telegram' | 'whatsapp' | 'webapp';
  userAddressOrId: string;
  tokenOrReceipt?: string;
  status: 'pending' | 'success' | 'failed';
  createdAt: string;
}

let moneyGramControls: MoneyGramControls = {
  enabled: true,
  minipayEnabled: true,
  telegramEnabled: true,
  whatsappEnabled: true,
  webappEnabled: true,
  maintenanceMode: false,
  maintenanceReason: 'MoneyGram Stellar cash corridors are undergoing scheduled maintenance. Direct bank cashouts remain active.',
  corridors: MONEYGRAM_GLOBAL_CORRIDORS.map((c) => c.code),
  platformFeePercent: 0,
  minAmountUsdc: 5,
  maxAmountUsdc: 2500,
  cashInMinAmountUsdc: 5,
  cashInMaxAmountUsdc: 950,
  updatedAt: nowIso(),
  updatedBy: 'system',
};

let utilitiesControls: UtilitiesControls = {
  enabled: true,
  airtimeEnabled: true,
  dataEnabled: true,
  electricityEnabled: true,
  cableTvEnabled: false,
  primaryProvider: 'paystack',
  fallbackProvider: 'smeapi',
  maintenanceMode: false,
  maintenanceReason: 'Bill payment aggregators undergoing scheduled maintenance.',
  discountPercent: 1.0,
  updatedAt: nowIso(),
  updatedBy: 'system',
};

const moneyGramTransactions: MoneyGramTransactionRecord[] = [];
const utilityTransactions: UtilityTransactionRecord[] = [];

export async function getMoneyGramControls(): Promise<MoneyGramControls> {
  try {
    const latest = await db.latestAuditLogByAction('moneygram.controls.updated').catch(() => null);
    const saved = (latest?.metadata as any)?.settings as Partial<MoneyGramControls> | undefined;
    if (saved) {
      moneyGramControls = {
        ...moneyGramControls,
        ...saved,
      };
    }
  } catch (err) {
    console.warn('[feature-controls] Could not read persisted moneygram controls:', err);
  }
  return { ...moneyGramControls };
}

export async function updateMoneyGramControls(
  patch: Partial<MoneyGramControls>,
  updatedBy = 'admin'
): Promise<MoneyGramControls> {
  const current = await getMoneyGramControls();
  moneyGramControls = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
    updatedBy,
  };
  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'moneygram.controls.updated',
    resourceType: 'moneygram_controls',
    resourceId: 'global',
    severity: 'info',
    metadata: { settings: moneyGramControls },
  }).catch((err) => {
    console.warn('[feature-controls] Failed to persist moneygram controls audit log:', err);
  });
  return { ...moneyGramControls };
}

export async function getUtilitiesControls(): Promise<UtilitiesControls> {
  try {
    const latest = await db.latestAuditLogByAction('utilities.controls.updated').catch(() => null);
    const saved = (latest?.metadata as any)?.settings as Partial<UtilitiesControls> | undefined;
    if (saved) {
      utilitiesControls = {
        ...utilitiesControls,
        ...saved,
      };
    }
    const routing = getUtilityRouting();
    if (routing?.routes?.airtime?.[0]) {
      utilitiesControls.primaryProvider = routing.routes.airtime[0];
      utilitiesControls.fallbackProvider = routing.routes.airtime[1] || 'none';
    }
  } catch (err) {
    console.warn('[feature-controls] Could not read persisted utilities controls:', err);
  }
  return { ...utilitiesControls };
}

export async function updateUtilitiesControls(
  patch: Partial<UtilitiesControls>,
  updatedBy = 'admin'
): Promise<UtilitiesControls> {
  const current = await getUtilitiesControls();
  utilitiesControls = {
    ...current,
    ...patch,
    updatedAt: nowIso(),
    updatedBy,
  };
  await createAuditLog({
    actorType: 'admin',
    actorId: updatedBy,
    action: 'utilities.controls.updated',
    resourceType: 'utilities_controls',
    resourceId: 'global',
    severity: 'info',
    metadata: { settings: utilitiesControls },
  }).catch((err) => {
    console.warn('[feature-controls] Failed to persist utilities controls audit log:', err);
  });
  return { ...utilitiesControls };
}

export async function getPublicFeatureStatus() {
  return {
    moneygram: {
      enabled: moneyGramControls.enabled && !moneyGramControls.maintenanceMode,
      minipayEnabled: moneyGramControls.enabled && moneyGramControls.minipayEnabled && !moneyGramControls.maintenanceMode,
      telegramEnabled: moneyGramControls.enabled && moneyGramControls.telegramEnabled && !moneyGramControls.maintenanceMode,
      whatsappEnabled: moneyGramControls.enabled && moneyGramControls.whatsappEnabled && !moneyGramControls.maintenanceMode,
      webappEnabled: moneyGramControls.enabled && moneyGramControls.webappEnabled && !moneyGramControls.maintenanceMode,
      maintenanceMode: moneyGramControls.maintenanceMode,
      maintenanceReason: moneyGramControls.maintenanceReason,
      corridors: moneyGramControls.corridors,
      platformFeePercent: moneyGramControls.platformFeePercent,
      minAmountUsdc: moneyGramControls.minAmountUsdc,
      maxAmountUsdc: moneyGramControls.maxAmountUsdc,
      cashInMinAmountUsdc: moneyGramControls.cashInMinAmountUsdc ?? moneyGramControls.minAmountUsdc ?? 5,
      cashInMaxAmountUsdc: moneyGramControls.cashInMaxAmountUsdc ?? 950,
    },
    utilities: {
      enabled: utilitiesControls.enabled && !utilitiesControls.maintenanceMode,
      airtimeEnabled: utilitiesControls.enabled && utilitiesControls.airtimeEnabled && !utilitiesControls.maintenanceMode,
      dataEnabled: utilitiesControls.enabled && utilitiesControls.dataEnabled && !utilitiesControls.maintenanceMode,
      electricityEnabled: utilitiesControls.enabled && utilitiesControls.electricityEnabled && !utilitiesControls.maintenanceMode,
      cableTvEnabled: utilitiesControls.enabled && utilitiesControls.cableTvEnabled && !utilitiesControls.maintenanceMode,
      maintenanceMode: utilitiesControls.maintenanceMode,
      maintenanceReason: utilitiesControls.maintenanceReason,
      discountPercent: utilitiesControls.discountPercent,
    }
  };
}

export async function listMoneyGramTransactions(userAddressOrId?: string): Promise<MoneyGramTransactionRecord[]> {
  if (userAddressOrId) {
    const normalized = userAddressOrId.toLowerCase();
    return moneyGramTransactions.filter(
      (tx) => tx.userAddressOrId.toLowerCase() === normalized
    );
  }
  return [...moneyGramTransactions];
}

export async function recordMoneyGramTransaction(
  tx: Omit<MoneyGramTransactionRecord, 'createdAt' | 'updatedAt'>
): Promise<MoneyGramTransactionRecord> {
  const existingIdx = moneyGramTransactions.findIndex((t) => t.id === tx.id);
  const now = nowIso();
  if (existingIdx >= 0) {
    const updated: MoneyGramTransactionRecord = {
      ...moneyGramTransactions[existingIdx],
      ...tx,
      updatedAt: now,
    };
    moneyGramTransactions[existingIdx] = updated;
    return updated;
  }
  const created: MoneyGramTransactionRecord = {
    ...tx,
    createdAt: now,
    updatedAt: now,
  };
  moneyGramTransactions.unshift(created);
  return created;
}

export async function listUtilitiesTransactions(userAddressOrId?: string): Promise<UtilityTransactionRecord[]> {
  const dbTxList = await db.listVirtualAccountTransactions().catch(() => []);
  const mappedDbRecords: UtilityTransactionRecord[] = dbTxList
    .filter((tx) => (tx.paymentRail || '').startsWith('utility_'))
    .map((tx) => {
      const parts = (tx.paymentRail || '').split('_');
      // paymentRail format: utility_{provider}_{serviceType}
      const provider = parts[1] || tx.provider || 'unknown';
      const category = (parts[2] || 'airtime') as UtilityTransactionRecord['category'];
      const rawPayload = (tx.rawPayload || {}) as any;
      const accountOrPhone = String(
        rawPayload?.phone ||
        rawPayload?.meterNumber ||
        rawPayload?.recipientOrMeter ||
        rawPayload?.accountOrPhone ||
        'N/A'
      );
      const absAmountNgn = Math.abs(Number(tx.sourceAmount || tx.destinationAmount || 0));
      return {
        id: tx.depositId || tx.id,
        category,
        provider,
        serviceId: tx.depositReference || 'unknown',
        accountOrPhone,
        amountNgn: absAmountNgn,
        amountUsdc: Math.round((absAmountNgn / 1600) * 100) / 100,
        channel: 'webapp',
        userAddressOrId: tx.userId || 'N/A',
        tokenOrReceipt: rawPayload?.token || rawPayload?.receipt || tx.depositReference,
        status: tx.status === 'completed' ? 'success' : (tx.status === 'failed' ? 'failed' : 'pending'),
        createdAt: tx.createdAt,
      };
    });

  const merged = [...utilityTransactions, ...mappedDbRecords];
  const seen = new Set<string>();
  const deduplicated: UtilityTransactionRecord[] = [];
  for (const item of merged) {
    if (!seen.has(item.id)) {
      seen.add(item.id);
      deduplicated.push(item);
    }
  }

  deduplicated.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  if (userAddressOrId) {
    const normalized = userAddressOrId.toLowerCase().trim();
    return deduplicated.filter(
      (tx) => tx.userAddressOrId.toLowerCase().trim() === normalized
    );
  }
  return deduplicated;
}

export async function recordUtilityTransaction(
  tx: Omit<UtilityTransactionRecord, 'createdAt'>
): Promise<UtilityTransactionRecord> {
  const created: UtilityTransactionRecord = {
    ...tx,
    createdAt: nowIso(),
  };
  utilityTransactions.unshift(created);
  return created;
}
