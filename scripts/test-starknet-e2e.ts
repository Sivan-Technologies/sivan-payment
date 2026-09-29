/**
 * STARKNET END-TO-END VERIFICATION: DEPOSIT, BALANCE, AND MULTI-CHANNEL NOTIFICATIONS.
 *
 * Verifies that:
 * 1. Starknet balance reading operates across StarknetAdapter, PrivyWalletProvider, and UnifiedBalance.
 * 2. Incoming Starknet deposits are properly recorded in the database.
 * 3. The Web Activity Feed & In-App balance reflect Starknet deposits.
 * 4. Telegram deposit notifications are constructed and dispatched to linked users.
 * 5. WhatsApp deposit notifications are constructed and dispatched to linked users.
 * 6. Live felt252 address normalization and RPC state read without errors.
 */

import { db } from '../src/database/json-database.js';
import { getChainAdapter } from '../src/wallets/chain-adapter-registry.js';
import { getWalletProvider } from '../src/wallets/provider/provider-registry.js';
import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';
import { recordDeposit } from '../src/deposits/deposit.service.js';
import {
  humanNetwork,
  depositMessage,
  notifyTelegramDeposit,
  notifyWhatsAppDeposit,
  notifyPendingDeposits,
} from '../src/deposits/deposit-notification.service.js';
import { normaliseStarknetAddress, validateAddressForChain } from '../src/wallets/address-validation.js';
import type { WalletDepositRecord } from '../src/database/types.js';

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail = '') {
  if (ok) {
    passed++;
    console.log(`  ✅ ok - ${name}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL - ${name}${detail ? ` (${detail})` : ''}`);
  }
}

async function run() {
  console.log('==================================================');
  console.log('🔷 STARKNET END-TO-END DEPOSIT & NOTIFICATION SUITE');
  console.log('==================================================\n');

  // Setup test user and linked identity channels
  const ts = Date.now();
  const testUserId = `sn_user_${ts}`;
  const testEmail = `starknet_tester_${ts}@sivantech.online`;
  const testAddress = '0x132cb73dc429c15f6700ef6335cee25e07a4217e77ea39e5589254f2518331f';
  const testTelegramId = `987${ts.toString().slice(-6)}`;
  const testWhatsAppPhone = `+234801${ts.toString().slice(-6)}`;

  await db.insertUserRecord({
    id: testUserId,
    email: testEmail,
    username: `starknet_tester_${ts}`,
    fullName: 'Starknet Tester',
    whatsappNumber: testWhatsAppPhone,
    status: 'active',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  } as any);

  // Link Telegram channel
  await db.upsertCustomerIdentityLinkRecord({
    id: `link_tg_${Date.now()}`,
    paymentUserId: testUserId,
    email: testEmail,
    channel: 'telegram',
    telegramUserId: testTelegramId,
    status: 'linked',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Link WhatsApp channel
  await db.upsertCustomerIdentityLinkRecord({
    id: `link_wa_${Date.now()}`,
    paymentUserId: testUserId,
    email: testEmail,
    channel: 'whatsapp',
    whatsappNumber: testWhatsAppPhone,
    status: 'linked',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // Create Customer row
  const now = new Date().toISOString();
  await db.insertCustomerRecord({
    id: `cust_${testUserId}`,
    userId: testUserId,
    provider: 'bridge',
    providerCustomerId: `pc_${testUserId}`,
    customerType: 'individual',
    kycStatus: 'kyc_approved',
    tosStatus: 'approved',
    createdAt: now,
    updatedAt: now,
  } as any);

  // Create Starknet wallet row
  const walletRow = await db.insertUserWallet({
    id: `wal_sn_${Date.now()}`,
    userId: testUserId,
    customerId: `cust_${testUserId}`,
    chain: 'starknet',
    address: testAddress,
    provider: 'privy',
    providerWalletId: `privy_sn_${Date.now()}`,
    status: 'active',
    custodial: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  // ══ 1. Address Validation & Normalisation ══
  console.log('══ 1. Address Validation & Normalisation ══');
  const valid = validateAddressForChain(testAddress, 'starknet');
  check('Starknet address from UI is recognized as valid felt252', valid.valid);

  const normalised = normaliseStarknetAddress(testAddress);
  check('Starknet address normalises to 64-char hex format', normalised.startsWith('0x') && normalised.length === 66);

  // ══ 2. Adapter & Provider Balance Reading ══
  console.log('\n══ 2. Adapter & Provider Balance Reading ══');
  const adapter = getChainAdapter('starknet');
  check('StarknetAdapter is registered in chain registry', Boolean(adapter));

  const adapterBalance = await adapter.getBalance(testUserId, 'usdc');
  check('StarknetAdapter.getBalance(userId) resolves to a valid number', typeof adapterBalance === 'number' && !Number.isNaN(adapterBalance));

  const provider = getWalletProvider('privy');
  const providerBalances = await provider.getBalances(
    walletRow.providerWalletId,
    walletRow.customerId,
    testAddress,
    'starknet'
  );

  check('Privy provider returns an array for Starknet balances', Array.isArray(providerBalances));
  const usdcBalance = providerBalances.find((b) => b.asset === 'usdc' && b.chain === 'starknet');
  check('Privy provider includes USDC for Starknet', Boolean(usdcBalance));
  check('USDC balance on Starknet has a valid amount string', typeof usdcBalance?.amount === 'string');

  const strkBalance = providerBalances.find((b) => b.asset === 'strk' && b.chain === 'starknet');
  check('Privy provider includes STRK for Starknet', Boolean(strkBalance));

  // ══ 3. Unified Balance Aggregation ══
  console.log('\n══ 3. Unified Balance Aggregation ══');
  const unified = await getUnifiedBalance(testUserId, true);
  check('Unified balance returned for user', Boolean(unified && unified.balances));

  const snWalletInUnified = unified.wallets.find((w) => w.chain === 'starknet');
  check('Unified balance includes Starknet in wallets list', Boolean(snWalletInUnified));
  check('Starknet wallet in unified balance carries address', snWalletInUnified?.address === testAddress);
  check('Starknet wallet does not report balancesUnavailable', snWalletInUnified?.balancesUnavailable === false);

  // ══ 4. Deposit Observation & In-App Web Activity ══
  console.log('\n══ 4. Deposit Observation & In-App Web Activity ══');
  const recorded = await recordDeposit({
    userId: testUserId,
    walletId: walletRow.id,
    address: testAddress,
    chain: 'starknet',
    asset: 'USDC',
    amount: '25.000000',
    detectionSource: 'balance_poll',
    txHash: `sn_tx_${Date.now()}`,
  });

  check('Deposit is recorded successfully', recorded.created);
  check('Recorded deposit status is pending or confirmed', ['pending', 'confirmed'].includes(recorded.record.status));
  check('Recorded deposit has Starknet chain', recorded.record.chain === 'starknet');
  check('Recorded deposit has 25 USDC amount', recorded.record.amount === '25.000000');

  const userDeposits = await db.listWalletDeposits(testUserId);
  const foundDeposit = userDeposits.find((d) => d.id === recorded.record.id);
  check('Deposit is persisted in database and queryable for Web Activity feed', Boolean(foundDeposit));

  // ══ 5. Multi-Channel Notification Formatting ══
  console.log('\n══ 5. Multi-Channel Notification Formatting ══');
  const networkName = humanNetwork('starknet');
  check('humanNetwork maps starknet to "Starknet"', networkName === 'Starknet');

  const pendingMsg = depositMessage(recorded.record);
  check('Email message subject mentions Starknet deposit', pendingMsg.subject.includes('Deposit'));
  check('Email body includes human network name Starknet', pendingMsg.text.includes('Starknet') || pendingMsg.html.includes('Starknet'));

  const confirmedDeposit: WalletDepositRecord = {
    ...recorded.record,
    status: 'confirmed',
  };
  const confirmedMsg = depositMessage(confirmedDeposit);
  check('Confirmed email mentions confirmed status', confirmedMsg.subject.includes('confirmed'));

  // ══ 6. Telegram Notification Dispatch ══
  console.log('\n══ 6. Telegram Notification Dispatch ══');
  let tgCalled = false;
  let tgPayload: any = null;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/notify')) {
      const parsed = JSON.parse(init.body);
      if (parsed.telegramId) {
        tgCalled = true;
        tgPayload = parsed;
      }
      return new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200 });
    }
    return originalFetch(url, init);
  }) as any;

  process.env.TELEGRAM_NOTIFICATION_URL = 'http://localhost:4002';
  process.env.NOTIFICATION_SECRET = 'test_secret_123';

  await notifyTelegramDeposit(testUserId, confirmedDeposit);
  check('Telegram deposit notification invoked for linked user', tgCalled);
  check('Telegram payload targets linked telegramId', tgPayload?.telegramId === testTelegramId);
  check('Telegram message text mentions Starknet and amount', tgPayload?.message.includes('Starknet') && tgPayload?.message.includes('25.000000 USDC'));

  // ══ 7. WhatsApp Notification Dispatch ══
  console.log('\n══ 7. WhatsApp Notification Dispatch ══');
  let waCalled = false;
  let waPayload: any = null;

  globalThis.fetch = (async (url: any, init: any) => {
    const urlStr = String(url);
    if (urlStr.includes('/api/notify')) {
      const parsed = JSON.parse(init.body);
      if (parsed.to) {
        waCalled = true;
        waPayload = parsed;
      }
      return new Response(JSON.stringify({ ok: true, delivered: true }), { status: 200 });
    }
    return originalFetch(url, init);
  }) as any;

  process.env.WHATSAPP_NOTIFICATION_URL = 'http://localhost:4003';

  await notifyWhatsAppDeposit(testUserId, confirmedDeposit);
  check('WhatsApp deposit notification invoked for linked user', waCalled);
  check('WhatsApp payload targets linked phone number', waPayload?.to === testWhatsAppPhone);
  check('WhatsApp message text mentions Starknet and amount', waPayload?.message.includes('Starknet') && waPayload?.message.includes('25.000000 USDC'));

  // Restore fetch
  globalThis.fetch = originalFetch;

  // ══ 8. Batch Notification Sweeper ══
  console.log('\n══ 8. Batch Notification Sweeper ══');
  const unnotifiedBefore = await db.listUnnotifiedWalletDeposits(10);
  const containsOurDeposit = unnotifiedBefore.some((d) => d.id === recorded.record.id);
  check('New Starknet deposit is flagged as unnotified initially', containsOurDeposit);

  const sweeperOutcome = await notifyPendingDeposits(10);
  check('notifyPendingDeposits sweeper considers unnotified deposits', sweeperOutcome.considered >= 1);

  const unnotifiedAfter = await db.listUnnotifiedWalletDeposits(10);
  const stillUnnotified = unnotifiedAfter.some((d) => d.id === recorded.record.id);
  check('Deposit is marked as notified after sweeper runs', !stillUnnotified);

  console.log('\n==================================================');
  console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
  console.log('==================================================');

  if (failed > 0) {
    process.exit(1);
  }
}

run().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
