import { nowIso } from '../shared/id.js';
import { MONEYGRAM_GLOBAL_CORRIDORS } from '../moneygram/data/corridors.data.js';

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
  primaryProvider: 'vtpass' | 'baxi' | 'reloadly';
  fallbackProvider: 'vtpass' | 'baxi' | 'reloadly' | 'none';
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
  cableTvEnabled: true,
  primaryProvider: 'vtpass',
  fallbackProvider: 'baxi',
  maintenanceMode: false,
  maintenanceReason: 'Bill payment aggregators undergoing scheduled maintenance.',
  discountPercent: 1.0,
  updatedAt: nowIso(),
  updatedBy: 'system',
};

const moneyGramTransactions: MoneyGramTransactionRecord[] = [
  {
    id: 'mg_tx_1727781001',
    mode: 'withdraw',
    amountUsdc: 25.00,
    targetCurrency: 'NGN',
    targetAmount: 40500,
    channel: 'minipay',
    userAddressOrId: '0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc',
    pickupPin: '4829-1049',
    status: 'ready_for_pickup',
    moreInfoUrl: 'https://ext-stellar.moneygram.com/stellarsepservice/sep24/transaction/more_info?id=mg_tx_1727781001',
    createdAt: new Date(Date.now() - 3600000).toISOString(),
    updatedAt: new Date(Date.now() - 1800000).toISOString(),
  },
  {
    id: 'mg_tx_1727778500',
    mode: 'withdraw',
    amountUsdc: 45.00,
    targetCurrency: 'KES',
    targetAmount: 5841,
    channel: 'telegram',
    userAddressOrId: 'tg_9827104',
    pickupPin: '9012-7741',
    status: 'completed',
    moreInfoUrl: 'https://ext-stellar.moneygram.com/stellarsepservice/sep24/transaction/more_info?id=mg_tx_1727778500',
    createdAt: new Date(Date.now() - 86400000).toISOString(),
    updatedAt: new Date(Date.now() - 82800000).toISOString(),
  },
  {
    id: 'mg_tx_1727764200',
    mode: 'deposit',
    amountUsdc: 30.00,
    targetCurrency: 'GHS',
    targetAmount: 465,
    channel: 'whatsapp',
    userAddressOrId: 'wa_233501234567',
    status: 'completed',
    moreInfoUrl: 'https://ext-stellar.moneygram.com/stellarsepservice/sep24/transaction/more_info?id=mg_tx_1727764200',
    createdAt: new Date(Date.now() - 172800000).toISOString(),
    updatedAt: new Date(Date.now() - 172000000).toISOString(),
  }
];

const utilityTransactions: UtilityTransactionRecord[] = [
  {
    id: 'util_98124',
    category: 'airtime',
    provider: 'vtpass',
    serviceId: 'mtn',
    accountOrPhone: '08031234567',
    amountNgn: 2000,
    amountUsdc: 1.25,
    channel: 'telegram',
    userAddressOrId: 'tg_9827104',
    tokenOrReceipt: 'RC-99881122',
    status: 'success',
    createdAt: new Date(Date.now() - 7200000).toISOString(),
  },
  {
    id: 'util_98125',
    category: 'electricity',
    provider: 'vtpass',
    serviceId: 'ikeja-electric',
    accountOrPhone: '11029482910',
    amountNgn: 10000,
    amountUsdc: 6.20,
    channel: 'minipay',
    userAddressOrId: '0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc',
    tokenOrReceipt: 'TOKEN: 4892-1092-4820-1940-2810',
    status: 'success',
    createdAt: new Date(Date.now() - 14400000).toISOString(),
  }
];

export async function getMoneyGramControls(): Promise<MoneyGramControls> {
  return { ...moneyGramControls };
}

export async function updateMoneyGramControls(
  patch: Partial<MoneyGramControls>,
  updatedBy = 'admin'
): Promise<MoneyGramControls> {
  moneyGramControls = {
    ...moneyGramControls,
    ...patch,
    updatedAt: nowIso(),
    updatedBy,
  };
  return { ...moneyGramControls };
}

export async function getUtilitiesControls(): Promise<UtilitiesControls> {
  return { ...utilitiesControls };
}

export async function updateUtilitiesControls(
  patch: Partial<UtilitiesControls>,
  updatedBy = 'admin'
): Promise<UtilitiesControls> {
  utilitiesControls = {
    ...utilitiesControls,
    ...patch,
    updatedAt: nowIso(),
    updatedBy,
  };
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
  if (userAddressOrId) {
    const normalized = userAddressOrId.toLowerCase();
    return utilityTransactions.filter(
      (tx) => tx.userAddressOrId.toLowerCase() === normalized
    );
  }
  return [...utilityTransactions];
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
