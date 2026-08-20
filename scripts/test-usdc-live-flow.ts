import { getUserByEmail } from '../src/users/users.service.js';
import { getUserWalletWithBalances } from '../src/wallets/user-wallet.service.js';
import { getUnifiedBalance } from '../src/balances/unified-balance.service.js';
import { db } from '../src/database/json-database.js';
import fetch from 'node-fetch';

async function main() {
  console.log('=== Step 1: Finding user solianetwork0@gmail.com ===');
  const user = await getUserByEmail('solianetwork0@gmail.com');
  console.log('Found user:', user);

  if (!user) {
    console.error('User solianetwork0@gmail.com not found in payment database');
    return;
  }

  // Get user's solana and base wallets
  const solanaWallet = await getUserWalletWithBalances(user.id, 'solana').catch((e: any) => ({ error: e.message }));
  const baseWallet = await getUserWalletWithBalances(user.id, 'base').catch((e: any) => ({ error: e.message }));
  console.log('Solana Wallet:', solanaWallet);
  console.log('Base Wallet:', baseWallet);

  // Get unified balances
  const balances = await getUnifiedBalance(user.id).catch((e: any) => ({ error: e.message }));
  console.log('User Unified Balances:', balances);

  // Check identity links
  const links = await db.listCustomerIdentityLinks();
  const userLinks = links.filter((l: any) => l.userId === user.id);
  console.log('Identity links:', userLinks);

  const phone = user.whatsappNumber || (userLinks.find((l: any) => l.channel === 'whatsapp') as any)?.channelIdentifier || '+2348079604214';
  console.log('Using Phone / Actor:', phone);

  // Test creating a Service Agreement on Core Escrow Agent
  console.log('\n=== Step 2: Create Test Service Agreement (1 USDC) ===');
  const CORE_URL = process.env.CORE_API_URL || 'https://test-sivan.sivantech.online';
  const CORE_SECRET = process.env.CORE_API_SECRET || 'Yu3w1j5s-I7SgaxBNOAVcaUrW0SpkrlKoo7zppgnMrI';

  const sellerPhone = '+2348000000002'; // test seller
  const payload = {
    creatorWhatsapp: phone,
    buyerWhatsapp: phone,
    sellerWhatsapp: sellerPhone,
    amount: 1,
    currency: 'USDC',
    purpose: 'Live USDC x402 End to End Test',
    feePayer: 'buyer',
  };

  const createRes = await fetch(`${CORE_URL}/api/escrows`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
    body: JSON.stringify(payload),
  });

  const createData: any = await createRes.json();
  console.log('Create Agreement Response:', createRes.status, createData);

  if (!createRes.ok || !createData.escrow) {
    console.error('Failed to create escrow');
    return;
  }

  const escrowId = createData.escrow.escrowId;
  console.log(`\n=== Step 3: Accept Service Agreement as Seller (${sellerPhone}) ===`);
  const acceptRes = await fetch(`${CORE_URL}/api/escrows/${escrowId}/accept`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
    body: JSON.stringify({ actorWhatsapp: sellerPhone }),
  });
  console.log('Accept Response:', acceptRes.status, await acceptRes.json());

  console.log(`\n=== Step 4: Request Payment Instruction as Buyer (${phone}) ===`);
  const payRes = await fetch(`${CORE_URL}/api/escrows/${escrowId}/payment-instruction`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
    body: JSON.stringify({ actorWhatsapp: phone }),
  });
  const payData: any = await payRes.json();
  console.log('Payment Instruction Response:', payRes.status, payData);

  console.log(`\n=== Step 5: Verify Agreement Status ===`);
  const statusRes = await fetch(`${CORE_URL}/api/escrows/${escrowId}?actorWhatsapp=${encodeURIComponent(phone)}`, {
    headers: {
      'x-api-secret': CORE_SECRET,
      'x-core-api-secret': CORE_SECRET,
    },
  });
  console.log('Status Response:', statusRes.status, await statusRes.json());
}

main().catch(console.error);
