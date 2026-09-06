import { IChainAdapter, ChainTransferParams, ChainTransferResult } from '../IChainAdapter.js';
import { evmRpc } from './evm-rpc.js';
import { validateAddressForChain } from '../address-validation.js';
import { getWalletProvider } from '../provider/provider-registry.js';
import { resolveActiveWalletProvider } from '../wallet-controls.service.js';
import { db } from '../../database/json-database.js';

export class EvmAdapter implements IChainAdapter {
  readonly chain: 'base' | 'ethereum' | 'bsc' | 'bnb';

  constructor(chain: 'base' | 'ethereum' | 'bsc' | 'bnb' = 'base') {
    this.chain = chain;
  }

  async getDepositAddress(userId: string): Promise<string> {
    const wallet = await db.findUserWallet(userId, this.chain);
    if (wallet?.address) {
      return wallet.address;
    }
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    const created = await provider.createWallet({
      userId,
      chain: this.chain,
      idempotencyKey: `evm_prov_${this.chain}_${userId}`,
    });

    await db.insertUserWallet({
      id: `uw_${userId}_${this.chain}_${Date.now()}`,
      userId,
      provider: provider.name,
      providerWalletId: created.providerWalletId,
      chain: this.chain,
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
    const wallet = await db.findUserWallet(userId, this.chain);
    if (!wallet) return 0;
    const balances = await provider.getBalances(
      wallet.providerWalletId,
      wallet.customerId,
      wallet.address,
      this.chain
    );
    const match = balances.find(
      (b) => b.asset.toLowerCase() === asset.toLowerCase() && (b.chain === this.chain || b.chain === 'ethereum')
    );
    return match ? Number(match.amount) : 0;
  }

  async transfer(params: ChainTransferParams): Promise<ChainTransferResult> {
    const provider = getWalletProvider(await resolveActiveWalletProvider());
    let wallet = await db.findUserWallet(params.fromUserId, this.chain);
    if (!wallet?.providerWalletId) {
      await this.getDepositAddress(params.fromUserId);
      wallet = await db.findUserWallet(params.fromUserId, this.chain);
    }
    if (!wallet) throw new Error(`Could not resolve ${this.chain} wallet for user: ${params.fromUserId}`);

    const transfer = await provider.createTransfer({
      providerWalletId: wallet.providerWalletId,
      providerCustomerId: wallet.customerId,
      chain: this.chain,
      asset: (params.asset || 'usdc') as any,
      amount: String(params.amountUsdc),
      toAddress: params.toAddress,
      idempotencyKey: params.idempotencyKey,
      reference: params.idempotencyKey,
    });

    return {
      txHash: transfer.txHash || transfer.providerTransferId,
      network: this.chain,
      timestamp: new Date().toISOString(),
    };
  }

  validateAddress(address: string): boolean {
    const check = validateAddressForChain(address, this.chain);
    return check.valid;
  }

  async isHealthy(): Promise<boolean> {
    try {
      const blockNumber = await evmRpc<string>(this.chain, 'eth_blockNumber', []);
      return typeof blockNumber === 'string' && blockNumber.startsWith('0x');
    } catch {
      return false;
    }
  }
}
