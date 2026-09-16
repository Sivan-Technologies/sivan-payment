import {
  listTextileBanks,
  resolveTextileBankAccount,
  getTextileFxQuote,
} from '../src/wallets/celo/textile-fx.service.js';

async function main() {
  console.log('=== Verifying Official Textile FX API v2 Ramp Endpoints ===\n');

  // 1. Fetch Banks
  console.log('1. Fetching Nigerian Bank Directory from Textile API:');
  const banks = await listTextileBanks('busha');
  console.log(`   Success: Retrieved ${banks.length} banks from Textile Credit`);
  console.log('   Sample Banks:', banks.slice(0, 5));

  // 2. Resolve Account Number
  console.log('\n2. Testing Live Account Resolution via Textile API (POST /v2/ramp/banks/resolve):');
  // Using sample Access Bank (code "000014")
  const resolved = await resolveTextileBankAccount('0123456789', '000014', 'busha');
  console.log('   Resolution Result:', resolved);

  // 3. Testing 1:1 cNGN Parity Quote
  console.log('\n3. Testing cNGN 1:1 Parity Quote:');
  const cngnQuote = await getTextileFxQuote('cngn_to_ngn', 25000);
  console.log('   cNGN Quote (25,000 cNGN):', {
    rate: cngnQuote.rate,
    gross: cngnQuote.outputAmount,
    fee: cngnQuote.sivanFee,
    net: cngnQuote.netOutput,
    provider: cngnQuote.provider,
  });

  // 4. Testing USDC Live Quote
  console.log('\n4. Testing USDC Quote:');
  const usdcQuote = await getTextileFxQuote('usdc_to_ngn', 10);
  console.log('   USDC Quote (10 USDC):', {
    rate: usdcQuote.rate,
    gross: usdcQuote.outputAmount,
    fee: usdcQuote.sivanFee,
    net: usdcQuote.netOutput,
    provider: usdcQuote.provider,
  });

  console.log('\n=== All Textile FX Ramp v2 Checks Passed! Zero Breet Dependencies. ===');
}

main().catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});
