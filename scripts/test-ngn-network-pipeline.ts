/**
 * The NGN network pipeline: Solana, Base and Ethereum.
 *
 * The rule this encodes is the user's: build the pipeline for every network we
 * can support, then switch individual ones OFF in Admin Controls. A network
 * absent from the code needs a deploy to enable; a network present but
 * disabled is one toggle. So capability lives in code, availability lives in
 * controls, and the two must not be confused.
 *
 * What makes this worth testing is that the three networks are NOT
 * interchangeable:
 *
 *   solana   usdc/usdt   both directions
 *   base     usdc        OFF-RAMP ONLY - Breet publishes no Base withdrawal
 *   base     usdt        NEITHER - Breet has no Base USDT asset at all
 *   ethereum usdc/usdt   both directions, but $2-10 gas on a $15 minimum
 *
 * A single shared network list would let a user pick Base for an on-ramp and
 * find out after committing that naira cannot settle there.
 *
 * Run: npm run test:ngn-network-pipeline
 */

import {
  canDeposit,
  canWithdraw,
  usableForOnramp,
  usableForOfframp,
  breetDepositAssetId,
  breetMinimumDepositUsd,
} from '../src/ngn/provider/breet-networks.js';
import { DEFAULT_NETWORK_CONTROLS } from '../src/controls/payment-controls.service.js';

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`); }
}

const LAUNCH = ['solana', 'base', 'ethereum'] as const;

console.log('\nALL THREE LAUNCH NETWORKS SHIP ENABLED');
{
  // The point of the user's instruction: have the pipeline, turn it off later.
  for (const network of LAUNCH) {
    const control = DEFAULT_NETWORK_CONTROLS.find((c) => c.network === network);
    check(`${network} is present in the defaults`, Boolean(control));
    check(`${network} ships enabled`, control?.enabled === true,
      `enabled=${control?.enabled}`);
  }
}

console.log('\nA DEAD NETWORK IS NOT ENABLED BY DEFAULT');
{
  // avalanche_c_chain was the ONLY enabled default, and Breet carries no
  // stablecoin on it either direction - so a fresh deployment offered exactly
  // one network, on which every NGN quote would refuse.
  const avalanche = DEFAULT_NETWORK_CONTROLS.find((c) => c.network === 'avalanche_c_chain');
  check('avalanche is present but disabled', avalanche?.enabled === false,
    `enabled=${avalanche?.enabled}`);
  check('avalanche genuinely supports nothing on the NGN rail',
    !canDeposit('avalanche_c_chain' as any, 'usdc') &&
    !canWithdraw('avalanche_c_chain' as any, 'usdc') &&
    !canDeposit('avalanche_c_chain' as any, 'usdt') &&
    !canWithdraw('avalanche_c_chain' as any, 'usdt'));

  const enabledDefaults = DEFAULT_NETWORK_CONTROLS.filter((c) => c.enabled).map((c) => c.network);
  check('every enabled default can do at least one direction',
    enabledDefaults.every((n) =>
      canDeposit(n as any, 'usdc') || canWithdraw(n as any, 'usdc') ||
      canDeposit(n as any, 'usdt') || canWithdraw(n as any, 'usdt')),
    enabledDefaults.join(','));
}

console.log('\nETHEREUM IS A FULL CITIZEN, BOTH DIRECTIONS BOTH ASSETS');
{
  check('ethereum usdc off-ramps', canDeposit('ethereum' as any, 'usdc'));
  check('ethereum usdc on-ramps', canWithdraw('ethereum' as any, 'usdc'));
  check('ethereum usdt off-ramps', canDeposit('ethereum' as any, 'usdt'));
  check('ethereum usdt on-ramps', canWithdraw('ethereum' as any, 'usdt'));
  check('ethereum usdc has a mainnet asset id',
    breetDepositAssetId('ethereum' as any, 'usdc', 'production') === 'USDC');
  check('ethereum usdt has a mainnet asset id',
    breetDepositAssetId('ethereum' as any, 'usdt', 'production') === 'USDT_ERC20');
}

console.log('\nSOLANA IS THE ONLY FULLY SYMMETRIC NETWORK');
{
  for (const asset of ['usdc', 'usdt'] as const) {
    check(`solana ${asset} works both directions`,
      canDeposit('solana' as any, asset) && canWithdraw('solana' as any, asset));
  }
}

console.log('\nBASE IS OFF-RAMP ONLY, AND HAS NO USDT');
{
  // The asymmetry that a shared network list would hide.
  check('base usdc off-ramps', canDeposit('base' as any, 'usdc'));
  check('base usdc CANNOT on-ramp', !canWithdraw('base' as any, 'usdc'),
    'Breet publishes no Base withdrawal');
  check('base usdt does not exist in either direction',
    !canDeposit('base' as any, 'usdt') && !canWithdraw('base' as any, 'usdt'));
  check('base usdt has no mainnet asset id',
    breetDepositAssetId('base' as any, 'usdt', 'production') === undefined);
}

console.log('\nTHE TWO DIRECTION LISTS ACTUALLY DIFFER');
{
  const enabled = [...LAUNCH] as any[];

  const offUsdc = usableForOfframp(enabled, 'usdc');
  const onUsdc = usableForOnramp(enabled, 'usdc');

  check('usdc off-ramp offers all three', offUsdc.length === 3, offUsdc.join(','));
  check('usdc on-ramp drops base', !onUsdc.includes('base' as any), onUsdc.join(','));
  check('usdc on-ramp keeps solana and ethereum',
    onUsdc.includes('solana' as any) && onUsdc.includes('ethereum' as any), onUsdc.join(','));
  check('the lists are genuinely different', offUsdc.length !== onUsdc.length);

  const offUsdt = usableForOfframp(enabled, 'usdt');
  check('usdt off-ramp excludes base', !offUsdt.includes('base' as any), offUsdt.join(','));
  check('usdt off-ramp keeps solana and ethereum', offUsdt.length === 2, offUsdt.join(','));
}

console.log('\nDISABLING A NETWORK REMOVES IT WITHOUT A DEPLOY');
{
  // The whole reason Ethereum ships enabled: turning it off is a controls
  // change, not a code change.
  const withoutEthereum = ['solana', 'base'] as any[];
  const off = usableForOfframp(withoutEthereum, 'usdc');
  check('ethereum disappears when not enabled', !off.includes('ethereum' as any), off.join(','));
  check('the rest still work', off.includes('solana' as any) && off.includes('base' as any));

  // And an admin cannot enable something Breet cannot do: capability still
  // filters, so a mistaken toggle degrades to "not offered" rather than a
  // failed transfer.
  const withAvalanche = ['solana', 'avalanche_c_chain'] as any[];
  check('enabling avalanche still yields nothing for it',
    !usableForOfframp(withAvalanche, 'usdc').includes('avalanche_c_chain' as any));
}

console.log('\nMINIMUMS ARE PER ASSET, NOT GLOBAL');
{
  // Documented mainnet values. Tron USDT is 20 while everything else is 15,
  // which is why a single constant cannot work.
  check('ethereum usdc mainnet minimum is 15',
    breetMinimumDepositUsd('ethereum' as any, 'usdc', 'production') === 15,
    String(breetMinimumDepositUsd('ethereum' as any, 'usdc', 'production')));
  check('solana usdt mainnet minimum is 15',
    breetMinimumDepositUsd('solana' as any, 'usdt', 'production') === 15);
  check('tron usdt is higher at 20',
    breetMinimumDepositUsd('tron' as any, 'usdt', 'production') === 20,
    String(breetMinimumDepositUsd('tron' as any, 'usdt', 'production')));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
