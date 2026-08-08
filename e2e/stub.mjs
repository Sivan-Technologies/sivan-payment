// Correctly-SHAPED API stub. Several endpoints must return arrays, not {} --
// returning {} crashes the app into the Sentry error boundary.
export function makeStub(userId = 'u_1') {
  return async (route) => {
    const url = new URL(route.request().url());
    const p = url.pathname;
    const j = (o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
    const U = `/api/users/${userId}`;

    if (p === '/api/system/status') return j({ status: 'ok', maintenance: false, paymentsPaused: false });
    if (p === '/api/offramp/controls') return j({
      withdrawalsEnabled: true, buyEnabled: true, transfersEnabled: true,
      supplierPayoutsEnabled: true, ngnOfframpFeePercent: 1, ngnProviderFeePercent: 0.5,
      newUserSignups: true, virtualAccountsEnabled: true,
      sourceAssets: [{ asset: 'usdc', label: 'USDC' }, { asset: 'usdt', label: 'USDT' }],
      sourceNetworks: [{ network: 'solana', label: 'Solana' }, { network: 'base', label: 'Base' }],
      payoutCurrencies: ['USD','NGN','GBP','EUR'] });
    if (p === '/api/fees/offramp') return j({ percent: 1.25, minimumUsd: 0.5, maximumUsd: 0 });
    if (p === '/api/ngn/networks') return j({
      offramp: [{ network: 'solana', label: 'Solana', minimumDepositUsd: 5, gasEstimateUsd: 0.001 },
                { network: 'base', label: 'Base', minimumDepositUsd: 5, gasEstimateUsd: 0.01 }],
      onramp:  [{ network: 'solana', label: 'Solana', minimumDepositUsd: 5, gasEstimateUsd: 0.001 }] });

    // Shaped from the VerificationSummary interface in src/types.ts, not guessed.
    if (p === `${U}/verification-summary`) return j({
      level: 3, levelLabel: 'Level 3: Full access', path: 'bridge_kyc', country: 'NG',
      checks: { identity: 'approved', bank: 'approved', nin: 'approved',
                bvn: 'approved', proofOfAddress: 'approved', sourceOfFunds: 'approved' },
      identitySource: 'bridge', upliftApplies: false,
      terms: { required: true, accepted: true },
      identityComplete: true, pathComplete: true,
      hasPayoutAccount: true, hasPendingPayoutReview: false, windowDays: 30,
      // App.tsx:274 does verificationSummary?.allowances.find(...) -- the optional
      // chain guards the summary, NOT the array, so this key is mandatory.
      allowances: [
        { flow: 'offramp', rail: 'ngn', allowed: true, limitUsd: 100000, usedUsd: 1200, remainingUsd: 98800 },
        { flow: 'offramp', rail: 'ach', allowed: true, limitUsd: 100000, usedUsd: 0, remainingUsd: 100000 },
        { flow: 'onramp',  rail: 'ngn', allowed: true, limitUsd: 100000, usedUsd: 0, remainingUsd: 100000 } ],
    });
    if (p === `/api/customers/${userId}`) return j({
      id: 'cus_1', status: 'approved', kycStatus: 'approved',
      hasAcceptedTermsOfService: true, endorsements: [] });
    // Field names taken from AppSections.tsx:1678 (paymentRail, accountLast4),
    // which calls .replaceAll on the rail with no guard.
    if (p === `${U}/external-accounts`) return j([
      { id: 'ea_1', bankName: 'GTBank', accountLast4: '6789', accountName: 'Micheal Samson',
        currency: 'ngn', paymentRail: 'ngn_bank', status: 'approved',
        createdAt: '2026-02-01T09:00:00Z' },
      { id: 'ea_2', bankName: 'Lead Bank', accountLast4: '4417', accountName: 'Micheal Samson',
        currency: 'usd', paymentRail: 'ach_push', status: 'approved',
        createdAt: '2026-03-01T09:00:00Z' } ]);
    if (p === `${U}/withdrawals`) return j([
      { id: 'wd_1', reference: 'SVN-88213', status: 'completed', amount: '500.00', asset: 'USDC',
        currency: 'USD', payoutCurrency: 'USD', createdAt: '2026-08-01T10:00:00Z' },
      { id: 'wd_2', reference: 'SVN-88214', status: 'processing', amount: '250.00', asset: 'USDC',
        currency: 'NGN', payoutCurrency: 'NGN', createdAt: '2026-08-05T10:00:00Z' },
      { id: 'wd_3', reference: 'SVN-88215', status: 'failed', amount: '75.00', asset: 'USDC',
        currency: 'USD', payoutCurrency: 'USD', createdAt: '2026-08-06T10:00:00Z' } ]);
    // TradeTransferSections.tsx:167 does order.sourceCurrency.toUpperCase().
    if (p === `${U}/onramp-orders`) return j([
      { id: 'on_1', reference: 'BUY-4410', status: 'completed', amount: '300.00',
        sourceCurrency: 'ngn', destinationCurrency: 'usdc', destinationChain: 'solana',
        asset: 'usdc', bankName: 'Providus Bank', accountNumber: '9901234567',
        depositMessage: 'BUY-4410', createdAt: '2026-07-20T11:00:00Z' } ]);
    if (p === `${U}/virtual-accounts`) return j({
      requests: [], transactions: [], events: [],
      accounts: [{ id: 'va_1', currency: 'USD', status: 'active', bankName: 'Lead Bank',
        accountNumberLast4: '4417', routingNumber: '101019644' }] });
    // NOTE: both of these must expose `balances` -- App.tsx and
    // TradeTransferSections both do `?.balances.find(...)` with no guard on
    // the array itself, so a wrong key throws before any pixel renders.
    if (p === `${U}/balance`) return j({ credits: [], holds: [], entries: [],
      balances: [{ asset: 'usdc', chain: 'solana', amount: '1250.00', usd: '1250.00',
        available: '1250.00', held: '0.00' }] });
    if (p === `${U}/balance/unified`) return j({
      totalUsd: '1250.00', availableUsd: '1250.00', heldUsd: '0.00',
      balances: [{ asset: 'usdc', chain: 'solana', amount: '1250.00', usd: '1250.00',
        available: '1250.00', held: '0.00' }] });
    if (p === `${U}/balance/transfers`) return j([]);
    if (p === `${U}/balance/deposits`) return j([]);
    if (p === `${U}/suppliers`) return j([]);
    if (p === `${U}/supplier-payments`) return j([]);
    if (p === `${U}/ngn-transfers`) return j([]);
    if (p === `${U}/support/tickets`) return j([]);
    if (p === `${U}/preferences`) return j({ notifications: { email: true, whatsapp: false }, currency: 'USD' });
    if (p === '/api/users/me/identity') return j({ whatsapp: null, telegram: null });
    if (p === `${U}/2fa`) return j({ enabled: false, methods: [] });
    if (p === `${U}/wallets`) return j([
      { id: 'w_1', chain: 'solana', asset: 'USDC', provider: 'privy',
        address: 'HN7cABqLq46Es1jh92dQQpXBoUn3xSzXk1uMv6d3sB2', balance: '1250.00' } ]);
    return j({});
  };
}
export const STUB_USER = {
  id: 'u_1', email: 'micheal@sivantech.online', fullName: 'Micheal Samson',
  kycStatus: 'approved', status: 'active', createdAt: '2026-01-01T00:00:00Z',
};
