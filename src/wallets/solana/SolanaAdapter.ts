import { IChainAdapter, ChainTransferParams, ChainTransferResult } from '../IChainAdapter.js';
import { solanaRpc } from './solana-rpc.js';
import { validateAddressForChain } from '../address-validation.js';
import { getWalletProvider } from '../provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallet-controls.service.js';
import { db } from '../../database/json-database.js';

export class SolanaAdapter implements IChainAdapter {
  readonly chain = 'solana' as const;

  async getDepositAddress(userId: string): Promise<string> {
    const wallet = await db.findUserWallet(userId, 'solana');
    if (wallet?.address) {
      return wallet.address;
    }
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    const created = await provider.createWallet({
      userId,
      chain: 'solana',
      idempotencyKey: `sol_prov_${userId}`,
    });

    await db.insertUserWallet({
      id: `uw_${userId}_solana_${Date.now()}`,
      userId,
      provider: provider.name,
      providerWalletId: created.providerWalletId,
      chain: 'solana',
      address: created.address,
      status: 'active',
      custodial: true,
      delegatedSigningEnabled: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    return created.address;
  }

  async getBalance(userId: string, asset = 'usdc'): Promise<number> {
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    const wallet = await db.findUserWallet(userId, 'solana');
    if (!wallet?.providerWalletId) return 0;
    const balances = await provider.getBalances(wallet.providerWalletId, 'solana');
    const match = balances.find((b) => b.asset.toLowerCase() === asset.toLowerCase() && b.chain === 'solana');
    return match ? Number(match.amount) : 0;
  }

  async transfer(params: ChainTransferParams): Promise<ChainTransferResult> {
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    let wallet = await db.findUserWallet(params.fromUserId, 'solana');
    if (!wallet?.providerWalletId) {
      await this.getDepositAddress(params.fromUserId);
      wallet = await db.findUserWallet(params.fromUserId, 'solana');
    }
    if (!wallet) throw new Error(`Could not resolve Solana wallet for user: ${params.fromUserId}`);

    const transfer = await provider.createTransfer({
      providerWalletId: wallet.providerWalletId,
      providerCustomerId: wallet.customerId,
      chain: 'solana',
      asset: (params.asset || 'usdc') as any,
      amount: String(params.amountUsdc),
      toAddress: params.toAddress,
      idempotencyKey: params.idempotencyKey,
      reference: params.idempotencyKey,
    });

    return {
      txHash: transfer.txHash || transfer.providerTransferId,
      network: 'solana',
      timestamp: new Date().toISOString(),
    };
  }

  validateAddress(address: string): boolean {
    const check = validateAddressForChain(address, 'solana');
    return check.valid;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const response = await solanaRpc<string>('getHealth', []);
      return response.result === 'ok';
    } catch {
      try {
        const slot = await solanaRpc<number>('getSlot', []);
        return typeof slot.result === 'number' && slot.result > 0;
      } catch {
        return false;
      }
    }
  }
}
