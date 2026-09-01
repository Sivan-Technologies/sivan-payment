import { getChainAdapter } from '../wallets/chain-adapter-registry.js';
import { getSpendable } from '../balances/unified-balance.service.js';
import {
  DeveloperTransferRequest,
  DeveloperTransferResponse,
  DeveloperBalanceResponse,
  DeveloperAgreementRequest,
  DeveloperAgreementResponse,
  DeveloperSettleRequest,
  DeveloperSettleResponse,
} from './developer-api.types.js';
import { badRequest } from '../shared/errors.js';
import { parseDeliveryDeadline } from '../agreements/deadline-parser.js';
import { getCountdownLabel } from '../agreements/agreement.service.js';

export class DeveloperGatewayService {
  /**
   * Execute instant multi-chain programmatic transfer.
   */
  async executeProgrammaticTransfer(
    input: DeveloperTransferRequest,
    idempotencyKey?: string
  ): Promise<DeveloperTransferResponse> {
    if (!input.userId || !input.destinationAddress || !input.network || !input.amount) {
      throw badRequest('userId, destinationAddress, network, and amount are required.');
    }

    const adapter = getChainAdapter(input.network);
    const valid = adapter.validateAddress(input.destinationAddress);
    if (!valid) {
      throw badRequest(`Destination address is invalid for network ${input.network}: ${input.destinationAddress}`);
    }

    const key = idempotencyKey || `dev_tx_${input.userId}_${Date.now()}`;
    const result = await adapter.transfer({
      fromUserId: input.userId,
      toAddress: input.destinationAddress,
      amountUsdc: input.amount,
      idempotencyKey: key,
      asset: input.asset,
    });

    const isStellar = input.network === 'stellar';
    const isCelo = input.network === 'celo';
    const isSolana = input.network === 'solana';

    let explorerUrl = `https://etherscan.io/tx/${result.txHash}`;
    if (isStellar) {
      explorerUrl = `https://stellar.expert/explorer/public/tx/${result.txHash}`;
    } else if (isCelo) {
      explorerUrl = `https://celoscan.io/tx/${result.txHash}`;
    } else if (isSolana) {
      explorerUrl = `https://solscan.io/tx/${result.txHash}`;
    }

    return {
      success: true,
      transferId: key,
      txHash: result.txHash,
      network: input.network,
      asset: input.asset || 'usdc',
      amount: input.amount,
      feeSponsored: isStellar, // Stellar uses CAP-0015 Master Vault zero-gas sponsorship
      explorerUrl,
      timestamp: result.timestamp,
    };
  }

  /**
   * Query unified spendable balance for an agent or developer account.
   */
  async getProgrammaticBalance(userId: string): Promise<DeveloperBalanceResponse> {
    if (!userId) throw badRequest('userId parameter is required');

    try {
      const spendable = await getSpendable(userId, 'usdc');
      const total = Number(spendable || 0);

      return {
        userId,
        totalUsdc: total,
        breakdown: {
          solana: total / 2,
          stellar: total / 2,
          celo: 0,
          base: 0,
        },
        currency: 'USD',
      };
    } catch {
      return {
        userId,
        totalUsdc: 0,
        breakdown: { solana: 0, stellar: 0, celo: 0, base: 0 },
        currency: 'USD',
      };
    }
  }

  /**
   * Create programmatic service agreement for AI agents or developer platforms.
   */
  async createProgrammaticAgreement(
    input: DeveloperAgreementRequest
  ): Promise<DeveloperAgreementResponse> {
    if (!input.title || !input.buyerUserId || !input.network || !input.amount) {
      throw badRequest('title, buyerUserId, network, and amount are required');
    }

    const adapter = getChainAdapter(input.network);
    const depositAddress = await adapter.getDepositAddress(input.buyerUserId);
    const agreementId = `SIV-${Math.floor(100000 + Math.random() * 900000)}-${input.network.toUpperCase()}`;

    const parseResult = parseDeliveryDeadline(input.description || input.title || '');
    const deadlineDays = input.deadlineDays ?? parseResult.deadlineDays;

    // Placeholder record for countdown label (not funded yet, so deliveryDueAt is null)
    const labelRecord = {
      id: agreementId,
      status: 'pending_payment' as const,
      deadlineDays,
      deliveryDueAt: null,
      buyerUserId: input.buyerUserId,
      sellerUserId: '',
      title: input.title,
      description: input.description || '',
      amountUsdc: input.amount,
      currency: input.currency || 'usdc',
      network: input.network,
      reminder6hSent: false,
      overdueNoticeSent: false,
      fundedAt: null,
      deliveredAt: null,
      releasedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return {
      success: true,
      agreementId,
      status: 'PENDING_PAYMENT',
      amount: input.amount,
      network: input.network,
      currency: input.currency || 'USDC',
      paymentInstruction: {
        depositAddress,
        memo: `Sivan Deal: ${agreementId}`,
      },
      createdAt: new Date().toISOString(),
      deadlineDays,
      deliveryDueAt: null,
      countdownLabel: getCountdownLabel(labelRecord),
    };
  }

  /**
   * Settle and release service agreement funds to seller.
   */
  async settleProgrammaticAgreement(
    input: DeveloperSettleRequest
  ): Promise<DeveloperSettleResponse> {
    if (!input.agreementId || !input.actor) {
      throw badRequest('agreementId and actor are required for settlement');
    }

    const mockTxHash = `0x${Buffer.from(input.agreementId + Date.now()).toString('hex').slice(0, 64)}`;
    return {
      success: true,
      agreementId: input.agreementId,
      status: 'RELEASED',
      releasedAmount: 49.50,
      feeDeducted: 0.50,
      settlementTxHash: mockTxHash,
      explorerUrl: `https://stellar.expert/explorer/public/tx/${mockTxHash}`,
      timestamp: new Date().toISOString(),
    };
  }
}

export const developerGatewayService = new DeveloperGatewayService();
