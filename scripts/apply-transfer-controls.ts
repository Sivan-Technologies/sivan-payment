import { updateBalanceTransferControls, getBalanceTransferControls } from '../src/balances/balance.service.js';

async function update() {
  console.log('Current controls before:');
  console.log(await getBalanceTransferControls());

  console.log('Updating transfer controls to enabled across all chains...');
  const updated = await updateBalanceTransferControls({
    transfersEnabled: true,
    p2pTransfersEnabled: true,
    minimumSendAmount: 0.1,
    manualReviewThreshold: 1000,
    riskHoldsEnabled: false,
    supportedNetworks: ['solana', 'base', 'celo', 'stellar', 'bsc', 'ethereum'] as any,
    p2pClaimExpiryDays: 7,
    updatedBy: 'admin',
    reason: 'Multi-chain live testing activation',
  }, { ipAddress: '127.0.0.1' });

  console.log('Updated controls:', updated);
  console.log('Verified getBalanceTransferControls():', await getBalanceTransferControls());
}

update().catch(console.error);
