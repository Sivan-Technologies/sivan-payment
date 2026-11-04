import assert from 'node:assert';
import { calculateEthServiceFeeUsd } from '../src/admin/admin-fees.service.js';

console.log('--- Testing calculateEthServiceFeeUsd ---');

// Test 1: Tier 1 ($5 - $99): 1.5% with $1.50 minimum
const fee10 = calculateEthServiceFeeUsd(10);
assert.strictEqual(fee10, 1.50, `Expected $1.50 minimum on $10, got ${fee10}`);

const fee80 = calculateEthServiceFeeUsd(80);
// 80 * 0.015 = 1.2 -> minimum floor 1.50 applies
assert.strictEqual(fee80, 1.50, `Expected $1.50 minimum on $80, got ${fee80}`);

const fee95 = calculateEthServiceFeeUsd(95);
// 95 * 0.015 = 1.425 -> minimum floor 1.50 applies
assert.strictEqual(fee95, 1.50, `Expected $1.50 minimum on $95, got ${fee95}`);

console.log('✓ Tier 1 ($5-$99) tests passed');

// Test 2: Tier 2 ($100 - $499): 1.0%
const fee100 = calculateEthServiceFeeUsd(100);
assert.strictEqual(fee100, 1.00, `Expected $1.00 on $100, got ${fee100}`);

const fee300 = calculateEthServiceFeeUsd(300);
assert.strictEqual(fee300, 3.00, `Expected $3.00 on $300, got ${fee300}`);

const fee499 = calculateEthServiceFeeUsd(499);
assert.strictEqual(fee499, 4.99, `Expected $4.99 on $499, got ${fee499}`);

console.log('✓ Tier 2 ($100-$499) tests passed');

// Test 3: Mid Flat Tier ($500 - $9,999): $10 flat
const fee500 = calculateEthServiceFeeUsd(500);
assert.strictEqual(fee500, 10.00, `Expected $10.00 on $500, got ${fee500}`);

const fee1600 = calculateEthServiceFeeUsd(1600);
assert.strictEqual(fee1600, 10.00, `Expected $10.00 on $1,600, got ${fee1600}`);

const fee9999 = calculateEthServiceFeeUsd(9999);
assert.strictEqual(fee9999, 10.00, `Expected $10.00 on $9,999, got ${fee9999}`);

console.log('✓ Mid Flat Tier ($500-$9,999) tests passed');

// Test 4: Whale Tier ($10,000+): 0.50% with $100 cap
const fee10000 = calculateEthServiceFeeUsd(10000);
// 10000 * 0.005 = 50.00 (under $100 cap)
assert.strictEqual(fee10000, 50.00, `Expected $50.00 on $10,000, got ${fee10000}`);

const fee15000 = calculateEthServiceFeeUsd(15000);
// 15000 * 0.005 = 75.00 (under $100 cap)
assert.strictEqual(fee15000, 75.00, `Expected $75.00 on $15,000, got ${fee15000}`);

const fee25000 = calculateEthServiceFeeUsd(25000);
// 25000 * 0.005 = 125.00 -> capped at $100.00
assert.strictEqual(fee25000, 100.00, `Expected $100.00 cap on $25,000, got ${fee25000}`);

const fee50000 = calculateEthServiceFeeUsd(50000);
// 50000 * 0.005 = 250.00 -> capped at $100.00
assert.strictEqual(fee50000, 100.00, `Expected $100.00 cap on $50,000, got ${fee50000}`);

console.log('✓ Whale Tier ($10,000+) tests passed');

// Test 5: Whale Cap Disabled (ethWhaleCapUsd = 0)
const fee50000Uncapped = calculateEthServiceFeeUsd(50000, { ethWhaleCapUsd: 0 });
// 50000 * 0.005 = 250.00 (uncapped)
assert.strictEqual(fee50000Uncapped, 250.00, `Expected $250.00 uncapped on $50,000, got ${fee50000Uncapped}`);

console.log('✓ Whale Cap Disabled (cap = 0) tests passed');

// Test 6: Flat Fee Mode
const feeFlatMode = calculateEthServiceFeeUsd(1500, { ethServiceFeeMode: 'flat', ethServiceFeeFlatUsd: 5.0 });
assert.strictEqual(feeFlatMode, 5.00, `Expected $5.00 in flat mode, got ${feeFlatMode}`);

console.log('✓ Flat Fee Mode tests passed');

// Test 7: Percentage Mode
const feePercentMode = calculateEthServiceFeeUsd(2000, { ethServiceFeeMode: 'percent', ethServiceFeePercent: 1.25 });
assert.strictEqual(feePercentMode, 25.00, `Expected $25.00 in percent mode, got ${feePercentMode}`);

console.log('✓ Percentage Mode tests passed');

console.log('ALL ETH SERVICE FEE TESTS PASSED (7/7)!');
process.exit(0);
