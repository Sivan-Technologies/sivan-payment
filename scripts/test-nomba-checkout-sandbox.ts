import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env.staging') });
dotenv.config({ path: path.resolve(__dirname, '../.env') });

import assert from 'assert';
import { nombaCheckoutService } from '../src/ngn/service/nomba-checkout.service.js';

async function run() {
  console.log('=== NOMBA HOSTED CHECKOUT SMOKE TEST ===\n');

  // 1. Verify Configuration
  console.log('1. Checking Nomba configuration...');
  assert.strictEqual(nombaCheckoutService.isConfigured(), true, 'Nomba credentials must be configured');
  console.log('Nomba Checkout Service is configured with valid credentials.\n');

  // 2. Create Balance Top-Up Checkout Order
  console.log('2. Creating Balance Top-Up Checkout Order (₦5,000)...');
  const depositOrder = await nombaCheckoutService.createCheckoutOrder({
    userId: 'usr_test_founder_001',
    amountNgn: 5000,
    customerEmail: 'founder@sivantech.online',
    purpose: 'deposit',
    callbackUrl: 'https://app.sivantech.online/checkout/callback',
    allowedPaymentMethods: ['Card', 'Transfer', 'USSD', 'Apple Pay'],
  });

  console.log('Deposit Order Result:');
  console.log('• Checkout Link:', depositOrder.checkoutLink);
  console.log('• Order Reference:', depositOrder.orderReference);
  console.log('• Amount:', depositOrder.amountNgn, depositOrder.currency);
  console.log('• Purpose:', depositOrder.purpose);
  console.log('• Allowed Methods:', depositOrder.allowedPaymentMethods.join(', '));

  assert.ok(depositOrder.checkoutLink.length > 0, 'Must return a checkoutLink');
  assert.ok(depositOrder.orderReference.startsWith('sivan_dep_'), 'Must generate sivan_dep_ order reference');
  console.log('Deposit Checkout Order verified successfully.\n');

  // 3. Create Service Agreement Funding Checkout Order
  console.log('3. Creating Service Agreement Funding Checkout Order (₦15,000)...');
  const agreementOrder = await nombaCheckoutService.createCheckoutOrder({
    userId: 'usr_client_002',
    amountNgn: 15000,
    customerEmail: 'client@sivantech.online',
    purpose: 'fund_agreement',
    agreementId: 'agr_mobile_app_991',
    callbackUrl: 'https://app.sivantech.online/agreements/agr_mobile_app_991',
  });

  console.log('Agreement Funding Order Result:');
  console.log('• Checkout Link:', agreementOrder.checkoutLink);
  console.log('• Order Reference:', agreementOrder.orderReference);
  console.log('• Agreement ID:', agreementOrder.agreementId);
  console.log('• Amount:', agreementOrder.amountNgn, agreementOrder.currency);

  assert.ok(agreementOrder.checkoutLink.length > 0, 'Must return a checkoutLink');
  assert.ok(agreementOrder.orderReference.includes('agr_mobile_app_991'), 'Order reference must include agreementId');
  console.log('Agreement Funding Checkout Order verified successfully.\n');

  // 4. Verify Re-Query Endpoint
  console.log('4. Testing Server-Side Re-Query Endpoint...');
  const verification = await nombaCheckoutService.verifyCheckoutTransaction(depositOrder.orderReference);
  console.log('Verification status:', verification.status);
  console.log('Order Reference:', verification.orderReference);
  // An un-paid new order in sandbox is either PENDING or FAILED (not paid yet)
  assert.strictEqual(verification.orderReference, depositOrder.orderReference);
  console.log('Server-side verification round-trip confirmed.\n');

  console.log('=== ALL NOMBA CHECKOUT TESTS PASSED 100% ===');
}

run().catch((err) => {
  console.error('Test failed with error:', err);
  process.exit(1);
});
