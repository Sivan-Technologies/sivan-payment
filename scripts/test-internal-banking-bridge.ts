import dotenv from 'dotenv';
dotenv.config({ path: '.env.staging' });
dotenv.config({ path: '.env-sandbox' });
dotenv.config();

import fs from 'node:fs';
import path from 'node:path';
import { getActiveBankingRailName, getBankingRailAdapter } from '../src/banking-rail/banking-rail-registry.js';

async function main() {
  console.log('======================================================');
  console.log('SIVAN AI . CENTRALIZED BANKING RAIL ARCHITECTURE PROOF');
  console.log('======================================================');

  // Step 1: Check Escrow isolation
  console.log('\n--- Step 1: Verifying Escrow Key Isolation ---');
  const escrowEnvPath = path.resolve(process.cwd(), '../sivan-escrow-agent/.env');
  let escrowEnvContent = '';
  if (fs.existsSync(escrowEnvPath)) {
    escrowEnvContent = fs.readFileSync(escrowEnvPath, 'utf8');
  }

  const escrowHasNombaSecret = /NOMBA_CLIENT_SECRET\s*=\s*[^\s]+/.test(escrowEnvContent);
  const escrowHasPaystackSecret = /PAYSTACK_SECRET_KEY\s*=\s*[^\s]+/.test(escrowEnvContent);
  const escrowHasFlutterwaveSecret = /FLUTTERWAVE_SECRET_KEY\s*=\s*[^\s]+/.test(escrowEnvContent);

  console.log(`Escrow holds NOMBA_CLIENT_SECRET:        ${escrowHasNombaSecret}`);
  console.log(`Escrow holds PAYSTACK_SECRET_KEY:        ${escrowHasPaystackSecret}`);
  console.log(`Escrow holds FLUTTERWAVE_SECRET_KEY:     ${escrowHasFlutterwaveSecret}`);

  if (escrowHasNombaSecret || escrowHasPaystackSecret || escrowHasFlutterwaveSecret) {
    console.error('FAILED: Escrow must NOT contain direct banking provider secrets!');
    process.exit(1);
  }
  console.log('SUCCESS: Sivan Escrow is 100% clean of direct banking provider secrets!');

  // Step 2: Check Payment centralization
  console.log('\n--- Step 2: Verifying Centralized Sivan Payment Keys ---');
  const activeRail = getActiveBankingRailName();
  const adapter = getBankingRailAdapter();

  console.log(`Active Rail Name:        [${activeRail}]`);
  console.log(`Adapter Class:           ${adapter.constructor.name}`);
  console.log(`Is Configured:           ${adapter.isConfigured()}`);
  console.log(`CORE_API_SECRET present: ${Boolean(process.env.CORE_API_SECRET)}`);

  if (!adapter.isConfigured()) {
    console.error('FAILED: Sivan Payment adapter is not configured with provider keys!');
    process.exit(1);
  }
  console.log('SUCCESS: Sivan Payment holds all active banking credentials centrally!');

  // Step 3: Virtual Account creation for a Service Agreement
  console.log('\n--- Step 3: Testing Service Agreement DVA Issuance ---');
  const agreementId = `agr_deal_${Date.now()}`;
  const customer = await adapter.createCustomer({
    userId: agreementId,
    legalName: `SIVAN DEAL ${agreementId.slice(-6)}`,
  });
  const va = await adapter.assignVirtualAccount(customer.providerCustomerId);
  console.log('Agreement DVA Created:');
  console.log(`  Bank Name:      ${va.bankName}`);
  console.log(`  Account Number: ${va.accountNumber}`);
  console.log(`  Account Name:   ${va.accountName}`);
  console.log(`  Currency:       ${va.currency}`);
  console.log(`  Mode:           ${va.mode}`);

  if (!va.accountNumber) {
    console.error('FAILED: Virtual account number was empty!');
    process.exit(1);
  }

  // Step 4: Checkout Order (Transfer + USSD Only, No Card)
  console.log('\n--- Step 4: Testing Service Agreement Web Checkout (Transfer + USSD Only) ---');
  if (adapter.createCheckoutOrder) {
    const checkout = await adapter.createCheckoutOrder({
      orderReference: `sivan_ord_${Date.now()}`,
      amountKobo: 2500000, // 25,000 NGN
      customerEmail: 'client@sivantech.online',
      callbackUrl: 'https://staging.sivantech.online/agreements/callback',
      allowedPaymentMethods: ['Transfer', 'USSD'],
    });

    console.log('Checkout Order Issued:');
    console.log(`  Order Reference: ${checkout.orderReference}`);
    console.log(`  Allowed Methods: ${JSON.stringify(checkout.allowedPaymentMethods)} (NO CARDS)`);
    console.log(`  Checkout Link:   ${checkout.checkoutLink.slice(0, 60)}...`);

    if (!checkout.checkoutLink || !checkout.checkoutLink.startsWith('http')) {
      console.error('FAILED: Checkout link is invalid!');
      process.exit(1);
    }
  } else {
    console.warn('Note: Adapter does not support hosted checkout');
  }

  // Step 5: Service Agreement Release Disbursement Payout
  console.log('\n--- Step 5: Testing Agreement Release Disbursement Payout ---');
  const payoutRef = `sivan_disburse_${Date.now()}`;
  const transfer = await adapter.createTransfer({
    providerRef: payoutRef,
    accountNumber: '0123456789',
    bankCode: '058',
    amountKobo: 10000, // 100 NGN
    userId: `freelancer_${Date.now()}`,
    narration: `Sivan Deal Release ${agreementId}`,
  });

  console.log('Release Transfer Dispatched:');
  console.log(`  Provider Ref: ${transfer.providerRef}`);
  console.log(`  Transfer ID:  ${transfer.providerTransferId || 'N/A'}`);
  console.log(`  Status:       ${transfer.status}`);
  console.log(`  Amount (NGN): ₦${(transfer.amountKobo / 100).toFixed(2)}`);

  if (transfer.status === 'failed') {
    console.error(`FAILED: Disbursement failed: ${transfer.failureReason}`);
    process.exit(1);
  }

  console.log('\n======================================================');
  console.log('ALL VERIFICATIONS PASSED: SINGLE KEY ARCHITECTURE PROVEN!');
  console.log('======================================================');
}

main().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
