/**
 * SIVAN MOCK / FALLBACK UTILITY PROVIDER
 *
 * Emulates instant airtime, data bundle, and electricity fulfillment
 * without external network roundtrips. Used for hermetic tests and sandbox dev.
 */

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

export class MockUtilityProvider implements IUtilityProvider {
  readonly name: UtilityProviderName = 'mock'; // simulator - registered only when UTILITY_ENABLE_MOCK_PROVIDER=true
  readonly priority = 5;
  readonly supports: readonly UtilityServiceType[] = ['airtime', 'data', 'electricity'];

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

  async getAirtimeCashRate(operator: TelcoOperator): Promise<AirtimeCashRate> {
    const rates: Record<TelcoOperator, number> = {
      mtn: 0.85,
      airtel: 0.82,
      glo: 0.78,
      '9mobile': 0.75,
    };
    const rate = rates[operator] || 0.80;
    return {
      operator,
      rate,
      percent: `${Math.round(rate * 100)}%`,
      minAmountNgn: 1000,
      maxAmountNgn: 20000,
    };
  }

  async initiateAirtimeToCash(input: AirtimeCashInitiateInput): Promise<AirtimeCashInitiateResult> {
    const rateObj = await this.getAirtimeCashRate(input.operator);
    const payoutAmountNgn = Math.round(input.amountNgn * rateObj.rate);
    const sessionId = `aircash_sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      sessionId,
      rate: rateObj.rate,
      payoutAmountNgn,
      message: `OTP sent to ${input.phone}. Please submit OTP to confirm conversion of ${input.amountNgn} NGN to ${payoutAmountNgn} NGN cash.`,
      rawPayload: { provider: 'mock', sessionId, input },
    };
  }

  async confirmAirtimeToCash(input: AirtimeCashConfirmInput): Promise<AirtimeCashConfirmResult> {
    const reference = `aircash_tx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      creditedAmountNgn: 8200,
      status: 'success',
      message: 'Airtime converted successfully and credited to wallet.',
      rawPayload: { provider: 'mock', reference, sessionId: input.sessionId },
    };
  }

  async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderAirtimeResult> {
    const reference = `mock_airtime_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      amountNgn,
      phone,
      operator,
      status: 'success',
      message: `[MOCK] ${operator.toUpperCase()} ${amountNgn} NGN airtime delivered to ${phone}`,
      rawPayload: { provider: 'mock', phone, operator, amountNgn, reference },
    };
  }

  async purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderDataResult> {
    const reference = `mock_data_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      amountNgn,
      phone,
      operator,
      planCode,
      status: 'success',
      message: `[MOCK] ${operator.toUpperCase()} data plan ${planCode} activated on ${phone}`,
      rawPayload: { provider: 'mock', phone, operator, planCode, amountNgn, reference },
    };
  }

  async inquireElectricityMeter(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse> {
    return {
      meterNumber,
      disco,
      discoName: `${disco.toUpperCase()} ELECTRIC (MOCK)`,
      meterType,
      customerName: 'SIVAN TEST CONSUMER',
      customerAddress: 'Plot 4, Commercial Avenue, Abuja',
      minimumAmountNgn: 1000,
    };
  }

  async payElectricityBill(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType,
    amountNgn: number,
    customerName: string | undefined,
    idempotencyKey: string
  ): Promise<ProviderElectricityResult> {
    const reference = `mock_disco_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    return {
      reference,
      amountNgn,
      meterNumber,
      disco,
      meterType,
      customerName: customerName || 'SIVAN TEST CONSUMER',
      token: meterType === 'prepaid' ? '9988-7766-5544-3322-1100' : undefined,
      units: meterType === 'prepaid' ? `${(amountNgn / 110).toFixed(1)} kWh` : undefined,
      status: 'success',
      message: `[MOCK] Electricity recharge of ${amountNgn} NGN successful`,
      rawPayload: { provider: 'mock', meterNumber, disco, amountNgn, reference },
    };
  }
}
