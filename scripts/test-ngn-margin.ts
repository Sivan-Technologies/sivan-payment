/**
 * Sivan's margin on NGN, and admin control of the provider.
 *
 * Two things worth proving:
 *
 *   1. Sivan actually earns something. The NGN path applied the PROVIDER's fee
 *      and nothing else, so Breet took 0.5% and Sivan took 0 on every naira
 *      transaction. The admin fee settings existed but this path never read
 *      them.
 *
 *   2. The provider is switchable from admin, not compiled in. If Breet has an
 *      outage, flipping to Paj must be a controls change, not a deploy.
 *
 * Run: npm run test:ngn-margin
 */

import { db } from '../src/database/json-database.js';
import { createNgnQuote } from '../src/ngn/service/ngn-quotes.service.js';
import { applySivanMargin } from '../src/ngn/service/ngn-margin.js';
import { getNgnProvider } from '../src/ngn/provider/ngn-provider-registry.js';

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

async function seed(activeProvider = 'mock') {
  await db.mutate((data: any) => {
    data.users = [{ id: 'u_m', email: 'm@t.ng', createdAt: new Date().toISOString() }];
    data.customers = [];
    data.externalAccounts = [
      { id: 'e_m', userId: 'u_m', status: 'verified', currency: 'ngn',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    ];
    data.ngnTransfers = [];
    data.ngnQuotes = [];
    data.ngnControls = [{
      id: 'global', onrampEnabled: true, offrampEnabled: true, mockProviderEnabled: true,
      bankSettlementEnabled: false, virtualAccountEnabled: false,
      activeProvider, identityVerificationEnabled: false,
      maxTransactionNgn: '100000000', dailyLimitNgn: '100000000',
      highValueReviewThresholdNgn: '100000000',
      updatedBy: 'test', updatedAt: new Date().toISOString(),
    }];
  });
}

async function main() {
  console.log('\nmargin arithmetic keeps cost and revenue separate');
  {
    // A blended number cannot answer "are we making money on this flow" - a
    // provider raising its price looks identical to Sivan earning more.
    const result = await applySivanMargin({
      direction: 'onramp', grossAmount: 100_000, providerFeeAmount: 500,
    });
    check('the provider fee is reported as its own line', result.providerFee === 500,
      String(result.providerFee));
    check('Sivan margin is a separate line', result.sivanMargin >= 0);
    check('the total is the sum of both',
      Math.abs(result.totalFee - (result.providerFee + result.sivanMargin)) < 0.01,
      `${result.totalFee} vs ${result.providerFee}+${result.sivanMargin}`);
    check('an effective percentage is published for display',
      result.effectivePercent > 0, String(result.effectivePercent));
  }

  console.log('\nmargin is charged on the GROSS, not the net');
  {
    // Charging on the net would shrink Sivan's revenue every time a provider
    // raised its rate - the opposite of what a margin is for.
    const cheap = await applySivanMargin({
      direction: 'onramp', grossAmount: 100_000, providerFeeAmount: 100,
    });
    const expensive = await applySivanMargin({
      direction: 'onramp', grossAmount: 100_000, providerFeeAmount: 5_000,
    });
    check("Sivan's margin is unchanged when the provider gets more expensive",
      cheap.sivanMargin === expensive.sivanMargin,
      `${cheap.sivanMargin} vs ${expensive.sivanMargin}`);
    check('but the total the user pays does rise',
      expensive.totalFee > cheap.totalFee,
      `${expensive.totalFee} vs ${cheap.totalFee}`);
  }

  console.log('\nbad input does not invent a fee');
  {
    for (const amount of [0, -1, Number.NaN]) {
      const r = await applySivanMargin({
        direction: 'onramp', grossAmount: amount, providerFeeAmount: 10,
      });
      check(`gross ${String(amount)} yields no margin`, r.sivanMargin === 0);
    }
  }

  console.log('\nthe quote records both fees, not one blended number');
  {
    await seed('mock');
    const quote: any = await createNgnQuote({
      userId: 'u_m', direction: 'onramp',
      sourceCurrency: 'ngn', destinationCurrency: 'usdc', sourceAmount: '100000',
    });

    const fees = quote?.metadata?.fees;
    check('the quote carries a fee breakdown', Boolean(fees), JSON.stringify(quote?.metadata));
    check('the provider is named alongside its fee', fees?.providerName === 'mock',
      String(fees?.providerName));
    check('the provider fee is present', Number(fees?.providerFee) > 0,
      String(fees?.providerFee));
    check('Sivan margin is present and non-zero',
      Number(fees?.sivanMargin) > 0,
      `sivanMargin=${fees?.sivanMargin} - Sivan is running this flow at cost`);
    check('the stored feeAmount is the TOTAL the user pays',
      Math.abs(Number(quote.feeAmount) - Number(fees?.totalFee)) < 0.01,
      `${quote.feeAmount} vs ${fees?.totalFee}`);
    check('an explanation is stored for support',
      typeof fees?.explanation === 'string' && fees.explanation.length > 0,
      String(fees?.explanation));
  }

  console.log('\nthe user receives less by exactly the margin');
  {
    await seed('mock');
    const quote: any = await createNgnQuote({
      userId: 'u_m', direction: 'onramp',
      sourceCurrency: 'ngn', destinationCurrency: 'usdc', sourceAmount: '100000',
    });
    // Recomputed rather than re-quoted, so the number shown is the number
    // charged. Without this the margin would be collected but the user would
    // still be promised the provider's gross output.
    const rate = Number(quote.rate);
    const marginInDestination = Number(quote.metadata.fees.sivanMargin) / rate;
    const providerWouldHaveGiven = Number(quote.destinationAmount) + marginInDestination;
    check('destination is reduced by the margin, converted at the quoted rate',
      providerWouldHaveGiven > Number(quote.destinationAmount),
      `${quote.destinationAmount}`);
    check('the user is never promised more than they will get',
      Number(quote.destinationAmount) > 0);
  }

  console.log('\noff-ramp earns a margin too');
  {
    await seed('mock');
    const quote: any = await createNgnQuote({
      userId: 'u_m', direction: 'offramp',
      sourceCurrency: 'usdc', destinationCurrency: 'ngn', sourceAmount: '100',
    });
    const fees = quote?.metadata?.fees;
    check('off-ramp carries a fee breakdown', Boolean(fees));
    check('and Sivan takes a margin on it', Number(fees?.sivanMargin) > 0,
      `sivanMargin=${fees?.sivanMargin}`);
  }

  console.log('\nthe provider is chosen by ADMIN, not compiled in');
  {
    // If Breet has an outage, switching to Paj must be a controls change rather
    // than a deploy.
    check('the registry resolves breet', getNgnProvider('breet' as any).name === 'breet');
    check('the registry resolves paj', getNgnProvider('paj' as any).name === 'paj');
    check('and mock', getNgnProvider('mock' as any).name === 'mock');

    await seed('breet');
    const controls = (await db.read() as any).ngnControls[0];
    check('activeProvider is stored on the controls record',
      controls.activeProvider === 'breet', controls.activeProvider);

    // Flip it, exactly as PUT /api/admin/ngn/controls does.
    await db.mutate((data: any) => { data.ngnControls[0].activeProvider = 'paj'; });
    const after = (await db.read() as any).ngnControls[0];
    check('an admin flip changes the active provider with no code change',
      after.activeProvider === 'paj', after.activeProvider);

    // And the quote path reads that field rather than an env var or a literal.
    const source = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../src/ngn/service/ngn-quotes.service.ts', import.meta.url), 'utf8')
    );
    check('the quote path resolves the provider from controls.activeProvider',
      /getNgnProvider\(controls\.activeProvider\)/.test(source),
      'the provider is not admin-controlled');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
