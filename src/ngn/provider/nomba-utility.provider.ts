/**
 * NOMBA UTILITY BILLS & VENDING PROVIDER
 *
 * Implements IUtilityProvider for Nomba's utility & bills payment APIs.
 * Supports:
 *   1. Electricity meter verification & DisCo token vending (10 DisCos)
 *   2. Cable TV bouquets, smartcard lookup, and subscription renewal (DSTV, GOtv, StarTimes, ShowMax)
 *   3. Telco Airtime vending (MTN, Airtel, Glo, 9mobile) as high-resilience fallback
 *   4. Telco Data bundle vending (MTN, Airtel, Glo, 9mobile) as high-resilience fallback
 *
 * Reuses the existing Nomba BaaS credentials and OAuth token lifecycle.
 */

import dns from 'node:dns';

// Ensure outbound calls strictly exit via whitelisted IPv4 address (13.39.31.121)
try {
  dns.setDefaultResultOrder('ipv4first');
} catch {
  // Ignore on older Node runtimes
}

import type {
  IUtilityProvider,
  UtilityProviderName,
  UtilityServiceType,
  CableTvPlanOption,
  CableTvInquiryResponse,
  ProviderCableTvResult,
  ProviderElectricityResult,
  ProviderAirtimeResult,
  ProviderDataResult,
  ProviderBettingResult,
} from './utility-provider.interface.js';
import type {
  DiscoCode,
  MeterType,
  ElectricityInquiryResponse,
  TelcoOperator,
  DataPlanOption,
  BettingProviderOption,
  BettingInquiryResponse,
} from '../types/utilityTypes.js';
import { DISCO_DISPLAY_NAMES } from '../types/utilityTypes.js';

interface NombaTokenCache {
  accessToken: string;
  expiresAt: number;
}

const SIVAN_TO_NOMBA_DISCO: Record<string, string> = {
  ikeja: 'ikeja',
  eko: 'eko',
  abuja: 'abuja',
  ibadan: 'ibedc',
  enugu: 'enugu',
  kano: 'kano',
  'port-harcourt': 'phed',
  phed: 'phed',
  benin: 'benin',
  jos: 'jed',
  jed: 'jed',
  kaduna: 'kaduna',
  ibedc: 'ibedc',
};

export class NombaUtilityProvider implements IUtilityProvider {
  readonly name: UtilityProviderName = 'nomba';
  readonly priority: number = 20; // Preferred for electricity and cable_tv; fallback for airtime and data
  readonly supports: readonly UtilityServiceType[] = ['electricity', 'cable_tv', 'airtime', 'data', 'betting'];

  private tokenCache?: NombaTokenCache;

  private accountId(): string {
    return (
      process.env.NOMBA_ACCOUNT_ID ||
      process.env.NOMBA_TEST_ACCOUNT_ID ||
      process.env.NOMBA_LIVE_ACCOUNT_ID ||
      ''
    ).trim();
  }

  private clientId(): string {
    return (
      process.env.NOMBA_CLIENT_ID ||
      process.env.NOMBA_TEST_CLIENT_ID ||
      process.env.NOMBA_LIVE_CLIENT_ID ||
      ''
    ).trim();
  }

  private clientSecret(): string {
    return (
      process.env.NOMBA_CLIENT_SECRET ||
      process.env.NOMBA_TEST_CLIENT_SECRET ||
      process.env.NOMBA_LIVE_CLIENT_SECRET ||
      ''
    ).trim();
  }

  private baseUrl(): string {
    const isProd = (process.env.APP_ENV || 'staging') === 'production';
    if (isProd) {
      return (process.env.NOMBA_LIVE_BASE_URL || 'https://api.nomba.com').replace(/\/v[12]\/?$/, '').replace(/\/+$/, '');
    }
    return (process.env.NOMBA_SANDBOX_BASE_URL || 'https://sandbox.nomba.com').replace(/\/v[12]\/?$/, '').replace(/\/+$/, '');
  }

  public isConfigured(): boolean {
    return Boolean(this.accountId() && this.clientId() && this.clientSecret());
  }

  private async getAccessToken(): Promise<string> {
    if (this.tokenCache && Date.now() < this.tokenCache.expiresAt) {
      return this.tokenCache.accessToken;
    }

    const accountId = this.accountId();
    const clientId = this.clientId();
    const clientSecret = this.clientSecret();

    if (!accountId || !clientId || !clientSecret) {
      throw new Error('[NombaUtilityProvider] Missing Nomba credentials (ACCOUNT_ID, CLIENT_ID, or CLIENT_SECRET)');
    }

    const url = `${this.baseUrl()}/v1/auth/token/issue`;
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        accountId,
        'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
      },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`[NombaUtilityProvider] Token issue failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as any;
    const body = data?.data || data || {};
    const token = body.access_token || body.accessToken || body.token;
    const expiresIn = Number(body.expires_in || body.expiresIn || 1800);

    if (!token) {
      throw new Error('[NombaUtilityProvider] Received empty token from Nomba');
    }

    this.tokenCache = {
      accessToken: token,
      expiresAt: Date.now() + Math.max(expiresIn - 60, 60) * 1000,
    };

    return token;
  }

  private async request<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = await this.getAccessToken();
    const url = `${this.baseUrl()}${path}`;
    const headers: Record<string, string> = {
      accountId: this.accountId(),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
      ...((options.headers as Record<string, string>) || {}),
    };

    const res = await fetch(url, {
      ...options,
      headers,
      signal: AbortSignal.timeout(15000),
    });

    const data = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) {
      const msg = data.description || data.message || `Nomba request failed with status ${res.status}`;
      const err = new Error(msg) as Error & { statusCode?: number; httpStatus?: number; code?: string };
      err.statusCode = res.status;
      err.httpStatus = res.status;
      if (data?.code) err.code = String(data.code);
      throw err;
    }

    return data;
  }

  // -------------------------------------------------------------
  // AIRTIME METHODS
  // -------------------------------------------------------------

  public async purchaseAirtime(
    phone: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderAirtimeResult> {
    const merchantTxRef = idempotencyKey?.trim() || `sivan_airtime_${Date.now()}`;
    const body = {
      amount: Math.round(amountNgn),
      phoneNumber: phone,
      network: operator.toUpperCase(),
      merchantTxRef,
      senderName: 'Sivan Customer',
    };

    const res = await this.request<any>('/v2/bill/topup', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const data = res.data || {};
    const status =
      res.code === '200' || res.code === '00' || data.status === 'SUCCESS' || data.status === 'PENDING_BILLING'
        ? 'success'
        : 'failed';

    return {
      reference: data.id || merchantTxRef,
      amountNgn,
      phone,
      operator,
      status,
      message: res.message || res.description || 'Airtime topup successful',
      rawPayload: res,
    };
  }

  // -------------------------------------------------------------
  // DATA BUNDLE METHODS
  // -------------------------------------------------------------

  public async listDataPlans(operator: TelcoOperator): Promise<DataPlanOption[]> {
    const telco = operator.toLowerCase();
    const path = `/v1/bill/data-plan/${encodeURIComponent(telco)}`;
    const res = await this.request<any>(path, { method: 'GET' });

    const rawPlans = (Array.isArray(res.data) ? res.data : []) as any[];
    return rawPlans.map((p) => {
      const rawPlanName = String(p.plan || '');
      const sizeMatch = rawPlanName.match(/(\d+(?:\.\d+)?\s*(?:GB|MB))/i);
      const size = sizeMatch ? sizeMatch[1].toUpperCase() : rawPlanName;

      const validityMatch = rawPlanName.match(/(Daily Plan|\d+\s*(?:Day|Days|Week|Month|Hours))/i);
      const validity = validityMatch ? validityMatch[1] : 'Standard';

      return {
        planId: String(p.productId || p.id || ''),
        name: rawPlanName,
        size,
        validity,
        wholesalePriceNgn: Number(p.amount || 0),
        retailPriceNgn: Number(p.amount || 0),
        operator,
        type: 'direct' as const,
        providerPlanType: String(p.productId || ''),
      };
    });
  }

  public async purchaseDataBundle(
    phone: string,
    planCode: string,
    amountNgn: number,
    operator: TelcoOperator,
    idempotencyKey: string
  ): Promise<ProviderDataResult> {
    const merchantTxRef = idempotencyKey?.trim() || `sivan_data_${Date.now()}`;
    let productId = planCode;

    // If planCode is a generic label or bundle size rather than a Nomba productId, resolve dynamically
    const isDirectNombaId = /^(mtn|airtel|glo|9mobile)[0-9a-zA-Z_\-]+$/i.test(productId);
    if (!isDirectNombaId) {
      try {
        const livePlans = await this.listDataPlans(operator);
        const cleanTarget = planCode.toUpperCase().replace(/\s+/g, '');
        const match =
          livePlans.find((p) => {
            const pSize = p.size.toUpperCase().replace(/\s+/g, '');
            const pName = p.name.toUpperCase().replace(/\s+/g, '');
            return pSize === cleanTarget || pName.includes(cleanTarget);
          }) || livePlans.find((p) => Math.abs(p.wholesalePriceNgn - amountNgn) < 50);

        if (match && match.planId) {
          productId = match.planId;
        }
      } catch (lookupErr) {
        console.warn('[NombaUtilityProvider] Dynamic data plan match warning:', lookupErr);
      }
    }

    const body = {
      productId,
      phoneNumber: phone,
      network: operator.toUpperCase(),
      merchantTxRef,
      senderName: 'Sivan Customer',
    };

    const res = await this.request<any>('/v2/bill/data', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const data = res.data || {};
    const status =
      res.code === '200' || res.code === '00' || data.status === 'SUCCESS' || data.status === 'PENDING_BILLING'
        ? 'success'
        : 'failed';

    return {
      reference: data.id || merchantTxRef,
      amountNgn,
      phone,
      operator,
      planCode: productId,
      status,
      message: res.message || res.description || 'Data bundle purchase successful',
      rawPayload: res,
    };
  }

  // -------------------------------------------------------------
  // ELECTRICITY METHODS
  // -------------------------------------------------------------

  public async inquireElectricityMeter(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType
  ): Promise<ElectricityInquiryResponse> {
    const nombaDisco = SIVAN_TO_NOMBA_DISCO[disco] || disco;
    const path = `/v2/bill/electricity/lookup?disco=${encodeURIComponent(nombaDisco)}&customerId=${encodeURIComponent(meterNumber)}`;
    const res = await this.request<any>(path, { method: 'GET' });

    const payload = res.data || res;
    const customerName = payload.name || payload.customerName || 'Verified Customer';
    const customerAddress = payload.address && payload.address !== 'unknown' ? payload.address : undefined;

    return {
      meterNumber,
      disco,
      discoName: DISCO_DISPLAY_NAMES[disco] || disco.toUpperCase(),
      meterType,
      customerName,
      customerAddress,
      minimumAmountNgn: 1000,
      providerName: 'nomba',
    };
  }

  public async payElectricityBill(
    meterNumber: string,
    disco: DiscoCode,
    meterType: MeterType,
    amountNgn: number,
    customerName: string | undefined,
    idempotencyKey: string
  ): Promise<ProviderElectricityResult> {
    const nombaDisco = SIVAN_TO_NOMBA_DISCO[disco] || disco;
    const merchantTxRef = idempotencyKey?.trim() || `sivan_elec_${Date.now()}`;

    const body = {
      disco: nombaDisco,
      merchantTxRef,
      payerName: customerName || 'Sivan Customer',
      amount: Math.round(amountNgn),
      customerId: meterNumber,
      meterType: meterType.toUpperCase(),
    };

    const res = await this.request<any>('/v2/bill/electricity', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const data = res.data || {};
    const meta = data.meta || {};

    const token = meta.phcnToken || meta.phcnVendToken || meta.token;
    const units = meta.phcnVendUnits || meta.units;
    const status = res.code === '200' || res.code === '00' || data.status === 'SUCCESS' ? 'success' : 'failed';

    return {
      reference: merchantTxRef,
      amountNgn,
      meterNumber,
      disco,
      meterType,
      customerName: customerName || meta.phcnCustomerName || 'Customer',
      token,
      units: units ? `${units} kWh` : undefined,
      status,
      message:
        res.message ||
        res.description ||
        (status === 'success' ? 'Electricity bill payment successful' : 'Electricity vend processing'),
      rawPayload: res,
    };
  }

  // -------------------------------------------------------------
  // CABLE TV METHODS
  // -------------------------------------------------------------

  public async listCableTvPlans(cableTvType: string): Promise<CableTvPlanOption[]> {
    const normalizedType = cableTvType.toLowerCase().trim();
    const path = `/v1/bill/cableTvProduct?cableTvType=${encodeURIComponent(normalizedType)}`;
    const res = await this.request<any>(path, { method: 'GET' });

    const rawPlans = (Array.isArray(res.data) ? res.data : []) as any[];
    return rawPlans.map((p) => ({
      subScriptionType: p.subScriptionType || p.name || p.code,
      amount: Number(p.amount || 0),
    }));
  }

  public async inquireCableTv(
    cableTvType: string,
    customerId: string
  ): Promise<CableTvInquiryResponse> {
    const normalizedType = cableTvType.toLowerCase().trim();
    const path = `/v1/bill/cabletv/lookup?cableTvType=${encodeURIComponent(normalizedType)}&customerId=${encodeURIComponent(customerId)}`;
    const res = await this.request<any>(path, { method: 'GET' });

    const customerName = typeof res.data === 'string' ? res.data : res.data?.name || 'Verified Subscriber';
    return {
      customerId,
      cableTvType: normalizedType,
      customerName,
      providerName: 'nomba',
    };
  }

  public async payCableTv(
    cableTvType: string,
    customerId: string,
    amountNgn: number,
    payerName: string | undefined,
    idempotencyKey: string
  ): Promise<ProviderCableTvResult> {
    const normalizedType = cableTvType.toLowerCase().trim();
    const merchantTxRef = idempotencyKey?.trim() || `sivan_cable_${Date.now()}`;

    const body = {
      cableTvType: normalizedType,
      merchantTxRef,
      payerName: payerName || 'Sivan Subscriber',
      amount: Math.round(amountNgn),
      customerId,
    };

    const res = await this.request<any>('/v2/bill/cabletv', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const data = res.data || {};
    const status = res.code === '200' || res.code === '00' || data.status === 'SUCCESS' ? 'success' : 'failed';

    return {
      reference: merchantTxRef,
      amountNgn,
      customerId,
      cableTvType: normalizedType,
      customerName: payerName,
      status,
      message:
        res.message ||
        res.description ||
        (status === 'success' ? 'Cable TV subscription successful' : 'Cable TV subscription processing'),
      rawPayload: res,
    };
  }

  // -------------------------------------------------------------
  // BETTING WALLET METHODS
  // -------------------------------------------------------------

  public async listBettingProviders(): Promise<BettingProviderOption[]> {
    const path = '/v1/bill/betting/providers';
    const res = await this.request<any>(path, { method: 'GET' });

    const rawList = (Array.isArray(res.data) ? res.data : []) as any[];
    return rawList.map((p) => ({
      id: String(p.id || p.biller_id || p.lookup_id || '').toLowerCase().trim(),
      name: String(p.name || p.id || 'Betting Platform'),
      billerId: p.biller_id ? String(p.biller_id) : undefined,
      lookupId: p.lookup_id ? String(p.lookup_id) : undefined,
    }));
  }

  public async inquireBettingCustomer(
    providerId: string,
    customerId: string
  ): Promise<BettingInquiryResponse> {
    const cleanProvider = providerId.toLowerCase().trim();
    const cleanCustomer = customerId.trim();
    const path = `/v1/bill/betting/lookup?providerId=${encodeURIComponent(cleanProvider)}&customerId=${encodeURIComponent(cleanCustomer)}`;
    const res = await this.request<any>(path, { method: 'GET' });

    const customerName = typeof res.data === 'string' ? res.data : (res.data?.name || res.data?.customerName || 'Verified Bettor');

    return {
      customerId: cleanCustomer,
      providerId: cleanProvider,
      providerName: 'nomba',
      customerName,
    };
  }

  public async fundBettingWallet(
    providerId: string,
    customerId: string,
    amountNgn: number,
    phoneNumber: string | undefined,
    payerName: string | undefined,
    idempotencyKey: string
  ): Promise<ProviderBettingResult> {
    const cleanProvider = providerId.toLowerCase().trim();
    const cleanCustomer = customerId.trim();
    const merchantTxRef = idempotencyKey?.trim() || `sivan_bet_${Date.now()}`;

    const body = {
      bettingProvider: cleanProvider,
      merchantTxRef,
      phoneNumber: phoneNumber || '08000000000',
      payerName: payerName || 'Sivan Customer',
      amount: Math.round(amountNgn),
      customerId: cleanCustomer,
    };

    const res = await this.request<any>('/v2/bill/betting', {
      method: 'POST',
      body: JSON.stringify(body),
    });

    const data = res.data || {};
    const status = res.code === '200' || res.code === '00' || data.status === 'SUCCESS' ? 'success' : 'failed';

    return {
      reference: merchantTxRef,
      amountNgn,
      customerId: cleanCustomer,
      providerId: cleanProvider,
      customerName: payerName,
      status,
      message:
        res.message ||
        res.description ||
        (status === 'success' ? 'Betting wallet funded successfully' : 'Betting wallet funding processing'),
      rawPayload: res,
    };
  }

  /**
   * Queries Nomba for the status of a bill payment transaction by merchantTxRef.
   * Returns 'SUCCESS', 'FAILED', 'NOT_FOUND', 'PENDING', or 'UNKNOWN' (on transient lookup error).
   */
  public async queryBillTransactionStatus(merchantTxRef: string): Promise<{
    status: 'SUCCESS' | 'FAILED' | 'NOT_FOUND' | 'PENDING' | 'UNKNOWN';
    raw?: unknown;
  }> {
    if (!merchantTxRef || !this.isConfigured()) {
      return { status: 'UNKNOWN' };
    }

    try {
      const token = await this.getAccessToken();
      const url = `${this.baseUrl()}/v1/transactions/accounts/single?merchantTxRef=${encodeURIComponent(merchantTxRef)}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          accountId: this.accountId(),
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Sivan-Payment-Engine/1.0 (Borderless Autonomous Payment Protocol; support@sivantech.online)',
        },
        signal: AbortSignal.timeout(15000),
      });

      const json = (await res.json().catch(() => null)) as any;

      if (res.status === 404) {
        return { status: 'NOT_FOUND', raw: json };
      }

      if (!res.ok) {
        const msg = String(json?.description || json?.message || '').toLowerCase();
        if (msg.includes('not found') || String(json?.code || '') === '404') {
          return { status: 'NOT_FOUND', raw: json };
        }
        return { status: 'UNKNOWN', raw: { httpStatus: res.status, body: json } };
      }

      const data = json?.data;
      if (!data) {
        return { status: 'NOT_FOUND', raw: json };
      }

      const rawStatus = String(data.status || json?.status || '').toUpperCase();
      if (rawStatus === 'SUCCESS' || rawStatus === 'COMPLETED') {
        return { status: 'SUCCESS', raw: data };
      }
      if (rawStatus === 'FAILED' || rawStatus === 'REVERSED' || rawStatus === 'DECLINED') {
        return { status: 'FAILED', raw: data };
      }
      return { status: 'PENDING', raw: data };
    } catch (err) {
      return {
        status: 'UNKNOWN',
        raw: { error: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  /**
   * Reads the live Nomba NGN account balance for the Provider Float panel
   * and utility routing float cache.
   */
  public async getWalletBalanceNgn(): Promise<number> {
    const res = await this.request<{
      data?: { amount?: number | string; currency?: string };
    }>('/v1/accounts/balance', { method: 'GET' });

    const rawAmount = res?.data?.amount;
    const balance = typeof rawAmount === 'number' ? rawAmount : Number(rawAmount);
    if (!Number.isFinite(balance)) {
      throw new Error('Nomba balance response missing numeric data.amount');
    }
    return balance;
  }
}
