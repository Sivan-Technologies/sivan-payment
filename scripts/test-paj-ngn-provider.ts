import assert from 'node:assert/strict';
import http from 'node:http';

let onrampRequest: any = null;
let offrampRequest: any = null;
let authSeen = '';

const paj = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://127.0.0.1');
  function json(status: number, body: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }
  if (req.method === 'GET' && url.pathname === '/pub/rate') {
    return json(200, { onRampRate: { baseCurrency: 'USD', targetCurrency: 'NGN', isActive: true, rate: 1500, type: 'onRamp' }, offRampRate: { baseCurrency: 'USD', targetCurrency: 'NGN', isActive: true, rate: 1525, type: 'offRamp' } });
  }
  authSeen = String(req.headers.authorization || '');
  if (authSeen !== 'Bearer paj-test-key') return json(401, { message: 'bad auth' });
  if (req.method === 'GET' && url.pathname === '/pub/bank') return json(200, [{ id: 'bank_access', code: '044', name: 'Access Bank', country: 'NG', logo: '' }]);
  if (req.method === 'GET' && url.pathname === '/pub/bank-account/confirm') return json(200, { accountName: 'MICHEAL JOHN', accountNumber: url.searchParams.get('accountNumber'), bank: { id: url.searchParams.get('bankId'), name: 'Access Bank', code: '044', country: 'NG' } });
  if (req.method === 'POST' && url.pathname === '/pub/onramp') {
    let raw = '';
    req.on('data', (chunk) => raw += chunk);
    req.on('end', () => {
      onrampRequest = JSON.parse(raw || '{}');
      return json(200, { id: 'paj_on_1', accountNumber: '1234567890', accountName: 'PAJ CASH', amount: 10, fiatAmount: onrampRequest.fiatAmount, bank: 'Access Bank', rate: 1500, recipient: onrampRequest.recipient, currency: 'NGN', mint: onrampRequest.mint, fee: onrampRequest.businessUSDCFee || 0 });
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/pub/offramp') {
    let raw = '';
    req.on('data', (chunk) => raw += chunk);
    req.on('end', () => {
      offrampRequest = JSON.parse(raw || '{}');
      return json(200, { id: 'paj_off_1', address: 'SolanaDepositAddress1111111111111111111111', mint: offrampRequest.mint, currency: 'NGN', amount: offrampRequest.amount, fiatAmount: 15250, rate: 1525, fee: offrampRequest.businessUSDCFee || 0 });
    });
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/pub/transactions/')) return json(200, { id: url.pathname.split('/').pop(), status: 'COMPLETED', transactionType: 'OFF_RAMP', signature: 'sig_paj_1' });
  return json(404, { message: 'not found', path: url.pathname });
});

await new Promise<void>((resolve) => paj.listen(0, '127.0.0.1', resolve));
const address = paj.address();
if (!address || typeof address === 'string') throw new Error('Could not start fake PAJ');

process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = '.data/test-paj-ngn-provider.json';
process.env.EMAIL_PROVIDER = 'console';
process.env.SUPPORT_UPLOAD_PROVIDER = 'mock';
process.env.BRIDGE_MOCK_MODE = 'true';
process.env.ADMIN_API_KEY = 'paj-admin-key';
process.env.NGN_PROVIDER = 'paj';
process.env.NGN_LIVE_PROVIDER_ENABLED = 'true';
process.env.PAJ_RAMP_ENV = 'staging';
process.env.PAJ_RAMP_BASE_URL = `http://127.0.0.1:${(address as any).port}`;
process.env.PAJ_RAMP_API_KEY = 'paj-test-key';
process.env.PAJ_RAMP_SESSION_MODE = 'merchant';
process.env.PAJ_RAMP_WEBHOOK_URL = 'https://api.sivantech.online/api/payment/api/webhooks/paj';
process.env.PAJ_RAMP_DEFAULT_CURRENCY = 'NGN';
process.env.PAJ_RAMP_DEFAULT_CHAIN = 'SOLANA';
process.env.PAJ_RAMP_USDC_MINT = 'USDCMint1111111111111111111111111111111111';
process.env.PAJ_RAMP_BUSINESS_USDC_FEE = '0';
process.env.PAJ_RAMP_REQUIRE_SIVAN_KYC = 'true';
process.env.PAJ_RAMP_DEFAULT_RECIPIENT_ADDRESS = 'RecipientSolana111111111111111111111111111';
process.env.PAJ_RAMP_DEFAULT_BANK_ID = 'bank_access';
process.env.PAJ_RAMP_DEFAULT_ACCOUNT_NUMBER = '0123456789';

try {
  const { buildApp } = await import('../src/app.js');
  const { signUserJwt } = await import('../src/auth/jwt.js');
  const { db } = await import('../src/database/json-database.js');
  const now = new Date().toISOString();
  await db.mutate((data) => {
    data.users = [
      { id: 'usr_paj_ok', email: 'paj-ok@sivan.test', fullName: 'Paj Ok', createdAt: now, updatedAt: now } as any,
      { id: 'usr_paj_bad', email: 'paj-bad@sivan.test', fullName: 'Paj Bad', createdAt: now, updatedAt: now } as any
    ];
    data.customers = [
      { id: 'cus_paj_ok', userId: 'usr_paj_ok', provider: 'bridge', providerCustomerId: 'bridge_ok', kycStatus: 'kyc_approved', tosStatus: 'approved', createdAt: now, updatedAt: now } as any,
      { id: 'cus_paj_bad', userId: 'usr_paj_bad', provider: 'bridge', providerCustomerId: 'bridge_bad', kycStatus: 'kyc_under_review', tosStatus: 'pending', createdAt: now, updatedAt: now } as any
    ];
    data.ngnControls = [];
    data.ngnQuotes = [];
    data.ngnTransfers = [];
    data.ngnWebhooks = [];
  });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const base = `http://127.0.0.1:${(app.server.address() as any).port}`;
  // Sivan's own Level 1 evidence: a payout account resolved against the bank.
  // Holding a Bridge customer is no longer what grants NGN access.
  await db.mutate((data: any) => {
    data.externalAccounts = [
      { id: 'ext_paj_ok', userId: 'usr_paj_ok', customerId: 'cus_paj_ok', provider: 'paj', providerExternalAccountId: 'paj_ext_ok', currency: 'ngn', status: 'verified', createdAt: now, updatedAt: now },
    ];
  });

  const token = signUserJwt({ userId: 'usr_paj_ok', email: 'paj-ok@sivan.test' });
  const badToken = signUserJwt({ userId: 'usr_paj_bad', email: 'paj-bad@sivan.test' });
  const auth = { Authorization: `Bearer ${token}` };
  const badAuth = { Authorization: `Bearer ${badToken}` };
  const admin = { 'x-admin-api-key': 'paj-admin-key' };
  async function req(path: string, options: any = {}, expected = 200) {
    const res = await fetch(`${base}${path}`, { ...options, headers: { 'Content-Type': 'application/json', ...(options.headers || {}) } });
    const json = await res.json().catch(() => ({}));
    assert.equal(res.status, expected, `${path} expected ${expected}, got ${res.status}: ${JSON.stringify(json)}`);
    return json.data ?? json;
  }

  await req('/api/admin/ngn/controls', { method: 'PUT', headers: admin, body: JSON.stringify({ onrampEnabled: true, offrampEnabled: true, activeProvider: 'paj', bankSettlementEnabled: true, virtualAccountEnabled: true, updatedBy: 'paj-test' }) });
  const banks = await req('/api/admin/ngn/paj/banks', { headers: admin });
  assert.equal(banks[0].id, 'bank_access');
  const resolved = await req('/api/admin/ngn/paj/bank-account/resolve?bankId=bank_access&accountNumber=0123456789', { headers: admin });
  assert.equal(resolved.accountName, 'MICHEAL JOHN');
  console.log('✓ PAJ bank list and resolve endpoints work');

  const badQuote = await req('/api/ngn/quote?userId=usr_paj_bad&direction=onramp&sourceCurrency=ngn&destinationCurrency=usdc&sourceAmount=15000', { headers: badAuth }, 403);
  // The block is now Sivan's own verification, not "you lack a Bridge
  // customer". The message names the cheapest way forward rather than pointing
  // at a provider the user has no relationship with.
  assert.match(JSON.stringify(badQuote), /payout bank account|NIN or BVN/);
  console.log('✓ PAJ quotes are blocked by Sivan verification, not by Bridge');

  const quote = await req('/api/ngn/quote?userId=usr_paj_ok&direction=onramp&sourceCurrency=ngn&destinationCurrency=usdc&sourceAmount=15000', { headers: auth });
  assert.equal(quote.provider, 'paj');
  assert.equal(quote.rate, '1500');
  const transfer = await req('/api/ngn/onramp/orders', { method: 'POST', headers: auth, body: JSON.stringify({ userId: 'usr_paj_ok', quoteId: quote.id }) });
  assert.equal(transfer.provider, 'paj');
  assert.equal(transfer.providerTransferId, 'paj_on_1');
  assert.equal(onrampRequest.recipient, 'RecipientSolana111111111111111111111111111');
  console.log('✓ PAJ on-ramp quote and order creation work through provider adapter');

  const offQuote = await req('/api/ngn/quote?userId=usr_paj_ok&direction=offramp&sourceCurrency=usdc&destinationCurrency=ngn&sourceAmount=10', { headers: auth });
  assert.equal(offQuote.provider, 'paj');
  const offTransfer = await req('/api/ngn/offramp/orders', { method: 'POST', headers: auth, body: JSON.stringify({ userId: 'usr_paj_ok', quoteId: offQuote.id }) });
  assert.equal(offTransfer.providerTransferId, 'paj_off_1');
  assert.equal(offTransfer.depositAddress, 'SolanaDepositAddress1111111111111111111111');
  assert.equal(offrampRequest.bank, 'bank_access');
  console.log('✓ PAJ off-ramp quote and order creation return crypto deposit instructions');

  const webhook = await req('/api/webhooks/paj', { method: 'POST', body: JSON.stringify({ id: 'paj_off_1', transactionType: 'OFF_RAMP', status: 'COMPLETED', signature: 'sig_paj_1' }) });
  assert.equal(webhook.provider, 'paj');
  assert.equal(webhook.providerEventId, 'paj_off_1');
  console.log('✓ PAJ public webhook endpoint records provider event');

  await app.close();
  console.log(JSON.stringify({ ok: true, provider: 'paj', onrampTransferId: transfer.id, offrampTransferId: offTransfer.id }, null, 2));
} finally {
  await new Promise<void>((resolve) => paj.close(() => resolve()));
}
