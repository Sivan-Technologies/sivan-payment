/**
 * SME API (smeapi.com.ng) UTILITY PROVIDER
 *
 * Airtime and data only. SME API sells no electricity, so `supports` omits it
 * and the registry will refuse to route a meter to this provider rather than
 * answering with a placeholder.
 *
 * Verified live against the public surface on 2026-10-24:
 *   GET  /api/dataplans/  -> 200, public, no token required.
 *                            { status: 'success',
 *                              data: [ { id, network_id, network, name, type, days, price } ] }
 *                            142 plans across MTN (network_id 1), GLO (2) and
 *                            AIRTEL (4). There is no 9mobile inventory, which
 *                            is why this provider rejects that operator rather
 *                            than guessing a network id.
 *   GET  /api/user/       -> wallet balance, token required.
 *   POST /api/airtime/    -> token required.
 *   POST /api/data/       -> token required.
 *
 * Auth: the upstream reads the Authorization header and validates the token
 * after stripping any scheme prefix. "Token <key>", "Bearer <key>" and a bare
 * key all reach the same validator, so the Django convention is used here.
 * Missing token returns { status: 'fail', msg: 'Your authorization token is
 * required.' } and a bad one returns 'Invalid or inactive authorization token.'
 *
 * PURCHASE PAYLOADS, CONFIRMED against the live API on 2026-10-24 by walking
 * the validation chain with a funded-but-empty wallet, so every field could be
 * checked without a purchase ever completing:
 *
 *   POST /api/airtime/  { network, amount, mobile_number }
 *     - the key is `network`, NOT `network_id`: sending network_id alone
 *       returns "Network Id Required", and an out-of-range value returns
 *       "The Network id is invalid"
 *     - omitting mobile_number returns "Phone Is Required"
 *     - omitting amount returns "Amount Is Required"
 *     - airtime_type is optional; the request succeeds without it
 *
 *   POST /api/data/     { network, mobile_number, plan }
 *     - the key is `plan`; `plan_id` returns "Data Plan ID Is Required"
 *     - `plan` carries the numeric id from /api/dataplans/
 *
 * A fully valid body stops at "Insufficient balance fund your wallet and try
 * again", which is how each field above was proven to pass validation.
 *
 * STILL UNVERIFIED: the success response body. The wallet holds 0.00 NGN, so
 * no purchase has ever returned 200 with a receipt. Reference extraction
 * falls back to the idempotency key, and nothing here fabricates a success -
 * any response that is not an explicit upstream success throws.
 */

import type {
  IUtilityProvider,
  UtilityProviderName,
  UtilityServiceType,
  ProviderAirtimeResult,
  ProviderDataResult,
} from './utility-provider.interface.js';
import type { TelcoOperator, DataPlanOption } from '../types/paystackUtilityTypes.js';

export interface SmeApiConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  priority?: number;
}

/** SME API network ids, taken from the live /api/dataplans/ response. */
const NETWORK_IDS: Partial<Record<TelcoOperator, number>> = {
  mtn: 1,
  glo: 2,
  airtel: 4,
};

/** SME API plan families mapped onto our own plan taxonomy. */
function mapPlanType(raw: string): DataPlanOption['type'] {
  const value = String(raw || '').toLowerCase();
  if (value.startsWith('sme')) return 'sme';
  if (value.startsWith('corporate') || value.startsWith('gifting')) return 'corporate_gifting';
  return 'direct';
}

interface SmeApiPlanRow {
  id: number;
  network_id: number;
  network: string;
  name: string;
  type: string;
  days: string;
  price: number;
}

export class SmeApiUtilityProvider implements IUtilityProvider {
  readonly name: UtilityProviderName;
  readonly priority: number;
  readonly supports: readonly UtilityServiceType[] = ['airtime', 'data'];

  private readonly baseUrl: string;
  private readonly apiKey: string;

  constructor(config: SmeApiConfig = {}) {
    this.name = config.name || 'smeapi';
    this.priority = config.priority ?? 18;
    this.baseUrl = (config.baseUrl || process.env.SMEAPI_BASE_URL || 'https://smeapi.com.ng/api').replace(/\/$/, '');
    this.apiKey = config.apiKey || process.env.SMEAPI_TOKEN || '';
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(this.apiKey ? { Authorization: `Token ${this.apiKey}` } : {}),
    };
  }

  private requireKey(): void {
    if (!this.apiKey) {
      throw new Error('SME API token is not configured. Set SMEAPI_TOKEN before routing traffic to "smeapi".');
    }
  }

  private networkId(operator: TelcoOperator): number {
    const id = NETWORK_IDS[operator];
    if (!id) {
      throw new Error(`SME API carries no ${operator} inventory. Route ${operator} to another provider.`);
    }
    return id;
  }

  /**
   * SME API answers 200 with { status: 'fail', msg } on business errors, so the
   * body is authoritative and the HTTP code alone cannot be trusted.
   */
  private assertOk(body: any, context: string): void {
    const status = String(body?.status ?? '').toLowerCase();
    if (status !== 'success' && status !== 'successful') {
      throw new Error(`SME API ${context} failed: ${body?.msg || body?.message || 'unknown upstream error'}`);
    }
  }

  async listDataPlans(operator: TelcoOperator): Promise<DataPlanOption[]> {
    const networkId = this.networkId(operator);
    const res = await fetch(`${this.baseUrl}/dataplans/`, { method: 'GET', headers: this.headers() });
    const body = (await res.json().catch(() => ({}))) as any;
    this.assertOk(body, 'data plan listing');

    const rows = (Array.isArray(body.data) ? body.data : []) as SmeApiPlanRow[];
    return rows
      .filter((row) => Number(row.network_id) === networkId)
      .map((row) => ({
        // The plan id is what /api/data/ expects back, so it is the plan code.
        planId: String(row.id),
        name: `${row.network} ${row.name} ${row.type}`.trim(),
        size: row.name,
        validity: row.days,
        // Their price is our cost. No markup is invented here; retail pricing
        // is owned by utility-data-plans.service.
        wholesalePriceNgn: Number(row.price),
        retailPriceNgn: Number(row.price),
        operator,
        type: mapPlanType(row.type),
        providerPlanType: row.type,
      }));
  }

  /** Confirmed against the live API - see the file header. */
  private buildAirtimeBody(phone: string, amountNgn: number, operator: TelcoOperator, idempotencyKey: string) {
    return {
      network: this.networkId(operator),
      amount: amountNgn,
      mobile_number: phone,
      Ported_number: true,
      airtime_type: 'VTU',
      request_id: idempotencyKey,
    };
  }

  /** Confirmed against the live API - see the file header. */
  private buildDataBody(phone: string, planCode: string, operator: TelcoOperator, idempotencyKey: string) {
    return {
      network: this.networkId(operator),
      mobile_number: phone,
      plan: Number(planCode) || planCode,
      Ported_number: true,
      request_id: idempotencyKey,
    };
  }

  async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderAirtimeResult> {
    this.requireKey();
    const res = await fetch(`${this.baseUrl}/airtime/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildAirtimeBody(phone, amountNgn, operator, idempotencyKey)),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    this.assertOk(body, 'airtime purchase');

    return {
      reference: String(body?.data?.reference || body?.data?.id || idempotencyKey),
      amountNgn,
      phone,
      operator,
      status: 'success',
      message: body?.msg || 'Airtime delivered by SME API',
      rawPayload: body,
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
    const res = await fetch(`${this.baseUrl}/data/`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(this.buildDataBody(phone, planCode, operator, idempotencyKey)),
    });
    const body = (await res.json().catch(() => ({}))) as any;
    this.assertOk(body, 'data purchase');

    return {
      reference: String(body?.data?.reference || body?.data?.id || idempotencyKey),
      amountNgn,
      phone,
      operator,
      planCode,
      status: 'success',
      message: body?.msg || 'Data bundle delivered by SME API',
      rawPayload: body,
    };
  }

  /**
   * Float check. Not part of IUtilityProvider, but worth exposing: routing
   * traffic to an aggregator with an empty wallet is the common way these
   * integrations fail in production.
   */
  async getWalletBalanceNgn(): Promise<number> {
    this.requireKey();
    const res = await fetch(`${this.baseUrl}/user/`, { method: 'GET', headers: this.headers() });
    const body = (await res.json().catch(() => ({}))) as any;
    this.assertOk(body, 'wallet balance lookup');
    // Confirmed live: the response is flat, { name, balance: "0.00", status }.
    const raw = body?.balance ?? body?.data?.balance ?? body?.wallet_balance;
    return Number(raw ?? 0);
  }
}
