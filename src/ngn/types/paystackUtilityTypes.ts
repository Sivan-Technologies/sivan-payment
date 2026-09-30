/**
 * SIVAN PAYSTACK UTILITY TYPES
 *
 * Domain types for telco airtime, mobile data bundles,
 * electricity DisCo billing, and conversational receipts.
 */

export type TelcoOperator = 'mtn' | 'airtel' | 'glo' | '9mobile';

export type DiscoCode =
  | 'ikeja'
  | 'eko'
  | 'abuja'
  | 'ibadan'
  | 'enugu'
  | 'kano'
  | 'port-harcourt'
  | 'benin'
  | 'jos'
  | 'kaduna'
  | 'yola';

export type MeterType = 'prepaid' | 'postpaid';

export interface AirtimePurchaseRequest {
  userId: string;
  phone: string;
  amountNgn: number;
  operator?: TelcoOperator;
  providerName?: string;
}

export interface DataBundlePurchaseRequest {
  userId: string;
  phone: string;
  operator?: TelcoOperator;
  planCode: string;
  amountNgn: number;
  providerName?: string;
}

export interface ElectricityInquiryRequest {
  userId: string;
  meterNumber: string;
  disco: DiscoCode;
  meterType: MeterType;
  providerName?: string;
}

export interface ElectricityInquiryResponse {
  meterNumber: string;
  disco: DiscoCode;
  discoName: string;
  meterType: MeterType;
  customerName: string;
  customerAddress?: string;
  minimumAmountNgn: number;
  providerName?: string;
}

export interface ElectricityPaymentRequest {
  userId: string;
  meterNumber: string;
  disco: DiscoCode;
  meterType: MeterType;
  amountNgn: number;
  customerName?: string;
  providerName?: string;
}

export interface UtilityReceipt {
  success: boolean;
  serviceType: 'airtime' | 'data' | 'electricity';
  providerName: string;
  operatorOrDisco: string;
  recipientOrMeter: string;
  customerName?: string;
  token?: string; // 20-digit prepaid electricity token
  units?: string; // e.g. "48.5 kWh"
  amountNgn: number;
  feeNgn: number;
  totalDebitedNgn: number;
  reference: string;
  timestamp: string;
  formattedText: string;
}

/**
 * Known prefix map for Nigerian mobile network operators.
 */
const TELCO_PREFIX_MAP: Record<string, TelcoOperator> = {
  // MTN
  '0803': 'mtn',
  '0806': 'mtn',
  '0810': 'mtn',
  '0813': 'mtn',
  '0814': 'mtn',
  '0816': 'mtn',
  '0703': 'mtn',
  '0706': 'mtn',
  '0903': 'mtn',
  '0906': 'mtn',
  '0913': 'mtn',
  '0916': 'mtn',

  // Airtel
  '0802': 'airtel',
  '0808': 'airtel',
  '0812': 'airtel',
  '0701': 'airtel',
  '0708': 'airtel',
  '0901': 'airtel',
  '0902': 'airtel',
  '0904': 'airtel',
  '0907': 'airtel',
  '0912': 'airtel',

  // Glo
  '0805': 'glo',
  '0807': 'glo',
  '0811': 'glo',
  '0815': 'glo',
  '0705': 'glo',
  '0905': 'glo',
  '0915': 'glo',

  // 9mobile
  '0809': '9mobile',
  '0817': '9mobile',
  '0818': '9mobile',
  '0908': '9mobile',
  '0909': '9mobile',
};

/**
 * Detects the telco network from a Nigerian phone number.
 */
export function detectTelcoOperator(phone: string): TelcoOperator | undefined {
  if (!phone) return undefined;
  // Normalize phone to 080... format
  let clean = phone.replace(/^whatsapp:/i, '').replace(/\s+/g, '').replace(/[-()]/g, '');
  if (clean.startsWith('+234')) {
    clean = '0' + clean.slice(4);
  } else if (clean.startsWith('234')) {
    clean = '0' + clean.slice(3);
  }

  const prefix = clean.slice(0, 4);
  return TELCO_PREFIX_MAP[prefix];
}

/**
 * Normalizes phone number to standard Nigerian domestic format (e.g. 08102524846).
 */
export function normalizeDomesticPhone(phone: string): string {
  let clean = phone.replace(/^whatsapp:/i, '').replace(/\s+/g, '').replace(/[-()]/g, '');
  if (clean.startsWith('+234')) {
    clean = '0' + clean.slice(4);
  } else if (clean.startsWith('234')) {
    clean = '0' + clean.slice(3);
  }
  return clean;
}

export const DISCO_DISPLAY_NAMES: Record<DiscoCode, string> = {
  ikeja: 'Ikeja Electric (IKEDC)',
  eko: 'Eko Electric (EKEDC)',
  abuja: 'Abuja Electricity (AEDC)',
  ibadan: 'Ibadan Electricity (IBEDC)',
  enugu: 'Enugu Electricity (EEDC)',
  kano: 'Kano Electricity (KEDCO)',
  'port-harcourt': 'Port Harcourt Electric (PHED)',
  benin: 'Benin Electricity (BEDC)',
  jos: 'Jos Electricity (JEDC)',
  kaduna: 'Kaduna Electric (KAEDCO)',
  yola: 'Yola Electricity (YEDC)',
};
