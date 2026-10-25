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

  async listDataPlans(operator: TelcoOperator): Promise<DataPlanOption[]> {
    const plans: Record<TelcoOperator, DataPlanOption[]> = {
      mtn: [
        { planId: 'mtn_500mb', name: 'MTN SME 500MB', size: '500MB', validity: '30 Days', wholesalePriceNgn: 130, retailPriceNgn: 160, operator: 'mtn', type: 'sme' },
        { planId: 'mtn_1gb', name: 'MTN SME 1GB', size: '1GB', validity: '30 Days', wholesalePriceNgn: 245, retailPriceNgn: 290, operator: 'mtn', type: 'sme' },
        { planId: 'mtn_2gb', name: 'MTN SME 2GB', size: '2GB', validity: '30 Days', wholesalePriceNgn: 490, retailPriceNgn: 580, operator: 'mtn', type: 'sme' },
        { planId: 'mtn_5gb', name: 'MTN SME 5GB', size: '5GB', validity: '30 Days', wholesalePriceNgn: 1225, retailPriceNgn: 1400, operator: 'mtn', type: 'sme' },
        { planId: 'mtn_10gb', name: 'MTN SME 10GB', size: '10GB', validity: '30 Days', wholesalePriceNgn: 2450, retailPriceNgn: 2800, operator: 'mtn', type: 'sme' },
      ],
      airtel: [
        { planId: 'airtel_500mb', name: 'Airtel Gifting 500MB', size: '500MB', validity: '30 Days', wholesalePriceNgn: 140, retailPriceNgn: 175, operator: 'airtel', type: 'corporate_gifting' },
        { planId: 'airtel_1gb', name: 'Airtel Gifting 1GB', size: '1GB', validity: '30 Days', wholesalePriceNgn: 260, retailPriceNgn: 310, operator: 'airtel', type: 'corporate_gifting' },
        { planId: 'airtel_2gb', name: 'Airtel Gifting 2GB', size: '2GB', validity: '30 Days', wholesalePriceNgn: 520, retailPriceNgn: 620, operator: 'airtel', type: 'corporate_gifting' },
        { planId: 'airtel_5gb', name: 'Airtel Gifting 5GB', size: '5GB', validity: '30 Days', wholesalePriceNgn: 1300, retailPriceNgn: 1500, operator: 'airtel', type: 'corporate_gifting' },
        { planId: 'airtel_10gb', name: 'Airtel Gifting 10GB', size: '10GB', validity: '30 Days', wholesalePriceNgn: 2600, retailPriceNgn: 3000, operator: 'airtel', type: 'corporate_gifting' },
      ],
      glo: [
        { planId: 'glo_500mb', name: 'Glo SME 500MB', size: '500MB', validity: '30 Days', wholesalePriceNgn: 135, retailPriceNgn: 165, operator: 'glo', type: 'sme' },
        { planId: 'glo_1gb', name: 'Glo SME 1GB', size: '1GB', validity: '30 Days', wholesalePriceNgn: 250, retailPriceNgn: 300, operator: 'glo', type: 'sme' },
        { planId: 'glo_2gb', name: 'Glo SME 2GB', size: '2GB', validity: '30 Days', wholesalePriceNgn: 500, retailPriceNgn: 600, operator: 'glo', type: 'sme' },
        { planId: 'glo_5gb', name: 'Glo SME 5GB', size: '5GB', validity: '30 Days', wholesalePriceNgn: 1250, retailPriceNgn: 1450, operator: 'glo', type: 'sme' },
        { planId: 'glo_10gb', name: 'Glo SME 10GB', size: '10GB', validity: '30 Days', wholesalePriceNgn: 2500, retailPriceNgn: 2900, operator: 'glo', type: 'sme' },
      ],
      '9mobile': [
        { planId: '9mobile_500mb', name: '9mobile SME 500MB', size: '500MB', validity: '30 Days', wholesalePriceNgn: 120, retailPriceNgn: 150, operator: '9mobile', type: 'sme' },
        { planId: '9mobile_1gb', name: '9mobile SME 1GB', size: '1GB', validity: '30 Days', wholesalePriceNgn: 220, retailPriceNgn: 270, operator: '9mobile', type: 'sme' },
        { planId: '9mobile_2gb', name: '9mobile SME 2GB', size: '2GB', validity: '30 Days', wholesalePriceNgn: 440, retailPriceNgn: 540, operator: '9mobile', type: 'sme' },
        { planId: '9mobile_5gb', name: '9mobile SME 5GB', size: '5GB', validity: '30 Days', wholesalePriceNgn: 1100, retailPriceNgn: 1350, operator: '9mobile', type: 'sme' },
        { planId: '9mobile_10gb', name: '9mobile SME 10GB', size: '10GB', validity: '30 Days', wholesalePriceNgn: 2200, retailPriceNgn: 2700, operator: '9mobile', type: 'sme' },
      ],
    };
    return plans[operator] || plans.mtn;
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
