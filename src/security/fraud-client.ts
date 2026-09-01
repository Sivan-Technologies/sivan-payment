import { env } from '../config/env.js';

export interface FraudEvaluationInput {
  userId: string;
  operationType: 'withdrawal' | 'p2p_transfer' | 'service_agreement_release' | 'bank_cashout';
  amount: number;
  currency: string;
  destination?: {
    address?: string;
    chain?: string;
    accountNumber?: string;
    bankCode?: string;
  };
  clientMetadata?: {
    channel?: 'telegram' | 'whatsapp' | 'web' | 'developer_api';
    ipAddress?: string;
    userAgent?: string;
    isTor?: boolean;
    isVpnOrProxy?: boolean;
    activeSessionsOnDevice?: number;
    recentTxCount1h?: number;
    recentVolume24h?: number;
  };
}

export interface FraudEvaluationResult {
  evaluationId: string;
  riskScore: number;
  verdict: 'allow' | 'step_up' | 'block';
  reasons: string[];
  factors: {
    ipRisk: number;
    deviceRisk: number;
    velocityRisk: number;
    graphRisk: number;
  };
  evaluatedAt: string;
}

const FRAUD_ENGINE_URL = process.env.FRAUD_ENGINE_URL || 'http://127.0.0.1:5005';

export class FraudClient {
  /**
   * Evaluates outgoing transaction risk before ledger broadcast.
   * If the standalone microservice is unreachable, falls back to built-in deterministic heuristic.
   */
  async evaluate(input: FraudEvaluationInput): Promise<FraudEvaluationResult> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 250);

      const response = await fetch(`${FRAUD_ENGINE_URL}/api/v1/fraud/evaluate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: input.userId,
          operationType: input.operationType,
          amount: input.amount,
          currency: input.currency,
          ip: {
            ipAddress: input.clientMetadata?.ipAddress,
            isTor: input.clientMetadata?.isTor,
            isVpnOrProxy: input.clientMetadata?.isVpnOrProxy,
          },
          device: {
            channel: input.clientMetadata?.channel || 'telegram',
            userAgent: input.clientMetadata?.userAgent,
            activeSessionsOnDevice: input.clientMetadata?.activeSessionsOnDevice,
          },
          velocity: {
            userId: input.userId,
            amount: input.amount,
            currency: input.currency,
            recentTxCount1h: input.clientMetadata?.recentTxCount1h,
            recentVolume24h: input.clientMetadata?.recentVolume24h,
          },
          graph: {
            destinationAddress: input.destination?.address,
            destinationAccountNumber: input.destination?.accountNumber,
            destinationBankCode: input.destination?.bankCode,
            chain: input.destination?.chain,
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) {
        const json = await response.json();
        return json.data as FraudEvaluationResult;
      }
    } catch {
      // Standalone service unreachable or timed out -> Fallback to built-in baseline heuristic
    }

    return this.fallbackEvaluate(input);
  }

  /**
   * Deterministic local fallback evaluation if Fraud Engine microservice is offline.
   */
  private fallbackEvaluate(input: FraudEvaluationInput): FraudEvaluationResult {
    let score = 0;
    const flags: string[] = [];

    // Sanctions address check
    const badAddresses = ['0x8576acc5c05d6ce88f4e49bf65bdf0c62f91353c'];
    if (input.destination?.address && badAddresses.includes(input.destination.address.toLowerCase())) {
      score = 100;
      flags.push('SANCTIONED_ADDRESS_DETECTED');
    } else if (input.amount >= 50) {
      score = 35;
      flags.push('HIGH_VALUE_THRESHOLD_STEP_UP');
    } else {
      score = 10;
      flags.push('STANDARD_LOW_RISK_BASELINE');
    }

    const verdict = score >= 70 ? 'block' : score >= 30 ? 'step_up' : 'allow';

    return {
      evaluationId: `frd_fallback_${Date.now()}`,
      riskScore: score,
      verdict,
      reasons: flags,
      factors: {
        ipRisk: 0,
        deviceRisk: 0,
        velocityRisk: input.amount >= 50 ? 35 : 0,
        graphRisk: score === 100 ? 100 : 0,
      },
      evaluatedAt: new Date().toISOString(),
    };
  }

  async sendFeedback(feedback: {
    transactionId?: string;
    outcome: string;
    confirmedBadActorId?: string;
    badActorAddress?: string;
    badActorBankNumber?: string;
    badActorBankCode?: string;
  }): Promise<boolean> {
    try {
      const res = await fetch(`${FRAUD_ENGINE_URL}/api/v1/fraud/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(feedback),
      });
      return res.ok;
    } catch {
      return false;
    }
  }
}

export const fraudClient = new FraudClient();
