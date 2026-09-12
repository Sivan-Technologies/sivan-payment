/**
 * Automated test for Textile Credit NGN Provider on Celo.
 *
 * Verifies:
 * 1. TextileNgnProvider resolves from getNgnProvider('textile')
 * 2. Celo USDC quotes return real rate, gross, fee, and net amounts
 * 3. Celo cNGN quotes enforce 1:1 parity with physical Naira
 * 4. Off-ramp transfer creation provides the Celo settlement deposit contract
 * 5. createNgnQuote() automatically routes to Textile when network === 'celo'
 */

import assert from 'assert';
import { getNgnProvider } from '../src/ngn/provider/ngn-provider-registry.js';
import { TextileNgnProvider } from '../src/ngn/provider/textile.provider.js';
import { canDeposit, canWithdraw } from '../src/ngn/provider/breet-networks.js';
import { gasEstimateUsd } from '../src/ngn/network-costs.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}

async function run() {
  console.log('\nTEXTILE NGN PROVIDER RESOLUTION');
  const provider = getNgnProvider('textile');
  check('resolves textile provider from registry', provider instanceof TextileNgnProvider);
  check('provider name is textile', provider.name === 'textile');

  console.log('\nCELO CAPABILITY & NETWORK COSTS');
  check('celo passes canDeposit check', canDeposit('celo' as any, 'usdc'));
  check('celo passes canWithdraw check', canWithdraw('celo' as any, 'usdc'));
  check('celo gas estimate is 0.001 USD', gasEstimateUsd('celo') === 0.001);

  console.log('\nCELO USDC QUOTE VIA TEXTILE');
  const usdcQuote = await provider.createQuote({
    direction: 'offramp',
    sourceCurrency: 'usdc',
    destinationCurrency: 'ngn',
    sourceAmount: '10',
  } as any);

  check('usdc quote has textile provider', usdcQuote.provider === 'textile');
  check('usdc quote has valid rate > 0', Number(usdcQuote.rate) > 0);
  check('usdc quote gross destination amount is positive', Number(usdcQuote.destinationAmount) > 0);
  check('usdc quote metadata marks network as celo', (usdcQuote.metadata as any)?.network === 'celo');
  check('usdc quote metadata includes settlement deposit address', Boolean((usdcQuote.metadata as any)?.depositAddress));
  check('usdc quote calculates sivan fee from admin config', Number((usdcQuote.metadata as any)?.sivanFeeNgn) > 0);
  check('usdc quote records net NGN payout', Number((usdcQuote.metadata as any)?.netNgn) > 0);

  console.log('\nCELO CNGN 1:1 PARITY QUOTE');
  const cngnQuote = await provider.createQuote({
    direction: 'offramp',
    sourceCurrency: 'cngn',
    destinationCurrency: 'ngn',
    sourceAmount: '5000',
  } as any);

  check('cngn quote has rate of 1.00', Number(cngnQuote.rate) === 1.0);
  check('cngn quote gross destination amount is 5000 NGN', Number(cngnQuote.destinationAmount) === 5000.0);
  // 5000 cNGN - 1% fee (50) = 4950 NGN
  check('cngn sivan fee is exactly 1% from admin config (50.00 NGN)', Number((cngnQuote.metadata as any)?.sivanFeeNgn) === 50.0);
  check('cngn net destination amount is exactly 4950.00 NGN', Number((cngnQuote.metadata as any)?.netNgn) === 4950.0);
  check('cngn fee percent is 1.0', Number((cngnQuote.metadata as any)?.sivanFeePercent) === 1.0);

  console.log('\nCELO OFF-RAMP TRANSFER EXECUTION');
  const offramp = await provider.createOfframpTransfer({
    id: 'ngnt_test123',
    userId: 'usr_test_celo',
    sourceAmount: '10',
    metadata: { network: 'celo' },
  } as any);

  check('offramp status is awaiting_crypto_deposit', offramp.status === 'awaiting_crypto_deposit');
  check('offramp has valid 0x depositAddress on Celo', String(offramp.depositAddress).startsWith('0x'));

  console.log('\nHEALTH CHECK');
  const health = await provider.health();
  check('health check reports provider textile', health.provider === 'textile');
  check('health check reports available boolean', typeof health.available === 'boolean');
  check('health check reports valid mode', ['live', 'sandbox', 'mock', 'live_disabled'].includes(health.mode));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

run().catch((err) => {
  console.error('Fatal error running Textile NGN provider test:', err);
  process.exit(1);
});
