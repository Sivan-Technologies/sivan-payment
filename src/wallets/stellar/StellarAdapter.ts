import { IChainAdapter, ChainTransferParams, ChainTransferResult } from '../IChainAdapter.js';
import { readStellarUsdcBalance, readStellarUsdtBalance, isStellarHorizonHealthy } from './stellar-rpc.js';
import { validateAddressForChain } from '../address-validation.js';
import { getWalletProvider } from '../provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallet-controls.service.js';
import { db } from '../../database/json-database.js';

import { generateStellarAddress } from './stellar-keypair.js';
import { ensureStellarAccountAndTrustline } from './trustline.js';

export class StellarAdapter implements IChainAdapter {
  readonly chain = 'stellar' as const;

  async getDepositAddress(userId: string): Promise<string> {
    const wallet = await db.findUserWallet(userId, 'stellar');
    if (wallet?.address) {
      ensureStellarAccountAndTrustline(`sivan_stellar_${userId}`, wallet.address).catch(() => null);
      return wallet.address;
    }

    const address = generateStellarAddress(`sivan_stellar_${userId}`);

    await db.insertUserWallet({
      id: `uw_${userId}_stellar_${Date.now()}`,
      userId,
      provider: 'stellar_native',
      providerWalletId: `stellar_${address}`,
      chain: 'stellar',
      address,
      status: 'active',
      custodial: false,
      delegatedSigningEnabled: true,
      raw: { address, chain: 'stellar', trustlineActive: true },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    ensureStellarAccountAndTrustline(`sivan_stellar_${userId}`, address).catch(() => null);

    return address;
  }

  async getBalance(userId: string, asset = 'usdc'): Promise<number> {
    const wallet = await db.findUserWallet(userId, 'stellar');
    if (!wallet?.address) return 0;
    const normalizedAsset = (asset || 'usdc').toLowerCase();
    if (normalizedAsset === 'usdt') {
      return readStellarUsdtBalance(wallet.address);
    }
    return readStellarUsdcBalance(wallet.address);
  }

  async transfer(params: ChainTransferParams): Promise<ChainTransferResult> {
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    let wallet = await db.findUserWallet(params.fromUserId, 'stellar');
    if (!wallet?.providerWalletId) {
      await this.getDepositAddress(params.fromUserId);
      wallet = await db.findUserWallet(params.fromUserId, 'stellar');
    }
    if (!wallet) throw new Error(`Could not resolve Stellar wallet for user: ${params.fromUserId}`);

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
