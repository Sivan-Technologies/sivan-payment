import { offrampRegistry } from '../src/offramp/provider/offramp-registry.js';
import { textileOfframpProvider } from '../src/offramp/provider/textile-offramp.provider.js';

let passed = 0;
let failed = 0;

function assert(label: string, condition: boolean, detail?: string): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
    failed++;
  }
}

async function main() {
  console.log('=== Sivan Off-Ramp Adapter & Registry Unit Tests ===');

  // 1. Registry Resolution
  console.log('\n--- 1. Registry Resolution ---');
  const provider = offrampRegistry.resolveProvider('NG', 'celo');
  assert('Resolves textile provider for NG on celo', provider.name === 'textile');
  assert('Provider is registered in map', offrampRegistry.get('textile')?.name === 'textile');

  // 2. cNGN 1:1 Parity Quoting
  console.log('\n--- 2. cNGN 1:1 Parity Quoting ---');
  const cngnAmount = 5000;
  const quote = await textileOfframpProvider.getQuote({
    country: 'NG',
    network: 'celo',
    sourceToken: 'cNGN',
    amount: cngnAmount,
  });

  assert('Rate is exactly 1.0 (strict 1:1 parity)', quote.rate === 1.0);
  assert('Gross payout equals input amount', quote.grossPayout === cngnAmount);
  assert('Protocol fee is positive and reasonable', quote.protocolFee > 0 && quote.protocolFee < cngnAmount);
  assert('Net payout equals gross minus fee', quote.netPayout === quote.grossPayout - quote.protocolFee);
  assert('Deposit address is valid Celo 0x address', quote.depositAddress.startsWith('0x') && quote.depositAddress.length === 42);
  assert('Destination currency is NGN', quote.destinationCurrency === 'NGN');
  assert('Valid for seconds is 60', quote.validForSeconds === 60);

  // 3. Realistic Test Amount Validation (5 to 50 cNGN / 2,000 to 50,000 NGN)
  console.log('\n--- 3. Realistic Amount Validation ---');
  const realisticQuote = await offrampRegistry.getQuote({
    country: 'NG',
    network: 'celo',
    sourceToken: 'CNGN',
    amount: 10000,
  });
  assert('Realistic 10,000 cNGN quote succeeds', realisticQuote.netPayout > 9000);

  // 4. Boundary Error Handling
  console.log('\n--- 4. Boundary Error Handling ---');
  try {
    await textileOfframpProvider.getQuote({
      country: 'NG',
      network: 'celo',
      sourceToken: 'cNGN',
      amount: -500,
    });
    assert('Rejects negative amount', false);
  } catch (err: any) {
    assert('Rejects negative amount', err.message.includes('must be positive'));
  }

  // 5. Bank Directory Listing
  console.log('\n--- 5. Bank Directory ---');
  const banks = await offrampRegistry.listBanks('NG', 'celo');
  assert('Returns bank list array', Array.isArray(banks) && banks.length > 0);
  const gtbank = banks.find(b => b.name.includes('Guaranty') || b.code === '000013');
  assert('Includes GTBank in Nigerian bank list', Boolean(gtbank));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Test runner failed:', err);
  process.exit(1);
});
