import { updatePaymentControls, getPaymentControls } from '../src/controls/payment-controls.service.js';

async function main() {
  console.log('=== APPLYING STRICT MULTI-CHAIN SOURCE NETWORKS TO PAYMENT CONTROLS ===');
  
  const updated = await updatePaymentControls({
    sourceNetworks: [
      { network: 'solana', enabled: true, isDefault: true },
      { network: 'base', enabled: true, isDefault: false },
      { network: 'bsc', enabled: true, isDefault: false },
      { network: 'stellar', enabled: true, isDefault: false },
      { network: 'celo', enabled: true, isDefault: false },
      { network: 'ethereum', enabled: false, isDefault: false },
      { network: 'polygon', enabled: false, isDefault: false },
      { network: 'arbitrum', enabled: false, isDefault: false },
      { network: 'avalanche_c_chain', enabled: false, isDefault: false }
    ]
  }, 'system_migration');

  console.log('Updated Payment Controls:', JSON.stringify(updated.sourceNetworks, null, 2));
}

main().catch(console.error);
