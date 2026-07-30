/**
 * Minimum and maximum virtual account fees.
 *
 * At 1.25% a $50 deposit earns $0.62 while Bridge charges $0.25 and the
 * customer cost $2 to onboard. Small deposits never pay their way, so a floor
 * is needed. A cap is needed too, because Nigerian competitors cap theirs
 * ($10 Grey, $15 Raenest) and an uncapped percentage looks expensive.
 *
 * Both live inside Bridge's `fee_config`, which is beta and gated per
 * developer account. Probing sandbox on 2026-07-29 returned:
 *
 *   400 invalid_parameters  {"fee_config": "is not yet available"}
 *
 * So the feature is built, disabled, and must degrade safely: an operator who
 * sets a floor before Bridge enables it should still get working virtual
 * accounts on a plain percentage, not a hard failure at provisioning time.
 *
 * Run: npm run test:va-fee-limits
 */

import { getVirtualAccountFeeSelection } from '../src/offramp/service/fees.service.js';
import { updateAdminFeeSettings, getAdminFeeSettings } from '../src/admin/admin-fees.service.js';

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass += 1; console.log(`  \u2713 ${name}`); }
  else { fail += 1; console.error(`  \u2717 ${name}${detail ? ` \u2014 ${detail}` : ''}`); }
}

async function setFees(patch: Record<string, unknown>) {
  const current = await getAdminFeeSettings();
  await updateAdminFeeSettings(
    {
      ...current,
      ...patch,
      updatedBy: 'test.harness@sivantech.online',
      reason: 'fee limit test',
    } as any,
    {}
  );
}

async function main() {
  console.log('\nVirtual account fee floor and cap\n');
  const original = await getAdminFeeSettings();

  try {
    console.log('1. No limits set -> plain percentage');
    await setFees({
      virtualAccountFeePercent: 1.25,
      virtualAccountMinimumFeeUsd: 0,
      virtualAccountMaximumFeeUsd: 0,
      virtualAccountFeeConfigEnabled: false,
    });
    let sel = await getVirtualAccountFeeSelection();
    check('sends developer_fee_percent', sel.developerFeePercent === '1.25', sel.developerFeePercent);
    check('does NOT send fee_config', sel.feeConfig === undefined);

    console.log('\n2. Floor set but Bridge has not enabled fee_config');
    await setFees({ virtualAccountMinimumFeeUsd: 1, virtualAccountFeeConfigEnabled: false });
    sel = await getVirtualAccountFeeSelection();
    check('degrades to a flat percentage rather than failing',
      sel.developerFeePercent === '1.25' && sel.feeConfig === undefined,
      'sending fee_config before enablement breaks provisioning entirely');
    check('says plainly why the floor was ignored',
      /has not enabled fee_config/i.test(sel.reason), sel.reason);

    console.log('\n3. Floor set and fee_config enabled');
    await setFees({ virtualAccountMinimumFeeUsd: 1, virtualAccountFeeConfigEnabled: true });
    sel = await getVirtualAccountFeeSelection();
    check('sends fee_config', Boolean(sel.feeConfig));
    check('does NOT also send developer_fee_percent',
      sel.developerFeePercent === undefined,
      'Bridge rejects a request carrying both');
    check('ACH carries the $1.00 floor',
      sel.feeConfig?.source.ach_push.minimum_fee === '1.00',
      JSON.stringify(sel.feeConfig?.source.ach_push));
    check('GBP Faster Payments carries it too',
      sel.feeConfig?.source.faster_payments?.minimum_fee === '1.00');
    check('EUR SEPA carries it too',
      sel.feeConfig?.source.sepa?.minimum_fee === '1.00');
    check('the percentage is still 1.25',
      sel.feeConfig?.source.ach_push.fee_percent === '1.25');

    console.log('\n4. Cap applies per rail, wire stays uncapped');
    await setFees({ virtualAccountMaximumFeeUsd: 25 });
    sel = await getVirtualAccountFeeSelection();
    check('ACH is capped at $25', sel.feeConfig?.source.ach_push.maximum_fee === '25.00');
    check('Faster Payments is capped', sel.feeConfig?.source.faster_payments?.maximum_fee === '25.00');
    check('SEPA is capped', sel.feeConfig?.source.sepa?.maximum_fee === '25.00');
    check('WIRE is deliberately NOT capped',
      sel.feeConfig?.source.wire?.maximum_fee === undefined,
      "Bridge's own 0.50% is uncapped, so a capped wire loses money on large deposits");
    check('the reason states where a cap starts losing money',
      /loss above a \$5,000 deposit/.test(sel.reason), sel.reason);

    console.log('\n5. A zero fee sends nothing at all');
    await setFees({ virtualAccountFeePercent: 0 });
    sel = await getVirtualAccountFeeSelection();
    check('no fee field is sent', !sel.developerFeePercent && !sel.feeConfig);
    check('and it explains Bridge treats absence as 0%', /0%/.test(sel.reason));

    console.log('\n6. Is fee_config live on this Bridge account yet?');
    const base = process.env.BRIDGE_BASE_URL || '';
    if (!base.includes('sandbox')) {
      console.log('  skipped: not pointed at sandbox');
    } else {
      const { BridgeClient } = await import('../src/providers/bridge/bridge.client.js');
      const client = new BridgeClient();
      const C = process.env.SANDBOX_TEST_CUSTOMER_ID || '49a3dfe9-9a5b-42ce-aa7c-bb0d68ac4580';
      const vas = await client.request<any>(`/customers/${C}/virtual_accounts`);
      const va = (vas.data || [])[0];
      if (!va) {
        console.log('  skipped: no sandbox virtual account to probe');
      } else {
        let enabled = false;
        let message = '';
        try {
          await client.request(`/customers/${C}/virtual_accounts/${va.id}`, {
            method: 'PUT',
            body: {
              destination: va.destination?.bridge_wallet_id
                ? { currency: 'usdc', payment_rail: 'solana', bridge_wallet_id: va.destination.bridge_wallet_id }
                : { currency: 'usdc', payment_rail: 'solana', address: va.destination?.address },
              fee_config: { source: { ach_push: { fee_percent: '1.25', minimum_fee: '1.00' } } },
            },
          });
          enabled = true;
        } catch (error: any) {
          message = JSON.stringify(error?.details ?? error?.message ?? '');
        }

        if (enabled) {
          console.log('  fee_config IS now enabled on this account.');
          console.log('  Set virtualAccountFeeConfigEnabled=true in fee settings to use it.');
        } else {
          check('Bridge still reports fee_config unavailable, as expected',
            /not yet available/i.test(message),
            message.slice(0, 200));
          console.log('  Still gated. The code is ready; Bridge must enable it.');
        }
      }
    }
  } finally {
    // Leave settings exactly as found.
    await updateAdminFeeSettings(
      { ...original, updatedBy: 'test.harness@sivantech.online', reason: 'restore after fee limit test' } as any,
      {}
    );
  }

  console.log(`\n=====  PASS: ${pass}   FAIL: ${fail}  =====\n`);
  if (fail > 0) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
