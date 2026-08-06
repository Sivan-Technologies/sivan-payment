import { env } from '../../config/env.js';
import { forbidden } from '../../shared/errors.js';
import type { BvnAccountMatchInput, BvnInfoMatchInput, KycLevelMatchResult, KycLevelProvider } from './kyc-level-provider.js';
import { bvnLast4 } from './kyc-level-provider.js';

function baseUrl() {
  return (env.MONNIFY_BASE_URL || 'https://api.monnify.com').replace(/\/$/, '');
}

function authHeader() {
  if (!env.MONNIFY_API_KEY || !env.MONNIFY_SECRET_KEY) throw forbidden('Monnify KYC provider is not configured.');
  return `Basic ${Buffer.from(`${env.MONNIFY_API_KEY}:${env.MONNIFY_SECRET_KEY}`).toString('base64')}`;
}

async function getAccessToken() {
  const response = await fetch(`${baseUrl()}/api/v1/auth/login`, { method: 'POST', headers: { Authorization: authHeader(), 'Content-Type': 'application/json' } });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Monnify auth failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
  const token = json?.responseBody?.accessToken || json?.accessToken || json?.token;
  if (!token) throw new Error('Monnify auth response did not include accessToken');
  return String(token);
}

function boolFromUnknown(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.toLowerCase();
    if (['true', 'match', 'matched', 'yes', 'success', 'passed'].includes(normalized)) return true;
    if (['false', 'mismatch', 'not_match', 'failed', 'no'].includes(normalized)) return false;
  }
  return undefined;
}

function extractMatches(body: any) {
  const source = body?.responseBody || body?.data || body || {};
  const candidates = {
    firstName: source.firstNameMatch ?? source.firstNameMatched ?? source.firstnameMatch ?? source.nameMatch,
    lastName: source.lastNameMatch ?? source.lastNameMatched ?? source.lastnameMatch ?? source.nameMatch,
    dateOfBirth: source.dateOfBirthMatch ?? source.dobMatch ?? source.dobMatched,
    mobileNo: source.mobileNoMatch ?? source.mobileNumberMatch ?? source.phoneNumberMatch ?? source.phoneMatch,
    accountName: source.accountNameMatch ?? source.nameMatch ?? source.accountNameMatched,
    accountNumber: source.accountNumberMatch ?? source.accountNumberMatched,
    bankCode: source.bankCodeMatch ?? source.bankMatch
  };
  return Object.fromEntries(Object.entries(candidates).filter(([, value]) => value !== undefined).map(([key, value]) => [key, boolFromUnknown(value) ?? String(value)]));
}

function statusFromResponse(body: any, matchedFields: Record<string, boolean | string>): KycLevelMatchResult['status'] {
  const source = body?.responseBody || body?.data || body || {};
  const direct = String(source.status || source.matchStatus || source.verificationStatus || body?.responseMessage || '').toLowerCase();
  if (/fail|mismatch|not match|invalid|rejected/.test(direct)) return 'failed';
  if (/review|partial|pending/.test(direct)) return 'review';
  const values = Object.values(matchedFields);
  if (values.length && values.every((value) => value === true || String(value).toLowerCase() === 'true')) return 'matched';
  if (values.some((value) => value === false || String(value).toLowerCase() === 'false')) return 'review';
  if (body?.requestSuccessful === true || /success|match/.test(direct)) return 'matched';
  return 'review';
}

function safeResult(provider: string, bvn: string, body: any): KycLevelMatchResult {
  const matchedFields = extractMatches(body);
  const status = statusFromResponse(body, matchedFields);
  const ref = body?.responseBody?.reference || body?.responseBody?.requestReference || body?.requestReference || body?.transactionReference;
  return {
    provider,
    status,
    message: status === 'matched' ? 'BVN verification matched.' : status === 'review' ? 'BVN verification needs review.' : 'BVN verification failed.',
    bvnLast4: bvnLast4(bvn),
    matchedFields,
    providerReference: ref ? String(ref) : undefined,
    raw: body
  };
}

export class MonnifyKycLevelProvider implements KycLevelProvider {
  name = 'monnify';

  async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
    const token = await getAccessToken();
    const response = await fetch(`${baseUrl()}/api/v1/vas/bvn-details-match`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Monnify BVN information match failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return safeResult(this.name, input.bvn, json);
  }

  async verifyBvnBankAccount(input: BvnAccountMatchInput): Promise<KycLevelMatchResult> {
    const token = await getAccessToken();
    const response = await fetch(`${baseUrl()}/api/v1/vas/bvn-account-match`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input)
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Monnify BVN account match failed ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return safeResult(this.name, input.bvn, json);
  }

  async health() {
    try {
      await getAccessToken();
      return { provider: this.name, available: true, mode: 'live' as const, message: 'Monnify auth reachable.', checkedAt: new Date().toISOString() };
    } catch (error) {
      return { provider: this.name, available: false, mode: 'live' as const, message: error instanceof Error ? error.message : String(error), checkedAt: new Date().toISOString() };
    }
  }
}
