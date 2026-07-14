import fs from 'node:fs/promises';
import path from 'node:path';
import { buildApp } from '../src/app.js';
import { env } from '../src/config/env.js';

async function main() {
  const dbPath = path.isAbsolute(env.DATABASE_FILE)
    ? env.DATABASE_FILE
    : path.join(process.cwd(), env.DATABASE_FILE);

  await fs.rm(dbPath, { force: true });

  const app = await buildApp();
  await app.listen({ port: 0, host: '127.0.0.1' });

  const address = app.server.address();
  if (!address || typeof address === 'string') throw new Error('Could not resolve test server address');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(`${baseUrl}${url}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json: any = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(`${method} ${url} failed with ${res.status}: ${JSON.stringify(json)}`);
    }
    return json as T;
  }

  try {
    const health = await request<any>('GET', '/health');
    assert(health.status === 'ok', 'health check returned ok');

    const feePolicyResponse = await request<any>('GET', '/api/fees/offramp');
    assert(feePolicyResponse.data.percent === '1.25', 'default off-ramp fee policy is configured at 1.25%');

    const feeEstimateResponse = await request<any>('POST', '/api/fees/offramp/estimate', {
      amount: '100.00',
      currency: 'usd'
    });
    assert(feeEstimateResponse.data.estimatedFeeAmount === '1.25', 'fee estimate calculates 1.25% of 100.00');

    const bridgeCostResponse = await request<any>('GET', '/api/fees/costs/bridge');
    assert(bridgeCostResponse.data.bridgeKycCostUsd === '2.00', 'Bridge KYC cost assumption is configured at $2.00');

    const economicsResponse = await request<any>('POST', '/api/fees/economics/estimate', {
      amount: '100.00',
      currency: 'usd',
      customerType: 'individual',
      includeOnboardingCost: true
    });
    assert(economicsResponse.data.costs.onboardingCost === '2.00', 'unit economics includes one-time KYC cost when requested');

    const email = `e2e+${Date.now()}@sivan.test`;
    const userResponse = await request<any>('POST', '/api/users', {
      email,
      fullName: 'Ada Lovelace'
    });
    const user = userResponse.data;
    assert(Boolean(user.id), 'user signup created a user');

    const customerResponse = await request<any>('POST', '/api/customers/kyc-link', {
      userId: user.id,
      type: 'individual',
      redirectUri: 'https://app.sivan.test/kyc/complete'
    });
    const customer = customerResponse.data;
    assert(customer.kycStatus === 'kyc_approved', 'mock Bridge KYC approved customer');
    assert(customer.onboardingCostUsd === '2.00', 'customer records one-time $2 KYC onboarding cost');
    assert(Boolean(customer.providerCustomerId), 'customer has provider customer id');

    const onboardingCostSummary = await request<any>('GET', '/api/metrics/onboarding-costs');
    assert(onboardingCostSummary.data.onboardingCosts.kycCount >= 1, 'onboarding cost metrics count at least one KYC user');
    assert(Number(onboardingCostSummary.data.onboardingCosts.totalOnboardingCostUsd) >= 2, 'onboarding cost metrics total includes at least $2.00');
    assert(Number(onboardingCostSummary.data.signupExposure.potentialKycCostIfEverySignupVerifiesUsd) >= 2, 'signup exposure shows potential KYC cost for signed-up users');

    const externalAccountResponse = await request<any>('POST', '/api/external-accounts', {
      userId: user.id,
      currency: 'usd',
      accountType: 'us',
      paymentRail: 'ach',
      bankName: 'Lead Bank',
      accountName: 'Ada Checking',
      accountOwnerName: 'Ada Lovelace',
      accountOwnerType: 'individual',
      firstName: 'Ada',
      lastName: 'Lovelace',
      address: {
        street_line_1: '923 Folsom Street',
        country: 'USA',
        state: 'CA',
        city: 'San Francisco',
        postal_code: '94107'
      },
      account: {
        routing_number: '101019644',
        account_number: '215268129123',
        checking_or_savings: 'checking'
      }
    });
    const externalAccount = externalAccountResponse.data;
    assert(externalAccount.status === 'verified', 'USD external account is verified in mock mode');
    assert(externalAccount.accountLast4 === '9123', 'external account stores masked last4');

    const withdrawalResponse = await request<any>('POST', '/api/withdrawals', {
      userId: user.id,
      externalAccountId: externalAccount.id,
      sourceCurrency: 'usdc',
      sourceChain: 'ethereum',
      destinationCurrency: 'usd',
      returnAddress: '0x0000000000000000000000000000000000000000'
    });
    const withdrawal = withdrawalResponse.data.withdrawal;
    const deposit = withdrawalResponse.data.deposit;
    assert(withdrawal.status === 'pending_deposit', 'withdrawal starts pending_deposit');
    assert(withdrawal.feePercent === '1.25', 'withdrawal stores the configured 1.25% fee percent');
    assert(/^0x[a-f0-9]{40}$/i.test(deposit.address), 'deposit address looks like an EVM address');
    assert(deposit.currency === 'usdc', 'deposit currency is USDC');

    const depositResponse = await request<any>('GET', `/api/withdrawals/${withdrawal.id}/deposit-address`);
    assert(depositResponse.data.address === deposit.address, 'deposit address can be fetched by withdrawal id');

    // Verify Avalanche C-Chain off-ramp withdrawal creation
    const avalancheWithdrawalResponse = await request<any>('POST', '/api/withdrawals', {
      userId: user.id,
      externalAccountId: externalAccount.id,
      sourceCurrency: 'usdc',
      sourceChain: 'avalanche',
      destinationCurrency: 'usd',
      returnAddress: '0x0000000000000000000000000000000000000000'
    });
    const avalancheWithdrawal = avalancheWithdrawalResponse.data.withdrawal;
    const avalancheDeposit = avalancheWithdrawalResponse.data.deposit;
    assert(avalancheWithdrawal.status === 'pending_deposit', 'avalanche withdrawal starts pending_deposit');

    const avalancheLAResponse = await request<any>('GET', `/api/deposit-addresses/${avalancheWithdrawal.liquidationAddressId}`);
    assert(avalancheLAResponse.data.chain === 'avalanche', 'withdrawal stores sourceChain as avalanche in liquidation address');
    assert(/^0x[a-f0-9]{40}$/i.test(avalancheDeposit.address), 'avalanche deposit address looks like an EVM address');

    const liquidationAddressResponse = await request<any>('GET', `/api/deposit-addresses/${withdrawal.liquidationAddressId}`);
    const liquidationAddress = liquidationAddressResponse.data;
    assert(Boolean(liquidationAddress.providerLiquidationAddressId), 'internal liquidation address maps to Bridge id');

    const webhookPayload = {
      api_version: 'v0',
      event_id: `wh_e2e_${Date.now()}`,
      event_category: 'liquidation_address.drain',
      event_type: 'liquidation_address.drain.updated.status_transitioned',
      event_object_id: `drain_${Date.now()}`,
      event_object_status: 'payment_processed',
      event_object: {
        id: `drain_${Date.now()}`,
        customer_id: customer.providerCustomerId,
        liquidation_address_id: liquidationAddress.providerLiquidationAddressId,
        amount: '98.75',
        currency: 'usd',
        developer_fee: '1.25',
        state: 'payment_processed',
        deposit_tx_hash: '0xdeposit000000000000000000000000000000000000000000000000000000000000',
        destination_tx_hash: 'ach-trace-123456',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      event_created_at: new Date().toISOString()
    };

    const webhookResponse = await request<any>('POST', '/api/webhooks/bridge', webhookPayload);
    assert(webhookResponse.data.duplicate === false, 'Bridge drain webhook processed once');

    const finalWithdrawalResponse = await request<any>('GET', `/api/withdrawals/${withdrawal.id}`);
    const finalWithdrawal = finalWithdrawalResponse.data;
    assert(finalWithdrawal.status === 'completed', 'webhook moved withdrawal to completed');
    assert(finalWithdrawal.destinationAmount === '98.75', 'webhook stored destination amount after fee');
    assert(finalWithdrawal.feeAmount === '1.25', 'webhook stored final Bridge developer fee amount');
    assert(finalWithdrawal.providerDrainId === webhookPayload.event_object.id, 'webhook stored provider drain id');

    const finalOnboardingCostSummary = await request<any>('GET', '/api/metrics/onboarding-costs');
    assert(Number(finalOnboardingCostSummary.data.recovery.sivanDeveloperFeeRevenueUsd) >= 1.25, 'recovery metrics include Sivan developer fee revenue');
    assert(Number(finalOnboardingCostSummary.data.recovery.estimatedBridgeOfframpCostUsd) >= 0.5, 'recovery metrics estimate Bridge 0.5% off-ramp cost');
    assert(Number(finalOnboardingCostSummary.data.recovery.onboardingCostRecoveredUsd) >= 0.75, 'recovery metrics allocate contribution toward KYC cost recovery');
    assert(Number(finalOnboardingCostSummary.data.recovery.unrecoveredOnboardingCostUsd) >= 0, 'recovery metrics show remaining unrecovered KYC cost');
    assert(Boolean(finalWithdrawal.completedAt), 'completed withdrawal has completedAt');

    const duplicateWebhookResponse = await request<any>('POST', '/api/webhooks/bridge', webhookPayload);
    assert(duplicateWebhookResponse.data.duplicate === true, 'duplicate webhook is idempotent');

    const historyResponse = await request<any>('GET', `/api/users/${user.id}/withdrawals`);
    assert(historyResponse.data.length === 2, 'withdrawal history returns two withdrawals');
    assert(historyResponse.data.some((w: any) => w.status === 'completed'), 'withdrawal history shows completed status');

    console.log('\n✅ Sivan Off-Ramp local E2E test passed');
    console.log(JSON.stringify({
      baseUrl,
      userId: user.id,
      customerId: customer.id,
      externalAccountId: externalAccount.id,
      withdrawalId: withdrawal.id,
      depositAddress: deposit.address,
      finalStatus: finalWithdrawal.status,
      dbPath
    }, null, 2));
  } finally {
    await app.close();
  }
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  console.log(`✓ ${message}`);
}

main().catch((error) => {
  console.error('\n❌ Sivan Off-Ramp local E2E test failed');
  console.error(error);
  process.exit(1);
});
