import crypto from 'node:crypto';
import type { WalletProvider } from './wallet-provider.js';
import type {
  CreateWalletInput,
  ProviderWallet,
  WalletBalance,
  WalletChain,
  WalletTransfer,
  WalletTransferInput,
} from '../types/wallet.types.js';

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

import { Keypair } from '@solana/web3.js';

/**
 * Deterministic per-seed address generation, so the same wallet id always
 * yields the same address across calls and restarts. Without this the UI
 * would show a different deposit address on every refresh, which is exactly
 * the bug class we most need to avoid in a wallet product.
 */
function seededBytes(seed: string, length: number): Buffer {
  const out: Buffer[] = [];
  let counter = 0;
  while (Buffer.concat(out).length < length) {
    out.push(crypto.createHash('sha256').update(`${seed}:${counter++}`).digest());
  }
  return Buffer.concat(out).subarray(0, length);
}

function mockSolanaAddress(seed: string): string {
  const bytes = Uint8Array.from(seededBytes(seed, 32));
  const keypair = Keypair.fromSeed(bytes);
  return keypair.publicKey.toBase58();
}

const STELLAR_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function mockStellarAddress(seed: string): string {
  const bytes = seededBytes(seed, 35);
  let s = 'G';
  for (let i = 0; i < 55; i++) s += STELLAR_ALPHABET[bytes[i % bytes.length] % STELLAR_ALPHABET.length];
  return s;
}

function mockEvmAddress(seed: string): string {
  return `0x${seededBytes(seed, 20).toString('hex')}`;
}

export function mockAddressForChain(chain: WalletChain, seed: string): string {
  if (chain === 'solana') return mockSolanaAddress(seed);
  if (chain === 'stellar') return mockStellarAddress(seed);
  return mockEvmAddress(seed);
}

/**
 * Local/dev wallet provider.
 *
 * Lets the wallet UI, routes and admin controls be built and demoed before a
 * vendor is chosen or approved. Generates realistic, stable addresses and
 * simulates non-custodial signing so the client handles both flows correctly.
 */
export class MockWalletProvider implements WalletProvider {
  readonly name = 'mock' as const;

  /**
   * Mock mimics non-custodial deliberately: it is the stricter of the two
   * flows. If the UI works here it will also work against a custodial
   * provider, but not necessarily the other way round.
   */
  readonly custodyModel = 'non_custodial' as const;

  readonly supportedChains = ['solana', 'base', 'ethereum', 'stellar', 'celo', 'bsc', 'bnb'] as const;

  private wallets = new Map<string, ProviderWallet>();
  private transfers = new Map<string, WalletTransfer>();

  async createWallet(input: CreateWalletInput): Promise<ProviderWallet> {
    if (!this.supportedChains.includes(input.chain)) {
      throw new Error(`Mock wallet provider does not support chain: ${input.chain}`);
    }

    // Idempotency: replaying the same key must return the same wallet, never
    // create a second one. Real providers enforce this and so must the mock.
    const existing = [...this.wallets.values()].find(
      (w) => (w.rawProviderPayload as any)?.idempotencyKey === input.idempotencyKey
    );
    if (existing) return existing;

    const providerWalletId = `mock_wallet_${crypto.randomUUID()}`;
    const wallet: ProviderWallet = {
      provider: this.name,
      providerWalletId,
      chain: input.chain,
      address: mockAddressForChain(input.chain, `${input.userId}:${input.chain}`),
      custodyModel: this.custodyModel,
      status: 'active',
      requiresUserSignature: true,
      balances: [],
      rawProviderPayload: {
        mode: 'mock',
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        generatedAt: new Date().toISOString(),
      },
      createdAt: new Date().toISOString(),
    };

    this.wallets.set(providerWalletId, wallet);
    return wallet;
  }

  async getWallet(providerWalletId: string): Promise<ProviderWallet> {
    const wallet = this.wallets.get(providerWalletId);
    if (!wallet) throw new Error(`Mock wallet not found: ${providerWalletId}`);
    return wallet;
  }

  async listWallets(providerCustomerId: string): Promise<ProviderWallet[]> {
    return [...this.wallets.values()].filter(
      (w) => (w.rawProviderPayload as any)?.userId === providerCustomerId
    );
  }

  /**
   * Balances for a wallet, ON THE CHAIN THAT WAS ASKED FOR.
   *
   * The chain argument was ignored entirely, so every read returned every
   * balance the wallet held on any network. That is not what a real provider
   * does - Privy reads one ERC-20 contract on one network - and it produced a
   * concrete wrong answer: unified-balance.service.ts reads a base/ethereum
   * wallet once per network it serves, so 108 USDC held on Base was returned
   * for the Base read AND for the Ethereum read and summed to 216.
   *
   * The mock exists to reproduce production's shape, including its
   * constraints. Silently over-reporting a balance is the single worst thing a
   * wallet mock can do, because every downstream test then agrees with it.
   */
  async getBalances(
    providerWalletId: string,
    _providerCustomerId?: string,
    _address?: string,
    chain?: WalletChain
  ): Promise<WalletBalance[]> {
    const wallet = await this.getWallet(providerWalletId);
    const balances = wallet.balances ?? [];
    // No chain given means "everything this wallet holds" - the same latitude
    // the interface allows, used by callers that only want a total.
    return chain ? balances.filter((balance) => balance.chain === chain) : balances;
  }

  /** Test helper: simulate an inbound deposit so the UI can render balances. */
  async __seedBalance(providerWalletId: string, balance: WalletBalance): Promise<void> {
    const wallet = await this.getWallet(providerWalletId);
    const balances = wallet.balances ?? [];
    const idx = balances.findIndex((b) => b.asset === balance.asset && b.chain === balance.chain);
    if (idx >= 0) balances[idx] = balance;
    else balances.push(balance);
    this.wallets.set(providerWalletId, { ...wallet, balances });
  }

  async createTransfer(input: WalletTransferInput): Promise<WalletTransfer> {
    const existing = [...this.transfers.values()].find(
      (t) => (t.rawProviderPayload as any)?.idempotencyKey === input.idempotencyKey
    );
    if (existing) return existing;

    const wallet = await this.getWallet(input.providerWalletId);
    const available = (wallet.balances ?? []).find(
      (b) => b.asset === input.asset && b.chain === input.chain
    );
    if (!available || Number(available.amount) < Number(input.amount)) {
      await this.__seedBalance(input.providerWalletId, {
        asset: input.asset,
        chain: input.chain,
        amount: '1000.00',
      });
    }

    const providerTransferId = `mock_transfer_${crypto.randomUUID()}`;
    const transfer: WalletTransfer = {
      provider: this.name,
      providerTransferId,
      // Non-custodial: the client must sign before anything moves.
      status: 'pending_user_signature',
      userSignaturePayload: {
        mode: 'mock',
        chain: input.chain,
        to: input.toAddress,
        amount: input.amount,
        asset: input.asset,
      },
      rawProviderPayload: { idempotencyKey: input.idempotencyKey, input },
    };

    this.transfers.set(providerTransferId, transfer);
    return transfer;
  }

  async getTransfer(providerTransferId: string): Promise<WalletTransfer> {
    const transfer = this.transfers.get(providerTransferId);
    if (!transfer) throw new Error(`Mock transfer not found: ${providerTransferId}`);
    return transfer;
  }

  /** Test helper: simulate the user signing, then confirmation on chain. */
  async __confirmTransfer(providerTransferId: string): Promise<WalletTransfer> {
    const transfer = await this.getTransfer(providerTransferId);
    const input = (transfer.rawProviderPayload as any)?.input as WalletTransferInput;

    const wallet = await this.getWallet(input.providerWalletId);
    const balances = (wallet.balances ?? []).map((b) =>
      b.asset === input.asset && b.chain === input.chain
        ? { ...b, amount: (Number(b.amount) - Number(input.amount)).toFixed(2) }
        : b
    );
    this.wallets.set(input.providerWalletId, { ...wallet, balances });

    const confirmed: WalletTransfer = {
      ...transfer,
      status: 'confirmed',
      userSignaturePayload: undefined,
      txHash: `mock_tx_${crypto.randomBytes(16).toString('hex')}`,
    };
    this.transfers.set(providerTransferId, confirmed);
    return confirmed;
  }
}
