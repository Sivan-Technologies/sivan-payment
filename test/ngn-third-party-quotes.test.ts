import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNgnQuote } from '../src/ngn/service/ngn-quotes.service.js';
import { updateNgnControls } from '../src/ngn/service/ngn-controls.service.js';
import { db } from '../src/database/json-database.js';

test('NGN Third-Party Off-Ramp Quote Gating', async (t) => {
  const testUserId = `user_tp_test_${Date.now()}`;
  await db.insertUserRecord({
    id: testUserId,
    email: `${testUserId}@example.com`,
    fullName: 'Test Third Party Sender',
    status: 'active',
    country: 'NG',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Provision test wallet so balance/wallet check passes
  await db.insertUserWallet({
    id: `wal_${testUserId}`,
    userId: testUserId,
    chain: 'solana',
    network: 'solana',
    address: 'So11111111111111111111111111111111111111112',
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await t.test('When thirdPartyPayoutsEnabled is false, third-party destination throws forbidden', async () => {
    await updateNgnControls({
      activeProvider: 'mock',
      mockProviderEnabled: true,
      thirdPartyPayoutsEnabled: false,
      limitEnforcementOfframp: false,
    });

    await assert.rejects(
      async () => {
        await createNgnQuote({
          userId: testUserId,
          direction: 'offramp',
          sourceCurrency: 'usdc',
          destinationCurrency: 'ngn',
          sourceAmount: '10',
          network: 'solana',
          accountNumber: '8079604214',
          bankCode: '999992', // OPay
          bankName: 'OPay',
          accountName: 'Third Party Beneficiary',
        });
      },
      (err: any) => {
        assert.ok(err.message.includes('own name') || err.message.includes('third party'));
        return true;
      }
    );
  });

  await t.test('When thirdPartyPayoutsEnabled is true, quote accepts third-party destination and attaches to metadata', async () => {
    await updateNgnControls({
      activeProvider: 'mock',
      mockProviderEnabled: true,
      thirdPartyPayoutsEnabled: true,
      limitEnforcementOfframp: false,
    });

    const quote = await createNgnQuote({
      userId: testUserId,
      direction: 'offramp',
      sourceCurrency: 'usdc',
      destinationCurrency: 'ngn',
      sourceAmount: '10',
      network: 'solana',
      accountNumber: '8079604214',
      bankCode: '999992',
      bankName: 'OPay',
      accountName: 'Third Party Beneficiary',
    });

    assert.ok(quote.id.startsWith('ngnq'));
    assert.equal(quote.direction, 'offramp');
    assert.equal((quote.metadata as any)?.accountNumber, '8079604214');
    assert.equal((quote.metadata as any)?.bankId, '999992');
    assert.equal((quote.metadata as any)?.bankName, 'OPay');
    assert.equal((quote.metadata as any)?.accountName, 'Third Party Beneficiary');
    console.log('✓ Third-party quote verified with metadata and admin toggle gating');
  });
});
