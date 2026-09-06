import { IChainAdapter, ChainTransferParams, ChainTransferResult } from '../IChainAdapter.js';
import { isCeloHealthy, CELO_USDC_MAINNET, CELO_CUSD_MAINNET } from './celo-rpc.js';
import { validateAddressForChain } from '../address-validation.js';
import { getWalletProvider } from '../provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallet-controls.service.js';
import { db } from '../../database/json-database.js';

export class CeloAdapter implements IChainAdapter {
  readonly chain = 'celo' as const;

  async getDepositAddress(userId: string): Promise<string> {
    const wallet = await db.findUserWallet(userId, 'celo');
    if (wallet?.address) {
      return wallet.address;
    }
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    const created = await provider.createWallet({
      userId,
      chain: 'celo',
      idempotencyKey: `celo_prov_${userId}`,
    });

    await db.insertUserWallet({
      id: `uw_${userId}_celo_${Date.now()}`,
      userId,
      provider: provider.name,
      providerWalletId: created.providerWalletId,
      chain: 'celo',
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
    const wallet = await db.findUserWallet(userId, 'celo');
    if (!wallet?.providerWalletId) return 0;
    const balances = await provider.getBalances(
      wallet.providerWalletId,
      wallet.customerId,
      wallet.address,
      'celo'
    );
    const match = balances.find(
      (b) => b.asset.toLowerCase() === asset.toLowerCase() && (b.chain === 'celo' || b.chain === 'ethereum')
    );
    return match ? Number(match.amount) : 0;
  }

  async transfer(params: ChainTransferParams): Promise<ChainTransferResult> {
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    let wallet = await db.findUserWallet(params.fromUserId, 'celo');
    if (!wallet?.providerWalletId) {
      await this.getDepositAddress(params.fromUserId);
      wallet = await db.findUserWallet(params.fromUserId, 'celo');
    }
    if (!wallet) throw new Error(`Could not resolve Celo wallet for user: ${params.fromUserId}`);

    const transfer = await provider.createTransfer({
      providerWalletId: wallet.providerWalletId,
      providerCustomerId: wallet.customerId,
      chain: 'celo',
      asset: (params.asset || 'usdc') as any,
      amount: String(params.amountUsdc),
      toAddress: params.toAddress,
      idempotencyKey: params.idempotencyKey,
      reference: params.idempotencyKey,
    });

    return {
      txHash: transfer.txHash || transfer.providerTransferId,
      network: 'celo',
      timestamp: new Date().toISOString(),
    };
  }

  validateAddress(address: string): boolean {
    const check = validateAddressForChain(address, 'celo');
    return check.valid;
  }

  async isHealthy(): Promise<boolean> {
    return isCeloHealthy();
  }
}
