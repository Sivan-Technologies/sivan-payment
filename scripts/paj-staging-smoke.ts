import assert from 'node:assert/strict';
import { env } from '../src/config/env.js';

type Result = { name: string; ok: boolean; status?: number; detail?: unknown };
const results: Result[] = [];

const baseUrl = (process.env.PAJ_RAMP_BASE_URL || env.PAJ_RAMP_BASE_URL || 'https://api-staging.paj.cash').replace(/\/$/, '');
const apiKey = process.env.PAJ_RAMP_API_KEY || env.PAJ_RAMP_API_KEY;
const mints = [
  { symbol: 'USDC', mint: process.env.PAJ_RAMP_USDC_MINT || env.PAJ_RAMP_USDC_MINT || 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'USDT', mint: process.env.PAJ_RAMP_USDT_MINT || env.PAJ_RAMP_USDT_MINT || 'Es9vMFrzaCERmJfrF4H2FYD4KCoGXP9qYz9Q5AAbH9k' }
];
const bankId = process.env.PAJ_RAMP_TEST_BANK_ID || process.env.PAJ_RAMP_DEFAULT_BANK_ID;
const accountNumber = process.env.PAJ_RAMP_TEST_ACCOUNT_NUMBER || process.env.PAJ_RAMP_DEFAULT_ACCOUNT_NUMBER;

if (!apiKey) throw new Error('PAJ_RAMP_API_KEY is required for staging smoke test');

async function fetchJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  const text = await response.text();
  let body: unknown;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { status: response.status, ok: response.ok, body };
}

function record(result: Result) {
  results.push(result);
  console.log(`${result.ok ? '✓' : '✗'} ${result.name}${result.status ? ` (${result.status})` : ''}`);
}

const rate = await fetchJson('/pub/rate');
record({ name: 'rate endpoint returns on/off-ramp rates', ok: rate.ok && Boolean((rate.body as any)?.onRampRate || (rate.body as any)?.offRampRate), status: rate.status, detail: rate.body });

const banks = await fetchJson('/pub/bank', { headers: { Authorization: `Bearer ${apiKey}` } });
record({ name: 'API key as bearer can list banks', ok: banks.ok && Array.isArray(banks.body) && (banks.body as any[]).length > 0, status: banks.status, detail: Array.isArray(banks.body) ? { count: (banks.body as any[]).length, first: (banks.body as any[])[0] } : banks.body });

const tokenFindings: Record<string, { ok: boolean; status: number; detail: unknown }> = {};
for (const item of mints) {
  const tokenInfo = await fetchJson(`/token/${encodeURIComponent(item.mint)}?chain=SOLANA`);
  tokenFindings[item.symbol] = { ok: tokenInfo.ok, status: tokenInfo.status, detail: tokenInfo.body };
  record({ name: `SOLANA token metadata lookup for ${item.symbol}`, ok: tokenInfo.ok, status: tokenInfo.status, detail: tokenInfo.body });
}

const invalidOfframp = await fetchJson('/pub/offramp', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({}) });
record({
  name: 'API key as bearer order-auth probe using invalid off-ramp body',
  ok: invalidOfframp.status !== 401,
  status: invalidOfframp.status,
  detail: invalidOfframp.body
});

if (bankId && accountNumber) {
  const query = new URLSearchParams({ bankId, accountNumber });
  const resolved = await fetchJson(`/pub/bank-account/confirm?${query.toString()}`, { headers: { Authorization: `Bearer ${apiKey}` } });
  record({ name: 'bank account resolve with provided test account', ok: resolved.ok && Boolean((resolved.body as any)?.accountName), status: resolved.status, detail: resolved.body });
} else {
  record({ name: 'bank account resolve skipped', ok: true, detail: 'Set PAJ_RAMP_TEST_BANK_ID and PAJ_RAMP_TEST_ACCOUNT_NUMBER to test account resolution.' });
}

const summary = {
  ok: results.every((item) => item.ok || item.name.includes('order-auth probe') || item.name.includes('token metadata')),
  baseUrl,
  configuredMints: mints,
  findings: {
    rateAvailable: results.find((item) => item.name.includes('rate'))?.ok,
    banksAvailableWithApiKeyBearer: results.find((item) => item.name.includes('list banks'))?.ok,
    tokenInfoAcceptedMints: Object.fromEntries(Object.entries(tokenFindings).map(([symbol, value]) => [symbol, value.ok])),
    apiKeyAcceptedForOrderEndpoints: invalidOfframp.status !== 401,
    orderAuthProbeStatus: invalidOfframp.status,
    orderAuthProbeMessage: (invalidOfframp.body as any)?.message || (invalidOfframp.body as any)?.error
  },
  nextAction: invalidOfframp.status === 401
    ? 'PAJ API key is not accepted as an order Bearer token on staging. Ask PAJ for a merchant/server token or implement user OTP sessionToken flow.'
    : 'PAJ API key reached order validation. Merchant mode can be tested with a tiny staging order after bank/mint confirmation.',
  results
};

console.log(JSON.stringify(summary, null, 2));

assert.equal(rate.ok, true, 'rate endpoint must be reachable');
assert.equal(Array.isArray(banks.body), true, 'banks endpoint must return a list with API key bearer');
