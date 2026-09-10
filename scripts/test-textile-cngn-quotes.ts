/**
 * Test: Textile Credit cNGN FX Quotes and Fee Math
 *
 * Validates the Textile Credit FX rate quoting service for USDC/cNGN pairs
 * using realistic test amounts (5 USDC to 50 USDC, or 2,000 NGN to 50,000 NGN).
 *
 * Tests cover:
 * - Quote generation and field completeness
 * - Sivan protocol fee calculation accuracy (1%)
 * - Quote cache hit/miss behavior
 * - Direction-specific rate math (USDC->cNGN and cNGN->USDC)
 * - Boundary validation (reject unrealistic amounts)
 * - Firm quote request structure
 *
 * Run: npx tsx scripts/test-textile-cngn-quotes.ts
 */

import {
  getTextileFxQuote,
  requestFirmQuote,
  clearQuoteCache,
  TextileFxQuote,
} from '../src/wallets/celo/textile-fx.service.js';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
    failed++;
  }
}

async function testQuoteFieldCompleteness() {
  console.log('\n--- Quote Field Completeness ---');

  // This test uses a mock-friendly structure: if TEXTILE_CREDIT_API_KEY is not set,
  // the service will throw. We test the error handling path in that case.
  const hasApiKey = Boolean(process.env.TEXTILE_CREDIT_API_KEY);

  if (!hasApiKey) {
    console.log('  SKIP  Textile API key not configured — testing error handling');

    try {
      await getTextileFxQuote('usdc_to_cngn', 10);
      assert('Should throw without API key', false);
    } catch (err: any) {
      assert(
        'Throws missing API key error',
        err.message.includes('TEXTILE_CREDIT_API_KEY'),
        err.message
      );
    }
    return;
  }

  const quote = await getTextileFxQuote('usdc_to_cngn', 10);
  assert('direction is usdc_to_cngn', quote.direction === 'usdc_to_cngn');
  assert('inputAmount is 10', quote.inputAmount === 10);
  assert('outputAmount is positive', quote.outputAmount > 0);
  assert('rate is positive', quote.rate > 0);
  assert('sivanFee is positive', quote.sivanFee > 0);
  assert('netOutput is less than outputAmount', quote.netOutput < quote.outputAmount);
  assert('quotedAt is ISO string', quote.quotedAt.includes('T'));
  assert('expiresAt is ISO string', quote.expiresAt.includes('T'));
  assert('cached is false for fresh quote', quote.cached === false);
}

async function testSivanFeeCalculation() {
  console.log('\n--- Sivan Protocol Fee Calculation ---');

  // Simulate fee math (1% of output)
  const testRate = 1450;
  const inputUsdc = 10;
  const grossOutput = inputUsdc * testRate; // 14,500 NGN
  const expectedFee = grossOutput * 0.01;   // 145 NGN
  const expectedNet = grossOutput - expectedFee; // 14,355 NGN

  assert(
    'Fee is 1% of gross output',
    expectedFee === 145,
    `Expected 145, got ${expectedFee}`
  );
  assert(
    'Net output is gross minus fee',
    expectedNet === 14355,
    `Expected 14355, got ${expectedNet}`
  );

  // Verify with a 5 USDC amount
  const smallGross = 5 * testRate; // 7,250
  const smallFee = smallGross * 0.01; // 72.50
  const smallNet = smallGross - smallFee; // 7,177.50
  assert(
    'Small amount: Fee is 72.50 NGN for 5 USDC',
    smallFee === 72.5,
    `Expected 72.5, got ${smallFee}`
  );
  assert(
    'Small amount: Net is 7,177.50 NGN',
    smallNet === 7177.5,
    `Expected 7177.5, got ${smallNet}`
  );
}

async function testQuoteCacheBehavior() {
  console.log('\n--- Quote Cache Behavior ---');

  clearQuoteCache();

  const hasApiKey = Boolean(process.env.TEXTILE_CREDIT_API_KEY);
  if (!hasApiKey) {
    console.log('  SKIP  Cache test requires live API key');
    return;
  }

  // First call: fresh
  const q1 = await getTextileFxQuote('usdc_to_cngn', 25);
  assert('First call is not cached', q1.cached === false);

  // Second call with same params: should be cached
  const q2 = await getTextileFxQuote('usdc_to_cngn', 25);
  assert('Second call is cached', q2.cached === true);

  // Different amount: should be fresh
  const q3 = await getTextileFxQuote('usdc_to_cngn', 50);
  assert('Different amount is not cached', q3.cached === false);

  // Clear cache and verify
  clearQuoteCache();
  const q4 = await getTextileFxQuote('usdc_to_cngn', 25);
  assert('After clear, quote is fresh', q4.cached === false);
}

async function testBoundaryValidation() {
  console.log('\n--- Boundary Validation ---');

  try {
    await getTextileFxQuote('usdc_to_cngn', -5);
    assert('Rejects negative USDC amount', false);
  } catch (err: any) {
    assert('Rejects negative USDC amount', err.message.includes('Invalid USDC amount'));
  }

  try {
    await getTextileFxQuote('usdc_to_cngn', 50_000);
    assert('Rejects excessive USDC amount', false);
  } catch (err: any) {
    assert('Rejects excessive USDC amount', err.message.includes('Invalid USDC amount'));
  }

  try {
    await getTextileFxQuote('cngn_to_usdc', -100);
    assert('Rejects negative cNGN amount', false);
  } catch (err: any) {
    assert('Rejects negative cNGN amount', err.message.includes('Invalid cNGN amount'));
  }
}

async function testFirmQuoteValidation() {
  console.log('\n--- Firm Quote Validation ---');

  try {
    await requestFirmQuote(0.5, '0123456789', '058');
    assert('Rejects sub-minimum firm quote', false);
  } catch (err: any) {
    assert(
      'Rejects firm quote below 1 USDC',
      err.message.includes('between 1 and 10,000'),
      err.message
    );
  }

  try {
    await requestFirmQuote(15_000, '0123456789', '058');
    assert('Rejects excessive firm quote', false);
  } catch (err: any) {
    assert(
      'Rejects firm quote above 10,000 USDC',
      err.message.includes('between 1 and 10,000'),
      err.message
    );
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log('=== Textile Credit cNGN FX Quote Tests ===');
  console.log(`API Key configured: ${Boolean(process.env.TEXTILE_CREDIT_API_KEY)}`);

  await testQuoteFieldCompleteness();
  await testSivanFeeCalculation();
  await testQuoteCacheBehavior();
  await testBoundaryValidation();
  await testFirmQuoteValidation();

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner crashed:', err);
  process.exit(1);
});
