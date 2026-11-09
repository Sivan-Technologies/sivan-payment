import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

const tempDbFile = path.join(os.tmpdir(), `sivan-admin-ngn-ledger-${Date.now()}.json`);
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.USER_JWT_SECRET = 'test_jwt_secret_at_least_32_characters_long_12345';
process.env.DATABASE_PROVIDER = 'json';
process.env.DATABASE_FILE = tempDbFile;

const { db } = await import('../src/database/json-database.js');
const { createBalanceLedgerEntry } = await import('../src/balances/balance.service.js');
const {
  getAdminNgnLedgerDashboard,
  getAdminUserNgnStatement,
  syncAdminUserNgnVirtualAccount,
} = await import('../src/admin/admin-ngn-ledger.service.js');

async function runTests() {
  console.log('Running Admin NGN Ledger & Provider-Agnostic Virtual Accounts Tests...');

  const now = new Date().toISOString();

  // 1. Seed isolated JSON test records (two Naira users across two different providers)
  await db.insertUserRecord({
    id: 'usr_ngn_001',
    email: 'adebayo@example.com',
    fullName: 'Adebayo Ogunlesi',
    username: 'adebayo',
    whatsappNumber: '+2348031112222',
    country: 'NG',
    createdAt: now,
    updatedAt: now,
  });

  await db.insertUserRecord({
    id: 'usr_ngn_002',
    email: 'chioma@example.com',
    fullName: 'Chioma Nwosu',
    username: 'chioma',
    whatsappNumber: '+2348093334444',
    country: 'NG',
    createdAt: now,
    updatedAt: now,
  });

  // User 1 has a Paystack DVA
  await db.upsertVirtualAccountRecord({
    id: 'va_paystack_001',
    userId: 'usr_ngn_001',
    customerId: 'CUS_paystack_001',
    provider: 'paystack' as any,
    providerAccountId: 'dva_001',
    currency: 'ngn' as any,
    bankName: 'Wema Bank',
    accountName: 'SIVAN / ADEBAYO OGUNLESI',
    accountNumberMasked: '7820112233',
    status: 'active',
    rawProviderPayload: {
      account_number: '7820112233',
      account_name: 'SIVAN / ADEBAYO OGUNLESI',
      bank: { name: 'Wema Bank' },
    },
    createdAt: now,
    updatedAt: now,
  });

  // User 2 has a Mono / future provider Virtual Account
  await db.upsertVirtualAccountRecord({
    id: 'va_mono_002',
    userId: 'usr_ngn_002',
    customerId: 'CUS_mono_002',
    provider: 'mono' as any,
    providerAccountId: 'mono_va_002',
    currency: 'ngn' as any,
    bankName: 'Titan Trust Bank',
    accountName: 'SIVAN / CHIOMA NWOSU',
    accountNumberMasked: '8910445566',
    status: 'active',
    rawProviderPayload: {
      account_number: '8910445566',
      account_name: 'SIVAN / CHIOMA NWOSU',
      bank: { name: 'Titan Trust Bank' },
    },
    createdAt: now,
    updatedAt: now,
  });

  // Record a virtual account transaction for User 1 (Gross 20,000 NGN, Net 19,800 NGN, Fee 200 NGN)
  await db.upsertVirtualAccountTransactionRecord({
    id: 'vatx_001',
    provider: 'paystack' as any,
    virtualAccountId: 'va_paystack_001',
    providerAccountId: 'dva_001',
    depositId: 'PSK_DEP_001',
    depositReference: 'PSK_DEP_001',
    userId: 'usr_ngn_001',
    customerId: 'CUS_paystack_001',
    sourceCurrency: 'ngn',
    destinationCurrency: 'ngn',
    sourceAmount: '20000.00',
    destinationAmount: '19800.00',
    paymentRail: 'nibss_paystack_dva',
    status: 'completed',
    rawPayload: {
      authorization: {
        sender_name: 'ADEBAYO OGUNLESI',
        sender_bank: 'GTBank',
      },
    },
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  });

  // Credit User 1 via WhatsApp alias to verify alias unification
  await createBalanceLedgerEntry(
    {
      userId: 'whatsapp:+2348031112222',
      asset: 'ngn',
      amount: '19800.00',
      kind: 'credit_available',
      status: 'available',
      sourceType: 'virtual_account_transaction',
      sourceId: 'vatx_001',
      description: 'Paystack DVA deposit settled (PSK_DEP_001): gross 20000.00 NGN, fee 200.00 NGN',
      transferId: 'vatx_001',
    },
    { actorType: 'provider', actorId: 'paystack' }
  );

  // User 1 buys 2,000 NGN Airtime (Outflow)
  await createBalanceLedgerEntry(
    {
      userId: 'usr_ngn_001',
      asset: 'ngn',
      amount: '2000.00',
      kind: 'debit_transfer',
      status: 'completed',
      sourceType: 'utility_airtime',
      sourceId: 'util_air_001',
      description: 'MTN Airtime purchase for 08031112222',
      destinationAddress: 'MTN • 08031112222',
      transferId: 'util_air_001',
    },
    { actorType: 'user', actorId: 'usr_ngn_001' }
  );

  // User 1 locks 5,000 NGN in a Service Agreement (Hold)
  await createBalanceLedgerEntry(
    {
      userId: 'usr_ngn_001',
      asset: 'ngn',
      amount: '5000.00',
      kind: 'hold',
      status: 'held',
      sourceType: 'service_agreement',
      sourceId: 'SIV-AG-101',
      description: 'Hold NGN for Service Agreement SIV-AG-101',
      transferId: 'SIV-AG-101',
    },
    { actorType: 'user', actorId: 'usr_ngn_001' }
  );

  // User 2 receives 15,000 NGN deposit via Mono rail
  await createBalanceLedgerEntry(
    {
      userId: 'usr_ngn_002',
      asset: 'ngn',
      amount: '15000.00',
      kind: 'credit_available',
      status: 'available',
      sourceType: 'virtual_account_transaction',
      sourceId: 'mono_dep_002',
      description: 'Mono virtual account deposit settled (MONO_REF_002): gross 15100.00 NGN, fee 100.00 NGN',
      transferId: 'mono_dep_002',
    },
    { actorType: 'provider', actorId: 'mono' }
  );

  // User 2 withdraws 4,000 NGN + 50 NGN fee to bank
  await createBalanceLedgerEntry(
    {
      userId: 'usr_ngn_002',
      asset: 'ngn',
      amount: '4050.00',
      kind: 'hold',
      status: 'held',
      sourceType: 'ngn_cashout',
      sourceId: 'ngntx_002',
      description: 'Hold 4050.00 NGN for bank withdrawal',
      transferId: 'ngntx_002',
    },
    { actorType: 'user', actorId: 'usr_ngn_002' }
  );

  await createBalanceLedgerEntry(
    {
      userId: 'usr_ngn_002',
      asset: 'ngn',
      amount: '4000.00',
      kind: 'debit_transfer',
      status: 'completed',
      sourceType: 'ngn_cashout',
      sourceId: 'ngntx_002',
      description: 'Bank withdrawal completed to Access Bank',
      destinationAddress: 'Access Bank • 0123456789',
      transferId: 'ngntx_002_principal',
    },
    { actorType: 'provider', actorId: 'mono' }
  );

  await createBalanceLedgerEntry(
    {
      userId: 'usr_ngn_002',
      asset: 'ngn',
      amount: '50.00',
      kind: 'fee',
      status: 'completed',
      sourceType: 'ngn_cashout',
      sourceId: 'ngntx_002',
      description: 'Outbound NGN transfer fee',
      transferId: 'ngntx_002_fee',
    },
    { actorType: 'system', actorId: 'mono' }
  );

  // Seed a direct crypto-to-NGN off-ramp transfer for User 1 (15,000 NGN via USDC -> NGN)
  await db.upsertNgnTransferRecord({
    id: 'ngntx_direct_001',
    userId: 'usr_ngn_001',
    provider: 'paystack',
    sourceCurrency: 'usdc',
    sourceAsset: 'usdc',
    sourceNetwork: 'celo',
    sourceAmount: '10.00',
    destinationCurrency: 'ngn',
    destinationAmount: '15000.00',
    exchangeRate: '1500.00',
    feeAmount: '150.00',
    status: 'completed',
    bankCode: '058',
    accountNumberMasked: '0123456789',
    recipientName: 'ADEBAYO OGUNLESI',
    createdAt: now,
    updatedAt: now,
    completedAt: now,
  } as any);

  // 2. Test Dashboard Aggregation (Default provider = paystack)
  process.env.BANKING_RAIL_PROVIDER = 'paystack';
  const dashboard = await getAdminNgnLedgerDashboard();

  assert.equal(dashboard.activeRail, 'paystack');
  assert.equal(dashboard.summary.totalNgnUsers, 2);
  // User 1: 19,800 - 2,000 (airtime) - 5,000 (held) = 12,800 available, 5,000 held
  // User 2: 15,000 - 4,050 (withdrawn + fee) = 10,950 available, 0 held
  assert.equal(dashboard.summary.totalAvailableNgn, 23750);
  assert.equal(dashboard.summary.totalHeldNgn, 5000);
  assert.equal(dashboard.summary.totalLiabilityNgn, 28750);
  assert.equal(dashboard.summary.totalLifetimeInflowNgn, 34800);
  assert.equal(dashboard.summary.totalLifetimeOutflowNgn, 6050);
  assert.equal(dashboard.summary.totalDirectOfframpVolumeNgn, 15000);
  assert.equal(dashboard.summary.totalDirectOfframpCount, 1);
  assert.equal(dashboard.summary.unbalancedUsersCount, 0);
  assert.equal(dashboard.summary.inflowBreakdown.bankDepositsNgn, 34800);
  assert.equal(dashboard.summary.outflowBreakdown.bankWithdrawalsNgn, 4000);
  assert.equal(dashboard.summary.outflowBreakdown.utilityBillsNgn, 2000);
  assert.equal(dashboard.summary.outflowBreakdown.platformFeesNgn, 50);

  // 3. Test Individual User Statement, Lifetime Breakdown & Mathematical Ledger Proof
  const user1Statement = await getAdminUserNgnStatement('usr_ngn_001');
  assert.equal(user1Statement.summary.availableNgn, 12800);
  assert.equal(user1Statement.summary.heldNgn, 5000);
  assert.equal(user1Statement.summary.totalEquityNgn, 17800);
  assert.equal(user1Statement.summary.totalInflowNgn, 19800);
  assert.equal(user1Statement.summary.totalOutflowNgn, 2000);
  assert.equal(user1Statement.summary.inflowBreakdown.bankDepositsNgn, 19800);
  assert.equal(user1Statement.summary.outflowBreakdown.utilityBillsNgn, 2000);
  assert.equal(user1Statement.summary.ledgerProof.balanced, true);
  assert.equal(user1Statement.summary.ledgerProof.expectedEquityNgn, 17800);
  assert.equal(user1Statement.summary.ledgerProof.actualEquityNgn, 17800);
  assert.equal(user1Statement.summary.ledgerProof.discrepancyNgn, 0);
  assert.equal(user1Statement.summary.directOfframpVolumeNgn, 15000);
  assert.equal(user1Statement.summary.directOfframpCount, 1);
  assert.equal(user1Statement.summary.totalNgnFootprintNgn, 34800);
  assert.equal(user1Statement.entries.length, 3);

  // Chronological oldest entry (last in reversed array) is the 19,800 deposit
  const depositEntry = user1Statement.entries[2];
  assert.equal(depositEntry.direction, 'INFLOW');
  assert.equal(depositEntry.flowCategory, 'bank_deposit');
  assert.equal(depositEntry.grossAmountNgn, 20000);
  assert.equal(depositEntry.feeNgn, 200);
  assert.equal(depositEntry.availableBeforeNgn, 0);
  assert.equal(depositEntry.availableAfterNgn, 19800);
  assert.equal(depositEntry.provider, 'paystack');

  // Second entry is 2,000 NGN airtime outflow
  const airtimeEntry = user1Statement.entries[1];
  assert.equal(airtimeEntry.direction, 'OUTFLOW');
  assert.equal(airtimeEntry.flowCategory, 'utility_purchase');
  assert.equal(airtimeEntry.availableBeforeNgn, 19800);
  assert.equal(airtimeEntry.availableAfterNgn, 17800);

  // Newest entry is 5,000 NGN Service Agreement Hold
  const holdEntry = user1Statement.entries[0];
  assert.equal(holdEntry.direction, 'HOLD');
  assert.equal(holdEntry.flowCategory, 'service_agreement_lock');
  assert.equal(holdEntry.availableBeforeNgn, 17800);
  assert.equal(holdEntry.availableAfterNgn, 12800);
  assert.equal(holdEntry.heldBeforeNgn, 0);
  assert.equal(holdEntry.heldAfterNgn, 5000);

  // 4. Test Provider Switch: Change BANKING_RAIL_PROVIDER from 'paystack' to 'mono'
  process.env.BANKING_RAIL_PROVIDER = 'mono';
  const monoDashboard = await getAdminNgnLedgerDashboard({ search: 'Chioma' });
  assert.equal(monoDashboard.activeRail, 'mono');
  assert.equal(monoDashboard.users.length, 1);
  assert.equal(monoDashboard.users[0].userId, 'usr_ngn_002');
  assert.equal(monoDashboard.users[0].virtualAccount?.provider, 'mono');
  assert.equal(monoDashboard.users[0].virtualAccount?.accountNumber, '8910445566');
  assert.equal(monoDashboard.users[0].availableNgn, 10950);

  const syncRes = await syncAdminUserNgnVirtualAccount('usr_ngn_002');
  assert.equal(syncRes.statement.activeRail, 'mono');
  assert.equal(syncRes.statement.summary.availableNgn, 10950);

  await fs.unlink(tempDbFile).catch(() => {});
  console.log('All Admin NGN Ledger & Provider-Agnostic Virtual Accounts tests passed!');
}

runTests().catch((err) => {
  console.error('Test failed:', err);
  process.exit(1);
});

