import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE) ? env.DATABASE_FILE : path.join(process.cwd(), env.DATABASE_FILE);
  await fs.rm(dbPath, { force: true });
  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let token = '';
  async function request(method: string, url: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${url} failed ${res.status}: ${JSON.stringify(json)}`);
    return (json.data ?? json) as any;
  }

  try {
    const email = `supplier-${Date.now()}@sivan.test`;
    const started = await request('POST', '/api/auth/email/start', { email, fullName: 'Supplier Payer Ltd', intent: 'signup', legalAcceptance: { accepted: true, termsVersion: 'test', privacyVersion: 'test', riskDisclosureVersion: 'test' } });
    const verified = await request('POST', '/api/auth/email/verify', { email, code: started.devCode });
    token = verified.token;
    const user = verified.user;
    assert(Boolean(user.id), 'user is created');

    const customer = await request('POST', '/api/customers/kyc-link', { userId: user.id, type: 'individual' });
    assert(customer.kycStatus === 'kyc_approved', 'mock Bridge customer is KYC approved');

    const controls = await request('PUT', '/api/admin/supplier-payments/controls', {
      supplierPaymentsEnabled: true,
      thirdPartySupplierPayoutsEnabled: true,
      autoApproveApprovedSuppliers: false,
      requireInvoiceForSupplierPayouts: true,
      manualReviewThreshold: 1000,
      newSupplierFirstPaymentReview: true,
      newCustomerReviewWindowDays: 7,
      newCustomerReviewThreshold: 250,
      highRiskCountries: ['NG'],
      blockedCountries: ['IR', 'KP'],
      dailySupplierPayoutLimit: 5000,
      monthlySupplierPayoutLimit: 25000,
      updatedBy: 'test',
      reason: 'Enable supplier payment risk tests'
    }, { 'x-admin-api-key': 'supplier-admin-key' });
    assert(controls.manualReviewThreshold === 1000, 'admin controls set dynamic supplier threshold');

    /**
     * A VERIFIED PAYOUT ACCOUNT, because releasing a payment provisions a
     * wallet and canProvisionWallet now requires WALLET_MINIMUM_LEVEL = BANK.
     * Without it the release fails with "Add and confirm your payout bank
     * account to create your wallet." Seeded directly: a verified external
     * account is produced by Bridge onboarding, and there is no admin route
     * that mints one - nor should there be.
     */
    {
      const { db } = await import('../src/database/json-database.js');
      const stamp = new Date().toISOString();
      await (db as any).mutate((data: any) => {
        data.externalAccounts = data.externalAccounts ?? [];
        data.externalAccounts.push({
          id: `ext_${user.id}`, userId: user.id, customerId: customer.id,
          provider: 'bridge', providerExternalAccountId: `bridge_ext_${user.id}`,
          currency: 'usd', status: 'verified', createdAt: stamp, updatedAt: stamp,
        });
        return true;
      });
    }

    await request('POST', '/api/admin/balance/adjustments', { userId: user.id, asset: 'usdc', amount: 500, status: 'available', reason: 'Seed supplier payment balance', adjustedBy: 'test' }, { 'x-admin-api-key': 'supplier-admin-key' });
    /**
     * NO bridgeWalletId. The schema rejects it outright:
     *   "Pooled settlement wallets are no longer supported. Virtual accounts
     *    settle into each user's own Bridge wallet."
     *
     * That refusal is the point of the change - a pooled wallet means every
     * user's deposits land in one account and are separated only by a ledger
     * Sivan maintains, which is precisely the arrangement that turns a
     * reconciliation bug into a customer's money going to the wrong person.
     * The test had been sending it since before the removal and failing with a
     * 400 ever since, which is why it was on the known-failing list.
     */
    await request('PUT', '/api/admin/virtual-account-provider-settings', { provider: 'bridge', enabled: true, defaultSettlementAsset: 'usdc', defaultSettlementNetwork: 'base', updatedBy: 'test', reason: 'Configure Bridge virtual account settlement for supplier payouts' }, { 'x-admin-api-key': 'supplier-admin-key' });

    const supplier = await request('POST', `/api/users/${user.id}/suppliers`, {
      supplierName: 'ABC Trading Ltd',
      supplierType: 'business',
      supplierCountry: 'GB',
      currency: 'gbp',
      accountType: 'gb',
      bankName: 'Barclays',
      accountOwnerName: 'ABC Trading Ltd',
      businessName: 'ABC Trading Ltd',
      account: { sort_code: '123456', account_number: '12345678' },
      address: { street_line_1: '1 King Street', country: 'GBR', city: 'London', postal_code: 'SW1A 1AA' }
    });
    assert(supplier.status === 'pending_review', 'new third-party supplier starts pending review');
    assert(supplier.provider === 'bridge', 'supplier route selects Bridge as current execution provider');
    assert(Boolean(supplier.providerExternalAccountId || supplier.bridgeExternalAccountId), 'supplier has generic provider external account id');

    const approvedSupplier = await request('POST', `/api/admin/suppliers/${supplier.id}/review`, { decision: 'approve', reason: 'Invoice/business supplier verified', reviewedBy: 'compliance' }, { 'x-admin-api-key': 'supplier-admin-key' });
    assert(approvedSupplier.status === 'approved', 'admin approves supplier');

    const payment = await request('POST', `/api/users/${user.id}/supplier-payments`, {
      supplierId: supplier.id,
      amount: 300,
      sourceAsset: 'usdc',
      destinationCurrency: 'gbp',
      paymentPurpose: 'Invoice INV-1001 for software services delivered to Supplier Payer Ltd',
      invoiceUrl: 'https://example.com/invoices/inv-1001.pdf'
    });
    assert(payment.status === 'pending_review', 'first supplier payment is held for review');
    assert(payment.aceRiskReview?.aiPolicy?.includes('AI never releases funds'), 'Ace risk review states AI never releases funds');

    const balanceAfterHold = await request('GET', `/api/users/${user.id}/balance`);
    const usdc = balanceAfterHold.balances.find((item: any) => item.asset === 'usdc');
    /**
     * 195.50, NOT 200. The hold covers the GROSS.
     *
     * This asserted 200 (500 - 300) back when supplier payouts were free. The
     * fee is now ADDED - the supplier receives their full 300 GBP-equivalent
     * and the user is debited 304.50 - so a hold of only 300 would leave the
     * release short by exactly the fee.
     *
     * 300 -> 500@1.5% band = 4.50, PLUS the 1.50 one-time supplier setup
     * charge (this is the first payment to this supplier) = 6.00 fee
     * -> 306.00 held -> 194.00 available.
     *
     * The setup charge is a per-RELATIONSHIP cost: the risk engine scores
     * `isFirstPayment` per supplier, and a repeat payment to an approved
     * supplier can auto-approve with no human involved. Recovering it once
     * here is what let the floor drop from 2.00 to 0.50.
     */
    assert(Number(usdc.available) === 194, `supplier payment hold reduces settled USDC available by the gross (got ${usdc.available})`);
    assert(payment.feeAmount === '6.00', `supplier payment records the fee it charged (got ${payment.feeAmount})`);
    assert(payment.feeNewSupplierAmount === '1.50', `first payment to a supplier carries the one-time setup charge (got ${payment.feeNewSupplierAmount})`);
    assert(payment.netAmount === '300.00', `supplier payment records what the supplier receives (got ${payment.netAmount})`);
    assert(payment.amount === '306.00', `supplier payment amount is the gross sent to the provider (got ${payment.amount})`);
    // The gross again: what is held must be what will be sent, or the release
    // draws on funds that were never reserved.
    assert(Number(usdc.held) === 306, `supplier payment hold increases held balance by the gross (got ${usdc.held})`);

    const reviewed = await request('POST', `/api/admin/supplier-payments/${payment.id}/review`, { decision: 'reject', reason: 'Test rejection releases hold', reviewedBy: 'compliance' }, { 'x-admin-api-key': 'supplier-admin-key' });
    assert(reviewed.status === 'rejected', 'admin can reject supplier payment');

    const balanceAfterReject = await request('GET', `/api/users/${user.id}/balance`);
    const releasedUsdc = balanceAfterReject.balances.find((item: any) => item.asset === 'usdc');
    assert(Number(releasedUsdc.available) === 500, 'rejected supplier payment releases hold');

    const secondPayment = await request('POST', `/api/users/${user.id}/supplier-payments`, {
      supplierId: supplier.id,
      amount: 100,
      sourceAsset: 'usdc',
      destinationCurrency: 'gbp',
      paymentPurpose: 'Invoice INV-1002 for support services delivered to Supplier Payer Ltd',
      invoiceUrl: 'https://example.com/invoices/inv-1002.pdf'
    });
    await request('POST', `/api/admin/supplier-payments/${secondPayment.id}/review`, { decision: 'approve', reason: 'Approved for provider release', reviewedBy: 'compliance' }, { 'x-admin-api-key': 'supplier-admin-key' });
    const released = await request('POST', `/api/admin/supplier-payments/${secondPayment.id}/release`, { reason: 'Release approved supplier payment to Bridge test provider', releasedBy: 'compliance' }, { 'x-admin-api-key': 'supplier-admin-key' });
    assert(released.status === 'completed', 'approved supplier payment releases to provider and completes in mock mode');
    assert(Boolean(released.providerTransferId), 'provider transfer id is stored generically');

    const balanceAfterRelease = await request('GET', `/api/users/${user.id}/balance`);
    const finalUsdc = balanceAfterRelease.balances.find((item: any) => item.asset === 'usdc');
    /**
     * 398.00 / 102.00, NOT 400 / 100. The fee is part of what moves.
     *
     * The first payment was REJECTED, so its hold returned the balance to 500
     * and - crucially - it never reached approved/processing/completed, so
     * this second payment is still the first REAL one to this supplier and
     * carries the setup charge.
     *
     * 100 -> 1.5% = 1.50 tiered, plus 1.50 setup = 3.00 -> 103.00 gross.
     *
     * `spent` is the gross for the same reason the hold is: the fee genuinely
     * left the user's balance, and recording only the net would leave the
     * ledger short by every fee Sivan has ever charged.
     */
    assert(Number(finalUsdc.available) === 397, `provider completion debits held supplier payment including the fee (got ${finalUsdc.available})`);
    assert(Number(finalUsdc.spent) === 103, `completed supplier payout increases spent balance by the gross (got ${finalUsdc.spent})`);
    assert(released.feeAmount === '3.00', `a 100 first payment is 1.50 tiered + 1.50 setup (got ${released.feeAmount})`);

    const riskCases = await request('GET', '/api/admin/risk/cases', undefined, { 'x-admin-api-key': 'supplier-admin-key' });
    assert(riskCases.some((item: any) => item.resourceType === 'supplier_payment'), 'supplier payments appear in admin risk cases');

    await app.close();
    console.log('\n✅ Supplier payout risk engine E2E passed');
    console.log(JSON.stringify({ userId: user.id, supplierId: supplier.id, paymentId: payment.id }, null, 2));
  } catch (error) {
    await app.close();
    throw error;
  }
}

function assert(condition: unknown, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
