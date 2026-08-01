/**
 * Generate a Privy delegated-signer keypair and register its key quorum.
 *
 * This is the credential that lets Sivan's backend move funds out of a
 * user-owned wallet without the user signing. It is generated rather than
 * fetched from a dashboard, because Privy never sees the private half - you
 * register the PUBLIC key with them and keep the private key yourself.
 *
 * WHY A SEPARATE KEY PER ENVIRONMENT
 *
 * A wallet's signer is fixed at creation and cannot be changed afterwards, so
 * a key is effectively permanent for every wallet issued under it. Sharing one
 * key between test and production means a leaked test key can move real funds,
 * and there is no way to rotate away from it for existing wallets.
 *
 * Run: npm run privy:generate-signer
 */

import 'dotenv/config';
import { generateAuthorizationKeyPair } from '../src/wallets/provider/privy-authorization.js';

const APP_ID = process.env.PRIVY_APP_ID ?? '';
const APP_SECRET = process.env.PRIVY_APP_SECRET ?? '';
const BASE = 'https://api.privy.io/v1';

async function main() {
  if (!APP_ID || !APP_SECRET) {
    console.error('\nPRIVY_APP_ID and PRIVY_APP_SECRET must be set first.');
    console.error('Get them from dashboard.privy.io -> your app -> App settings -> Basics\n');
    process.exit(1);
  }

  const label = process.argv[2] ?? 'sivan-production';
  const { publicKeySpki, privateKeyPem } = generateAuthorizationKeyPair();

  // Only the PUBLIC key is sent. Privy cannot sign on Sivan's behalf, and
  // cannot help recover the private key if it is lost.
  const response = await fetch(`${BASE}/key_quorums`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Basic ${Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64')}`,
      'privy-app-id': APP_ID,
    },
    body: JSON.stringify({
      display_name: label,
      public_keys: [publicKeySpki],
      authorization_threshold: 1,
    }),
  });

  const quorum: any = await response.json();
  if (!response.ok || !quorum?.id) {
    console.error(`\nPrivy refused: HTTP ${response.status} ${JSON.stringify(quorum)}\n`);
    process.exit(1);
  }

  // Base64 because a PEM contains newlines, and pasting one into a dashboard
  // env var mangles it into an opaque parse error at boot.
  // loadAuthorizationPrivateKey() accepts either form.
  const privateKeyB64 = Buffer.from(privateKeyPem).toString('base64');

  console.log('\n' + '='.repeat(70));
  console.log(`  SIGNER CREATED: ${label}`);
  console.log('='.repeat(70));
  console.log('\nPRIVY_AUTHORIZATION_KEY_QUORUM_ID=' + quorum.id);
  console.log('\nPRIVY_AUTHORIZATION_PRIVATE_KEY=' + privateKeyB64);
  console.log('\n' + '='.repeat(70));
  console.log('  Paste both into Render -> Environment. Nowhere else.');
  console.log('');
  console.log('  This private key can move user funds. Privy does not store it');
  console.log('  and cannot recover it. Losing it means every wallet issued');
  console.log('  under this quorum can never be signed for again - signers are');
  console.log('  fixed at wallet creation and cannot be replaced.');
  console.log('='.repeat(70) + '\n');
}

main().catch((error) => { console.error('\nthrew:', error?.message ?? error); process.exit(1); });
