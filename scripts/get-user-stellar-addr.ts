import { generateStellarAddress } from '../src/wallets/stellar/stellar-keypair.js';

const userId = 'usr_fd28a1b5-d40a-4771-b286-ac2228b03b9a';
const address = generateStellarAddress('sivan_stellar_' + userId);
console.log('Real User Stellar Address for usr_fd28a1b5...:', address);
