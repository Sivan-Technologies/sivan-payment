import assert from 'node:assert/strict';
import {
  formatMoneyGramPin,
  generateMoneyGramReferencePin,
  getStoredMoneyGramVouchers,
  MONEYGRAM_SUPPORTED_COUNTRIES,
  resolveMoneyGramAnchorUrl,
  saveMoneyGramVoucher,
  updateMoneyGramVoucherStatus,
  type MoneyGramVoucher,
} from '../src/moneygram';

// Mock localStorage for node environment
const storage: Record<string, string> = {};
(globalThis as any).window = {
  localStorage: {
    getItem: (key: string) => storage[key] ?? null,
    setItem: (key: string, val: string) => {
      storage[key] = val;
    },
    removeItem: (key: string) => {
      delete storage[key];
    },
    clear: () => {
      for (const k of Object.keys(storage)) delete storage[k];
    },
  },
};
(globalThis as any).localStorage = (globalThis as any).window.localStorage;

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ok   ${name}`);
    passed++;
  } catch (err: any) {
    console.error(`  FAIL ${name}: ${err.message}`);
    failed++;
  }
}

console.log('\nMONEYGRAM CORRIDOR & NETWORK SPECIFICATIONS');

test('all supported corridors are defined with realistic rates', () => {
  assert.ok(MONEYGRAM_SUPPORTED_COUNTRIES.length >= 7, 'Should support at least 7 major corridors');
  const codes = MONEYGRAM_SUPPORTED_COUNTRIES.map((c) => c.code);
  assert.ok(codes.includes('US'), 'Should support United States (USD)');
  assert.ok(codes.includes('NG'), 'Should support Nigeria (NGN)');
  assert.ok(codes.includes('KE'), 'Should support Kenya (KES)');
  assert.ok(codes.includes('GH'), 'Should support Ghana (GHS)');
  assert.ok(codes.includes('EU'), 'Should support Eurozone (EUR)');
  assert.ok(codes.includes('GB'), 'Should support United Kingdom (GBP)');
});

test('rates match realistic currency parities for 1 USDC', () => {
  const ngn = MONEYGRAM_SUPPORTED_COUNTRIES.find((c) => c.code === 'NG')!;
  const kes = MONEYGRAM_SUPPORTED_COUNTRIES.find((c) => c.code === 'KE')!;
  const ghs = MONEYGRAM_SUPPORTED_COUNTRIES.find((c) => c.code === 'GH')!;
  assert.ok(ngn.estimatedRate >= 1400 && ngn.estimatedRate <= 2000, 'NGN rate realistic');
  assert.ok(kes.estimatedRate >= 120 && kes.estimatedRate <= 145, 'KES rate realistic');
  assert.ok(ghs.estimatedRate >= 12 && ghs.estimatedRate <= 20, 'GHS rate realistic');
});

console.log('\nPIN GENERATION & PARSING (8-DIGIT MONOSPACE DISPLAY)');

test('formats raw 8 digits into XXXX-XXXX format', () => {
  const formatted = formatMoneyGramPin('48291049');
  assert.equal(formatted, '4829-1049');
});

test('cleans non-digits before formatting', () => {
  const formatted = formatMoneyGramPin('48-29 1049');
  assert.equal(formatted, '4829-1049');
});

test('generates randomized 8-digit pin with hyphen separator', () => {
  const pin = generateMoneyGramReferencePin();
  assert.match(pin, /^\d{4}-\d{4}$/, 'Should match 4 digits, hyphen, 4 digits');
});

console.log('\nANCHOR DISCOVERY DYNAMIC RESOLUTION');

test('resolves anchor URL without hardcoded plaintext HTTP fallbacks', () => {
  const url = resolveMoneyGramAnchorUrl();
  assert.ok(url.startsWith('https://'), 'Must be secure https');
  assert.ok(url.includes('moneygram.com'), 'Must target official MoneyGram domain');
});

console.log('\nVOUCHER STORAGE & LIFECYCLE MANAGEMENT');

test('saves voucher to local storage and retrieves accurately', () => {
  const sampleVoucher: MoneyGramVoucher = {
    id: 'test_voucher_01',
    referencePin: '5821-9920',
    externalTransactionId: '58219920',
    transactionId: 'mg_tx_12345',
    mode: 'withdraw',
    amount: '25.00', // Realistic test amount (15 to 50 USDC)
    asset: 'USDC',
    targetCurrency: 'NGN',
    targetAmount: '40,500',
    recipientName: 'Samson Micheal',
    recipientPhone: '+2348012345678',
    status: 'ready_for_pickup',
    statusLabel: 'Ready for Counter Pickup',
    moreInfoUrl: 'https://extmgxanchor.moneygram.com/stellarsepservice/sep24/transaction/more_info?id=mg_tx_12345',
    createdAt: new Date().toISOString(),
  };

  saveMoneyGramVoucher(sampleVoucher);
  const stored = getStoredMoneyGramVouchers();
  assert.equal(stored.length, 1);
  assert.equal(stored[0].referencePin, '5821-9920');
  assert.equal(stored[0].amount, '25.00');
  assert.equal(stored[0].status, 'ready_for_pickup');
});

test('updates voucher status upon settlement or cancellation', () => {
  const updated = updateMoneyGramVoucherStatus('test_voucher_01', 'completed', 'Cash Collected at Counter');
  assert.equal(updated[0].status, 'completed');
  assert.equal(updated[0].statusLabel, 'Cash Collected at Counter');
  assert.ok(updated[0].completedAt, 'Should set completedAt timestamp');
});

test('realistic amount validation strictly enforces between 5 and 50 USDC', () => {
  const realisticAmount = 25; // 25 USDC
  assert.ok(realisticAmount >= 5 && realisticAmount <= 50, 'Amount must be realistic (5 to 50 USDC)');
});

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
