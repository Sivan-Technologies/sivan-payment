/**
 * SIVAN GENERIC VTU AGGREGATOR PROVIDER
 *
 * Plug-and-play adapter for any Nigerian VTU aggregator API (e.g. VTpass, Clubkonnect, Reloadly, Bilals).
 * Sourced dynamically via AGGREGATOR_BASE_URL and AGGREGATOR_SECRET_KEY.
 *
 * Can be plugged in with zero core logic changes:
 *   registerUtilityProvider(new VtuAggregatorProvider({ baseUrl, apiKey }))
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

export interface VtuAggregatorConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  priority?: number;
}

export class VtuAggregatorProvider implements IUtilityProvider {
  readonly name: UtilityProviderName;
  readonly priority: number;
  readonly supports: readonly UtilityServiceType[] = ['airtime', 'data', 'electricity'];
  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: VtuAggregatorConfig = {}) {
    this.name = config.name || 'vtu_ng';
    this.priority = config.priority ?? 15;
    this.baseUrl = (config.baseUrl || process.env.AGGREGATOR_BASE_URL || 'https://api.vtu-aggregator.ng/v1').replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.AGGREGATOR_SECRET_KEY || '';
  }

  /** No key means no real vending, so do not let the UI present this as a choice. */
  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  /**
   * An unconfigured provider must fail, not pretend.
   *
   * Each method below used to fall through to a hand-built success object
   * when no API key was present. With no key set that meant a customer was
   * debited and nothing was ever vended. Those fabricated branches, and the
   * invented price catalogue listDataPlans served when the upstream call
   * failed, have now been deleted: every method calls this first and refuses.
   */
  private requireKey(): void {
    if (!this.apiKey) {
      throw new Error(
        `Aggregator "${this.name}" has no API key configured. Set AGGREGATOR_SECRET_KEY before routing traffic to it.`
      );
    }
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
    };
  }

  async listDataPlans(operator: TelcoOperator): Promise<DataPlanOption[]> {
    this.requireKey();
    const res = await fetch(`${this.baseUrl}/data/plans?operator=${encodeURIComponent(operator)}`, {
      headers: this.headers(),
      signal: AbortSignal.timeout(10_000),
    });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body?.data)) {
      throw new Error(
        `Aggregator "${this.name}" returned no data plan catalogue for ${operator}. ` +
          `Refusing to quote a price this provider did not supply.`
      );
    }
    return body.data.map((p: any) => ({
      planId: String(p.planId || p.id),
      name: String(p.name || `${operator.toUpperCase()} ${p.size || ''}`),
      size: String(p.size || '1GB'),
      validity: String(p.validity || '30 Days'),
      wholesalePriceNgn: Number(p.wholesalePriceNgn || p.price || 0),
      retailPriceNgn: Number(p.retailPriceNgn || p.price || 0),
      operator,
      type: (p.type as any) || 'sme',
    }));
  }

  async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderAirtimeResult> {
    this.requireKey();
    const reference = `vtu_air_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${this.baseUrl}/airtime/vend`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ phone, amount: amountNgn, operator, reference }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false || data.status === 'failed') {
      throw new Error(data.message || `Aggregator ${this.name} airtime fulfillment failed`);
    }
    return {
      reference: data.reference || reference,
      amountNgn,
      phone,
      operator,
      status: 'success',
      message: data.message || 'Airtime delivered successfully',
      rawPayload: data,
    };
  }

  async purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderDataResult> {
    this.requireKey();
    const reference = `vtu_dat_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${this.baseUrl}/data/vend`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ phone, planCode, amount: amountNgn, operator, reference }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false || data.status === 'failed') {
      throw new Error(data.message || `Aggregator ${this.name} data bundle fulfillment failed`);
    }
    return {
      reference: data.reference || reference,
      amountNgn,
      phone,
      operator,
      planCode,
      status: 'success',
      message: data.message || 'Data bundle activated successfully',
      rawPayload: data,
    };
  }

  async inquireElectricityMeter(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse> {
    this.requireKey();
    const res = await fetch(`${this.baseUrl}/electricity/validate`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ meterNumber, disco, meterType }),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) {
      throw new Error(data.message || `Failed to validate meter ${meterNumber} on ${disco}`);
    }
    return {
      meterNumber,
      disco,
      discoName: data.discoName || `${disco.toUpperCase()} ELECTRIC`,
      meterType,
      customerName: data.customerName || 'Verified Consumer',
      customerAddress: data.customerAddress || 'Address on file',
      minimumAmountNgn: Number(data.minimumAmountNgn || 1000),
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
    this.requireKey();
    const reference = `vtu_elec_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${this.baseUrl}/electricity/vend`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ meterNumber, disco, meterType, amount: amountNgn, reference, customerName }),
      signal: AbortSignal.timeout(20_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false || data.status === 'failed') {
      throw new Error(data.message || `Failed to vend electricity on ${disco}`);
    }
    return {
      reference: data.reference || reference,
      amountNgn,
      meterNumber,
      disco,
      meterType,
      customerName: data.customerName || customerName || 'Verified Consumer',
      token: data.token,
      units: data.units ? `${data.units} kWh` : undefined,
      status: 'success',
      message: 'Electricity recharge confirmed',
      rawPayload: data,
    };
  }

  async getAirtimeCashRate(operator: TelcoOperator): Promise<AirtimeCashRate> {
    this.requireKey();
    return {
      operator,
      rate: 0.82,
      percent: '82%',
      minAmountNgn: 1000,
      maxAmountNgn: 20000,
    };
  }

  async initiateAirtimeToCash(input: AirtimeCashInitiateInput): Promise<AirtimeCashInitiateResult> {
    this.requireKey();
    const rateObj = await this.getAirtimeCashRate(input.operator);
    const payoutAmountNgn = Math.round(input.amountNgn * rateObj.rate);
    const sessionId = `aircash_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${this.baseUrl}/airtime/initiate`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false) {
      throw new Error(data.message || 'Failed to initiate airtime conversion');
    }
    return {
      sessionId: data.sessionId || sessionId,
      rate: Number(data.rate || rateObj.rate),
      payoutAmountNgn: Number(data.payoutAmountNgn || payoutAmountNgn),
      message: data.message || `OTP sent to ${input.phone}`,
      rawPayload: data,
    };
  }

  async confirmAirtimeToCash(input: AirtimeCashConfirmInput): Promise<AirtimeCashConfirmResult> {
    this.requireKey();
    const reference = `aircash_conf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const res = await fetch(`${this.baseUrl}/airtime/debit`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15_000),
    });
    const data: any = await res.json().catch(() => ({}));
    if (!res.ok || data.status === false || data.status === 'failed') {
      throw new Error(data.message || 'Failed to confirm airtime conversion');
    }
    return {
      reference: data.reference || reference,
      creditedAmountNgn: Number(data.creditedAmount || 0),
      status: 'success',
      message: data.message || 'Airtime converted successfully',
      rawPayload: data,
    };
  }
}
