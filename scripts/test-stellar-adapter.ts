import { validateAddressForChain } from '../src/wallets/address-validation.js';
import { getChainAdapter } from '../src/wallets/chain-adapter-registry.js';
import { StellarAdapter } from '../src/wallets/stellar/StellarAdapter.js';
import { getStellarUsdcIssuer, STELLAR_USDC_ISSUER_MAINNET, STELLAR_USDC_ISSUER_TESTNET } from '../src/wallets/stellar/trustline.js';
import { getFeeSponsorshipConfig } from '../src/wallets/stellar/fee-bump.js';

console.log('==================================================');
console.log('🚀 TESTING SIVAN STELLAR WALLET ADAPTER & PROTOCOLS');
console.log('==================================================\n');

let passed = 0;
let failed = 0;

function check(title: string, condition: boolean, extra = '') {
  if (condition) {
    console.log(`  ✅ ok - ${title}`);
    passed++;
  } else {
    console.error(`  ❌ fail - ${title} ${extra ? `(${extra})` : ''}`);
    failed++;
  }
}

// 1. Address Validation Tests
console.log('══ 1. Stellar Address Validation (G-Account & M-Account) ══');
const validGAddress = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const validMAddress = 'MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN1234567890123';
const invalidEvm = '0xcebA9300f2b948710d2653dD7B07f33A8B32118C';
const invalidShort = 'GA5ZSEJYB37JRC5AVCIA';

check('accepts valid 56-character Stellar G-address', validateAddressForChain(validGAddress, 'stellar').valid);
check('rejects EVM 0x address when Stellar is requested', !validateAddressForChain(invalidEvm, 'stellar').valid);
check('rejects truncated Stellar address', !validateAddressForChain(invalidShort, 'stellar').valid);

// 2. Adapter Registry & Resolution
console.log('\n══ 2. Centralized Multi-Chain Adapter Registry ══');
const adapter = getChainAdapter('stellar');
check('resolves StellarAdapter via getChainAdapter("stellar")', adapter instanceof StellarAdapter);
check('adapter chain identifier is "stellar"', adapter.chain === 'stellar');

const solAdapter = getChainAdapter('solana');
check('resolves SolanaAdapter via getChainAdapter("solana")', solAdapter.chain === 'solana');

const baseAdapter = getChainAdapter('base');
check('resolves EvmAdapter via getChainAdapter("base")', baseAdapter.chain === 'base');

// 3. Trustline & Issuer Config
console.log('\n══ 3. Circle USDC Trustline Configuration ══');
const issuer = getStellarUsdcIssuer();
check('resolves official Circle USDC issuer', issuer === STELLAR_USDC_ISSUER_TESTNET || issuer === STELLAR_USDC_ISSUER_MAINNET);

// 4. Zero-Gas Fee Sponsorship (CAP-0015)
console.log('\n══ 4. Zero-Gas Fee Sponsorship Engine (CAP-0015) ══');
const feeConfig = getFeeSponsorshipConfig();
check('fee sponsorship configuration is active', feeConfig.maxBaseFeeStroops > 0);
check('sponsored reserves enabled', feeConfig.sponsoredReservesEnabled === true);

console.log('\n==================================================');
console.log(`📊 RESULTS: ${passed} passed, ${failed} failed`);
console.log('==================================================\n');

if (failed > 0) {
  process.exit(1);
}
