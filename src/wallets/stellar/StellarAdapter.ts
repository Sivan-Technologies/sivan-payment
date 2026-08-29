import { IChainAdapter, ChainTransferParams, ChainTransferResult } from '../IChainAdapter.js';
import { readStellarUsdcBalance, isStellarHorizonHealthy } from './stellar-rpc.js';
import { validateAddressForChain } from '../address-validation.js';
import { getWalletProvider } from '../provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallet-controls.service.js';
import { db } from '../../database/json-database.js';

export class StellarAdapter implements IChainAdapter {
  readonly chain = 'stellar' as const;

  async getDepositAddress(userId: string): Promise<string> {
    const wallet = await db.findUserWallet(userId, 'stellar');
    if (wallet?.address) {
      return wallet.address;
    }
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    const created = await provider.createWallet({
      userId,
      chain: 'stellar',
      idempotencyKey: `stellar_prov_${userId}`,
    });
    return created.address;
  }

  async getBalance(userId: string, asset = 'usdc'): Promise<number> {
    const wallet = await db.findUserWallet(userId, 'stellar');
    if (!wallet?.address) return 0;
    return readStellarUsdcBalance(wallet.address);
  }

  async transfer(params: ChainTransferParams): Promise<ChainTransferResult> {
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    const wallet = await db.findUserWallet(params.fromUserId, 'stellar');
    if (!wallet?.providerWalletId) {
      throw new Error(`No active Stellar wallet found for user: ${params.fromUserId}`);
    }

    const transfer = await provider.createTransfer({
      providerWalletId: wallet.providerWalletId,
      providerCustomerId: wallet.customerId,
      chain: 'stellar',
      asset: (params.asset || 'usdc') as any,
      amount: String(params.amountUsdc),
      toAddress: params.toAddress,
      idempotencyKey: params.idempotencyKey,
      reference: params.idempotencyKey,
    });

    return {
      txHash: transfer.txHash || transfer.providerTransferId,
      network: 'stellar',
      feePaid: '0.00000 XLM (Sponsored by Sivan)',
      timestamp: new Date().toISOString(),
    };
  }

  validateAddress(address: string): boolean {
    const check = validateAddressForChain(address, 'stellar');
    return check.valid;
  }

  async isHealthy(): Promise<boolean> {
    return isStellarHorizonHealthy();
  }
}
