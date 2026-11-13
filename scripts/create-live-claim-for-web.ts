import { ClaimService } from '../src/claims/claim.service.js';

async function main() {
  console.log('--- Generating Fresh 10 USDC NEAR Claim for Web Testing ---');
  
  const senderUserId = 'usr_1b88b9b4-a2b0-42d8-a940-d0b2fcc5acc4';
  const recipientPhone = '+2348055667788';
  
  const result = await ClaimService.createClaim({
    userId: senderUserId,
    recipientPhone,
    amount: '10.000000',
    asset: 'usdc',
    network: 'near',
  });

  const appUrl = (process.env.CUSTOMER_APP_URL || 'http://localhost:5173').replace(/\/$/, '');
  const claimToken = result.claim.token || '';
  const localWebClaimUrl = `http://localhost:5173/claim?token=${encodeURIComponent(claimToken)}`;
  const stagingWebClaimUrl = `https://staging.sivantech.online/claim?token=${encodeURIComponent(claimToken)}`;

  console.log('\n================ CLAIM CREATED SUCCESSFULLY ================');
  console.log('Claim Token:', result.claim.token);
  console.log('Security PIN (6-digit):', result.claimCode);
  console.log('Amount:', `${result.claim.amount} ${result.claim.asset.toUpperCase()}`);
  console.log('Settlement Network:', result.claim.network);
  console.log('Recipient Phone:', recipientPhone);
  console.log('Expires At:', result.claim.expiresAt);
  console.log('\n--- URLs to Test ---');
  console.log('Local Web URL:', localWebClaimUrl);
  console.log('Staging Web URL:', stagingWebClaimUrl);
  console.log('============================================================\n');
}

main().then(() => process.exit(0)).catch((err) => {
  console.error('Error creating claim:', err);
  process.exit(1);
});
