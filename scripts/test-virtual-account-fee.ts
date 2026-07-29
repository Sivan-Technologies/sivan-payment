import { defaultAdminFeeSettings } from '../src/admin/admin-fees.service.js';
import { getVirtualAccountFeePercent, getDefaultOfframpFeePolicy } from '../src/offramp/service/fees.service.js';

let pass = 0, fail = 0;
const t = (n: string, ok: boolean, x = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✓' : '✗'} ${n}${x ? '\n      ' + x : ''}`); };

(async () => {
  console.log('\n===== virtual account developer fee =====\n');

  const defaults = defaultAdminFeeSettings();
  console.log('  defaults from env:');
  console.log(`    offrampFeePercent        = ${defaults.offrampFeePercent}`);
  console.log(`    virtualAccountFeePercent = ${defaults.virtualAccountFeePercent}`);
  console.log(`    onrampFeePercent         = ${defaults.onrampFeePercent}\n`);

  t('VA fee is no longer hardcoded 0', defaults.virtualAccountFeePercent > 0,
    `got ${defaults.virtualAccountFeePercent}`);
  t('VA fee defaults to the off-ramp fee', defaults.virtualAccountFeePercent === defaults.offrampFeePercent,
    `va=${defaults.virtualAccountFeePercent} offramp=${defaults.offrampFeePercent}`);

  const vaFee = await getVirtualAccountFeePercent();
  const offrampPolicy = await getDefaultOfframpFeePolicy();
  console.log(`\n  resolved VA fee sent to Bridge : ${vaFee}`);
  console.log(`  resolved off-ramp fee          : ${offrampPolicy.percent}\n`);

  t('getVirtualAccountFeePercent returns a value', Boolean(vaFee));
  t('resolved VA fee is greater than zero', Number(vaFee) > 0, `got ${vaFee}`);

  // Bridge charges 0.50% VA orchestration vs 0.25% basic, so the fee must at
  // least clear that cost or every virtual account loses money.
  const BRIDGE_VA_COST = 0.5;
  t('VA fee covers Bridge 0.50% VA orchestration cost', Number(vaFee) > BRIDGE_VA_COST,
    `fee=${vaFee}% cost=${BRIDGE_VA_COST}% margin=${(Number(vaFee) - BRIDGE_VA_COST).toFixed(2)}%`);

  console.log('\n  payload Bridge would receive:');
  console.log('  ' + JSON.stringify({
    developer_fee_percent: vaFee,
    source: { currency: 'usd' },
    destination: { currency: 'usdc', payment_rail: 'solana', bridge_wallet_id: '<user wallet>' },
  }, null, 2).split('\n').join('\n  '));

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  process.exit(fail ? 1 : 0);
})();
