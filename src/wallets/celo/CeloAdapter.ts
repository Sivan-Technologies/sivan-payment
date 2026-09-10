import { IChainAdapter, ChainTransferParams, ChainTransferResult } from '../IChainAdapter.js';
import { isCeloHealthy, CELO_CNGN_MAINNET, CELO_CNGN_DECIMALS } from './celo-rpc.js';
import { resolveCeloFeeCurrency, getCeloFeeCurrencyRegistry, fetchCngnBalance } from './celo-fee-currency.js';
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
    const wallet = await db.findUserWallet(userId, 'celo');

    // cNGN balance: query on-chain directly since wallet providers may not index cNGN
    if (asset.toLowerCase() === 'cngn') {
      if (!wallet?.address) return 0;
      const rawBalance = await fetchCngnBalance(wallet.address);
      // cNGN uses 6 decimals
      return Number(rawBalance) / 1e6;
    }

    const provider = getWalletProvider(await resolveActiveWalletProvider());
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

    // Resolve fee currency via native Celo fee abstraction.
    // USDC → USDT → cUSD priority. No Privy gas sponsorship required.
    // Gas cost is a fraction of a cent and is invisible to the user.
    const { feeCurrencyAddress } = await resolveCeloFeeCurrency(wallet.address);

    const transfer = await provider.createTransfer({
      userId: params.fromUserId,
      providerWalletId: wallet.providerWalletId,
      providerCustomerId: wallet.customerId,
      chain: 'celo',
      asset: (params.asset || 'usdc'),
      // When transferring cNGN, override the token address to the cNGN contract
      ...(params.asset?.toLowerCase() === 'cngn' ? { tokenAddress: CELO_CNGN_MAINNET, decimals: CELO_CNGN_DECIMALS } : {}),
      amount: String(params.amountUsdc),
      toAddress: params.toAddress,
      idempotencyKey: params.idempotencyKey,
      reference: params.idempotencyKey,
      feeCurrency: feeCurrencyAddress,
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
