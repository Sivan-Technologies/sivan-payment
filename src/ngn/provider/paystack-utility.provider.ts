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
  paystackMode,
} from '../../config/paystackConfig.js';
import type {
  TelcoOperator,
  DiscoCode,
  MeterType,
  ElectricityInquiryResponse,
} from '../types/paystackUtilityTypes.js';
import type {
  IUtilityProvider,
  UtilityProviderName,
  ProviderAirtimeResult,
  ProviderDataResult,
  ProviderElectricityResult,
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
  operator: TelcoOperator
): Promise<ProviderAirtimeResult> {
  const reference = `airtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // In test mode, return deterministic sandbox fulfillment
  if (paystackMode() === 'test') {
    return {
      reference,
      amountNgn,
      phone,
      operator,
      status: 'success',
      message: `${operator.toUpperCase()} ${amountNgn} NGN airtime successfully delivered to ${phone}`,
      rawPayload: { mode: 'test', operator, phone, amountNgn, reference },
    };
  }

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
  operator: TelcoOperator
): Promise<ProviderDataResult> {
  const reference = `data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (paystackMode() === 'test') {
    return {
      reference,
      amountNgn,
      phone,
      operator,
      planCode,
      status: 'success',
      message: `${operator.toUpperCase()} data bundle (${planCode}) credited to ${phone}`,
      rawPayload: { mode: 'test', operator, phone, planCode, amountNgn, reference },
    };
  }

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
  if (paystackMode() === 'test') {
    return {
      meterNumber,
      disco,
      discoName: disco.toUpperCase(),
      meterType,
      customerName: 'ADEKUNLE OLA (SIVAN TEST HOLDER)',
      customerAddress: '14 Bwari Road, Kubwa, Abuja',
      minimumAmountNgn: 1000,
    };
  }

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
  customerName?: string
): Promise<ProviderElectricityResult> {
  const reference = `disco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  if (paystackMode() === 'test') {
    const token = '4521-8930-1124-7839-9021';
    const units = `${(amountNgn / 110).toFixed(1)} kWh`;

    return {
      reference,
      amountNgn,
      meterNumber,
      disco,
      meterType,
      customerName: customerName || 'ADEKUNLE OLA (SIVAN TEST HOLDER)',
      token: meterType === 'prepaid' ? token : undefined,
      units: meterType === 'prepaid' ? units : undefined,
      status: 'success',
      message: `Electricity payment of ${amountNgn} NGN successful`,
      rawPayload: { mode: 'test', meterNumber, disco, amountNgn, token, units },
    };
  }

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

  async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator
  ): Promise<ProviderAirtimeResult> {
    return purchaseAirtime(phone, amountNgn, operator);
  }

  async purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator
  ): Promise<ProviderDataResult> {
    return purchaseDataBundle(phone, planCode, amountNgn, operator);
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
    customerName?: string
  ): Promise<ProviderElectricityResult> {
    return payElectricityBill(meterNumber, disco, meterType, amountNgn, customerName);
  }
}
