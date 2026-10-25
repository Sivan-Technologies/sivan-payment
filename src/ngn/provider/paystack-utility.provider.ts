/**
 * SIVAN PAYSTACK UTILITY PROVIDER
 *
 * Direct REST client for Paystack utility rails:
 * - Telco Airtime Topup
 * - Mobile Internet Data Bundles
 * - Electricity DisCo Meter Validation & Token Generation
 *
 * Implements IUtilityProvider so Sivan payment Ai is never vendor-locked.
 */

import {
  paystackBaseUrl,
  paystackHeaders,
  isPaystackConfigured,
} from '../../config/paystackConfig.js';
import type {
  TelcoOperator,
  DiscoCode,
  MeterType,
  ElectricityInquiryResponse,
  DataPlanOption,
  AirtimeCashRate,
} from '../types/paystackUtilityTypes.js';
import type {
  IUtilityProvider,
  UtilityProviderName,
  UtilityServiceType,
  ProviderAirtimeResult,
  ProviderDataResult,
  ProviderElectricityResult,
  AirtimeCashInitiateInput,
  AirtimeCashInitiateResult,
  AirtimeCashConfirmInput,
  AirtimeCashConfirmResult,
} from './utility-provider.interface.js';

export {
  ProviderAirtimeResult,
  ProviderDataResult,
  ProviderElectricityResult,
};

export class PaystackUtilityApiError extends Error {
  constructor(
    message: string,
    readonly endpoint: string,
    readonly httpStatus: number,
    readonly paystackMessage?: string
  ) {
    super(message);
    this.name = 'PaystackUtilityApiError';
  }
}

async function postPaystack<T>(path: string, payload: unknown): Promise<T> {
  const url = `${paystackBaseUrl()}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: paystackHeaders(),
    body: JSON.stringify(payload),
  });

  const body = (await response.json().catch(() => ({}))) as any;
  if (!response.ok || body.status === false) {
    throw new PaystackUtilityApiError(
      body.message || `Paystack utility API call failed with HTTP ${response.status}`,
      path,
      response.status,
      body.message
    );
  }
  return body.data as T;
}

/**
 * Purchases mobile airtime through Paystack telco rail.
 */
export async function purchaseAirtime(
  phone: string,
  amountNgn: number,
  operator: TelcoOperator,
    idempotencyKey: string
): Promise<ProviderAirtimeResult> {
  const reference = `airtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const payload = {
    phone,
    amount: amountNgn * 100, // Paystack operates in Kobo
    service_type: operator,
    reference,
  };

  const data = await postPaystack<any>('/bill/charge', payload);
  return {
    reference: data.reference || reference,
    amountNgn,
    phone,
    operator,
    status: 'success',
    message: `${operator.toUpperCase()} airtime delivered successfully`,
    rawPayload: data,
  };
}

/**
 * Purchases mobile data bundle through Paystack rail.
 */
export async function purchaseDataBundle(
  phone: string,
  planCode: string,
  amountNgn: number,
  operator: TelcoOperator,
    idempotencyKey: string
): Promise<ProviderDataResult> {
  const reference = `data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const payload = {
    phone,
    amount: amountNgn * 100,
    service_type: `${operator}_data`,
    plan: planCode,
    reference,
  };

  const data = await postPaystack<any>('/bill/charge', payload);
  return {
    reference: data.reference || reference,
    amountNgn,
    phone,
    operator,
    planCode,
    status: 'success',
    message: `${operator.toUpperCase()} data bundle activated successfully`,
    rawPayload: data,
  };
}

/**
 * Validates electricity meter and fetches customer name before purchase.
 */
export async function inquireElectricityMeter(
  meterNumber: string,
  disco: DiscoCode,
  meterType: MeterType
): Promise<ElectricityInquiryResponse> {
  const url = `${paystackBaseUrl()}/bill/validate?meter_number=${encodeURIComponent(meterNumber)}&service_type=${encodeURIComponent(disco)}&type=${encodeURIComponent(meterType)}`;
  const response = await fetch(url, {
    method: 'GET',
    headers: paystackHeaders(),
  });

  const body = (await response.json().catch(() => ({}))) as any;
  if (!response.ok || body.status === false) {
    throw new PaystackUtilityApiError(
      body.message || 'Unable to verify meter number with DisCo',
      '/bill/validate',
      response.status,
      body.message
    );
  }

  const data = body.data || {};
  return {
    meterNumber,
    disco,
    discoName: data.provider_name || disco.toUpperCase(),
    meterType,
    customerName: data.customer_name || 'Verified Customer',
    customerAddress: data.address,
    minimumAmountNgn: Number(data.minimum_amount || 1000),
  };
}

/**
 * Purchases electricity units and generates a 20-digit token for prepaid meters.
 */
export async function payElectricityBill(
  meterNumber: string,
  disco: DiscoCode,
  meterType: MeterType,
  amountNgn: number,
  customerName: string | undefined,
    idempotencyKey: string
): Promise<ProviderElectricityResult> {
  const reference = `disco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const payload = {
    meter_number: meterNumber,
    amount: amountNgn * 100,
    service_type: disco,
    type: meterType,
    reference,
  };

  const data = await postPaystack<any>('/bill/charge', payload);
  return {
    reference: data.reference || reference,
    amountNgn,
    meterNumber,
    disco,
    meterType,
    customerName: data.customer_name || customerName || 'Verified Customer',
    token: data.token,
    units: data.units ? `${data.units} kWh` : undefined,
    status: 'success',
    message: 'Electricity payment confirmed',
    rawPayload: data,
  };
}

/**
 * Class implementation conforming to IUtilityProvider.
 */
export class PaystackUtilityProvider implements IUtilityProvider {
  readonly name: UtilityProviderName = 'paystack';
  readonly priority = 20;
  readonly supports: readonly UtilityServiceType[] = ['airtime', 'data', 'electricity'];

  isConfigured(): boolean {
    return isPaystackConfigured();
  }

  async getAirtimeCashRate(_operator: TelcoOperator): Promise<AirtimeCashRate> {
    throw new PaystackUtilityApiError(
      'Airtime to cash is not supported on Paystack rails',
      '/bill/airtime-cash',
      501
    );
  }

  async initiateAirtimeToCash(_input: AirtimeCashInitiateInput): Promise<AirtimeCashInitiateResult> {
    throw new PaystackUtilityApiError(
      'Airtime to cash is not supported on Paystack rails',
      '/bill/airtime-cash/initiate',
      501
    );
  }

  async confirmAirtimeToCash(_input: AirtimeCashConfirmInput): Promise<AirtimeCashConfirmResult> {
    throw new PaystackUtilityApiError(
      'Airtime to cash is not supported on Paystack rails',
      '/bill/airtime-cash/confirm',
      501
    );
  }

  async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderAirtimeResult> {
    return purchaseAirtime(phone, amountNgn, operator, idempotencyKey);
  }

  async purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderDataResult> {
    return purchaseDataBundle(phone, planCode, amountNgn, operator, idempotencyKey);
  }

  async inquireElectricityMeter(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse> {
    return inquireElectricityMeter(meterNumber, disco, meterType);
  }

  async payElectricityBill(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType,
    amountNgn: number,
    customerName: string | undefined,
    idempotencyKey: string
  ): Promise<ProviderElectricityResult> {
    return payElectricityBill(meterNumber, disco, meterType, amountNgn, customerName, idempotencyKey);
  }
}
