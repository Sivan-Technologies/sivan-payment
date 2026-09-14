import { getChainAdapter } from '../wallets/chain-adapter-registry.js';
import { getSpendable, getUnifiedBalance } from '../balances/unified-balance.service.js';
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
import { quoteServiceAgreementFee } from '../agreements/agreement-fee-policy.js';
import { resolveNetworkMode } from '../wallets/network-mode.js';
import { getNetworkExplorer } from '../utils/explorers.js';

/**
 * Centralised explorer URL builder routing through getNetworkExplorer().
 */
function getNetworkExplorerUrl(network: string, txHash: string): string {
  return getNetworkExplorer(network, txHash).url;
}


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

    const explorerUrl = getNetworkExplorerUrl(input.network, result.txHash || '');

    return {
      success: true,
      transferId: key,
      txHash: result.txHash,
      network: input.network,
      asset: input.asset || 'usdc',
      amount: input.amount,
      feeSponsored: input.network === 'stellar',
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
   * Intelligently auto-detect optimal settlement chain based on available balance and cost.
   */
  async resolveOptimalNetwork(userId: string, requestedNetwork?: string, amount = 0): Promise<string> {
    const validChains = ['solana', 'base', 'stellar', 'celo', 'bsc'];
    if (requestedNetwork && requestedNetwork !== 'auto' && validChains.includes(requestedNetwork.toLowerCase())) {
      return requestedNetwork.toLowerCase();
    }

    try {
      const unified = await getUnifiedBalance(userId);
      for (const w of unified.wallets) {
        const chainName = String(w.chain).toLowerCase();
        const chainBalance = w.balances?.find((b: any) => String(b.asset).toLowerCase() === 'usdc');
        const numAmt = Number(chainBalance?.amount || 0);
        if (numAmt >= amount && validChains.includes(chainName)) {
          return chainName;
        }
      }
    } catch {}

    return 'solana';
  }

  /**
   * Create programmatic service agreement for AI agents or developer platforms.
   */
  async createProgrammaticAgreement(
    input: DeveloperAgreementRequest
  ): Promise<DeveloperAgreementResponse> {
    if (!input.title || !input.buyerUserId || !input.amount) {
      throw badRequest('title, buyerUserId, and amount are required');
    }

    const selectedNetwork = (await this.resolveOptimalNetwork(input.buyerUserId, input.network, input.amount)) as any;
    const adapter = getChainAdapter(selectedNetwork);
    const depositAddress = await adapter.getDepositAddress(input.buyerUserId);
    const agreementId = `SIV-${Math.floor(100000 + Math.random() * 900000)}-${selectedNetwork.toUpperCase()}`;

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

    const feeQuote = quoteServiceAgreementFee(input.amount, selectedNetwork, 'buyer');

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
      fee: {
        feeAmount: feeQuote.feeAmount,
        feePercent: feeQuote.feePercent,
        feePayer: 'buyer',
        buyerTotalPayable: feeQuote.buyerTotalPayable,
        sellerNetAmount: feeQuote.sellerNetAmount,
      },
      createdAt: new Date().toISOString(),
      deadlineDays,
      deliveryDueAt: null,
      countdownLabel: getCountdownLabel(labelRecord),
    };
  }

  /**
   * Settle and release service agreement funds to seller.
   *
   * NOTE: Full on-chain settlement is tracked in the Future Build roadmap.
   * This endpoint requires a live agreement record lookup, on-chain release
   * transaction, and ledger debit. It must not execute with synthesised values.
   */
  async settleProgrammaticAgreement(
    input: DeveloperSettleRequest
  ): Promise<DeveloperSettleResponse> {
    if (!input.agreementId || !input.actor) {
      throw badRequest('agreementId and actor are required for settlement');
    }

    // On-chain settlement requires a real agreement lookup and execution path.
    // Implementation is tracked in FUTURE_BUILD_TIERED_FEE_SCHEDULE_CELO_STELLAR.md.
    throw badRequest(
      'Programmatic agreement settlement is not yet available via the developer API. ' +
      'Please use the Sivan payment application at https://app.sivantech.online to release funds.'
    );
  }
}

export const developerGatewayService = new DeveloperGatewayService();
