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

    await request('POST', '/api/admin/balance/adjustments', { userId: user.id, asset: 'usdc', amount: 500, status: 'available', reason: 'Seed supplier payment balance', adjustedBy: 'test' }, { 'x-admin-api-key': 'supplier-admin-key' });
    await request('PUT', '/api/admin/virtual-account-provider-settings', { provider: 'bridge', enabled: true, defaultSettlementAsset: 'usdc', defaultSettlementNetwork: 'base', bridgeWalletId: 'wallet_supplier_test_12345', updatedBy: 'test', reason: 'Configure test Bridge wallet for supplier payouts' }, { 'x-admin-api-key': 'supplier-admin-key' });

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
    assert(Number(usdc.available) === 200, 'supplier payment hold reduces settled USDC available');
    assert(Number(usdc.held) === 300, 'supplier payment hold increases held balance');

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
    assert(Number(finalUsdc.available) === 400, 'provider completion debits held supplier payment');
    assert(Number(finalUsdc.spent) === 100, 'completed supplier payout increases spent balance');

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
