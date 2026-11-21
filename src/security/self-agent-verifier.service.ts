import { FastifyRequest } from 'fastify';
import {
  SelfAgentVerifier,
  verifyAgent,
  DEFAULT_REGISTRY_ADDRESS,
  HEADERS,
  VerifyResult,
} from '@selfxyz/agent-sdk';

export interface SelfAgentVerificationOutcome {
  isVerified: boolean;
  tier: 'VERIFIED_HUMAN_AGENT' | 'UNVERIFIED_AGENT';
  agentId?: number | string;
  agentKey?: string;
  agentAddress?: string;
  nullifier?: string;
  proofExpiresAt?: string;
  daysUntilExpiry?: number;
  maxTransactionLimitUsd: number;
  allowedActions: string[];
  reason?: string;
  reauthUrl?: string;
  registryUrl?: string;
}

export const UNVERIFIED_TRANSACTION_LIMIT_USD = 50;
export const VERIFIED_TRANSACTION_LIMIT_USD = 5000;
export const CANONICAL_SELF_REGISTRY_CELO = process.env.SELF_REGISTRY_ADDRESS || DEFAULT_REGISTRY_ADDRESS || '0xaC3DF9ABf80d0F5c020C06B04Cced27763355944';

let dynamicUnverifiedLimit = UNVERIFIED_TRANSACTION_LIMIT_USD;
let dynamicVerifiedLimit = VERIFIED_TRANSACTION_LIMIT_USD;

export function getUnverifiedLimit(): number {
  return dynamicUnverifiedLimit;
}

export function getVerifiedLimit(): number {
  return dynamicVerifiedLimit;
}

export function setAgentLimits(unverified?: number, verified?: number) {
  if (unverified && unverified > 0) dynamicUnverifiedLimit = unverified;
  if (verified && verified > 0) dynamicVerifiedLimit = verified;
}

// Initialize singleton verifier with Celo Mainnet settings
let verifierInstance: SelfAgentVerifier | null = null;

function getVerifier(): SelfAgentVerifier {
  if (!verifierInstance) {
    verifierInstance = new SelfAgentVerifier({
      network: 'mainnet',
      registryAddress: CANONICAL_SELF_REGISTRY_CELO,
      rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org',
      maxAgentsPerHuman: 1, // Enforce 1 agent per human nullifier (sybil-resistant)
      enableReplayProtection: true,
      requireSelfProvider: true,
    });
  }
  return verifierInstance;
}

/**
 * Normalizes an Ethereum/Celo address (20 bytes) or raw 32-byte key to a valid bytes32 hex string.
 */
export function formatAgentKey(addressOrKey: string): string {
  const cleaned = addressOrKey.replace(/^0x/i, '').toLowerCase();
  if (cleaned.length === 64) {
    return `0x${cleaned}`;
  }
  if (cleaned.length === 40) {
    return `0x${cleaned.padStart(64, '0')}`;
  }
  throw new Error(`Invalid agent key format. Expected 20 or 32 bytes hex, received ${addressOrKey}`);
}

/**
 * Direct on-chain verification check using SelfAgentVerifier / verifyAgent
 */
export async function checkAgentHumanProof(agentKeyOrAddress: string): Promise<VerifyResult> {
  const agentKey = formatAgentKey(agentKeyOrAddress);
  return await verifyAgent(
    agentKey,
    {
      network: 'mainnet',
      registryAddress: CANONICAL_SELF_REGISTRY_CELO,
    },
    process.env.CELO_RPC_URL || 'https://forno.celo.org'
  );
}

/**
 * Verifies inbound Fastify request for Self Agent ID (Proof of Human).
 * Inspects standard Self headers (x-self-agent-signature, x-self-agent-key, etc.)
 * or body parameters (selfProof, agentKey, agentAddress).
 */
export async function verifyFastifyAgentRequest(
  request: FastifyRequest
): Promise<SelfAgentVerificationOutcome> {
  const headers = request.headers as Record<string, string | undefined>;
  const sigHeader = headers[HEADERS.SIGNATURE] || headers['x-self-agent-signature'];
  const keyHeader = headers[HEADERS.KEY] || headers['x-self-agent-key'] || headers['x-self-agent-address'];
  const tsHeader = headers[HEADERS.TIMESTAMP] || headers['x-self-agent-timestamp'];
  const keyTypeHeader = headers[HEADERS.KEYTYPE] || headers['x-self-agent-keytype'] || 'secp256k1';

  const body = (request.body as any) || {};
  const bodyAgentKey = body.agentKey || body.agentAddress || body.selfAgentKey;
  const targetKey = keyHeader || bodyAgentKey;

  // Non-production test bypass for isolated automated CI suites
  if (
    process.env.APP_ENV !== 'production' &&
    (headers['x-sivan-test-verified-agent'] === 'true' || body.testVerifiedAgent === true)
  ) {
    return {
      isVerified: true,
      tier: 'VERIFIED_HUMAN_AGENT',
      agentId: 10089,
      agentKey: formatAgentKey(targetKey || '0x46eFfe0409BFE99b0435e7bb7219DC6586612345'),
      agentAddress: '0x46eFfe0409BFE99b0435e7bb7219DC6586612345',
      nullifier: '0x777788889999aaaabbbbccccddddeeeeffff',
      proofExpiresAt: new Date(Date.now() + 86400000 * 30).toISOString(),
      daysUntilExpiry: 30,
      maxTransactionLimitUsd: VERIFIED_TRANSACTION_LIMIT_USD,
      allowedActions: ['TRANSFER', 'SERVICE_AGREEMENT', 'FIAT_OFFRAMP', 'ZERO_GAS_SETTLEMENT'],
      registryUrl: 'https://8004scan.io/agents/celo/10089',
    };
  }

  // 1. Signature-based verification (Agent signing cryptographic challenge)
  if (sigHeader && tsHeader && targetKey) {
    try {
      const verifier = getVerifier();
      const rawBody = typeof request.body === 'string' ? request.body : JSON.stringify(request.body || {});
      const result = await verifier.verify({
        signature: sigHeader,
        timestamp: tsHeader,
        method: request.method,
        url: request.url,
        body: rawBody,
        keytype: keyTypeHeader,
        agentKey: formatAgentKey(targetKey),
      });

      if (result.valid) {
        return {
          isVerified: true,
          tier: 'VERIFIED_HUMAN_AGENT',
          agentId: result.agentId ? Number(result.agentId) : undefined,
          agentKey: result.agentKey,
          agentAddress: result.agentAddress,
          nullifier: result.nullifier ? result.nullifier.toString() : undefined,
          proofExpiresAt: result.proofExpiresAt?.toISOString(),
          daysUntilExpiry: result.daysUntilExpiry,
          maxTransactionLimitUsd: VERIFIED_TRANSACTION_LIMIT_USD,
          allowedActions: ['TRANSFER', 'SERVICE_AGREEMENT', 'FIAT_OFFRAMP', 'ZERO_GAS_SETTLEMENT'],
          registryUrl: result.agentId ? `https://8004scan.io/agents/celo/${result.agentId}` : undefined,
        };
      } else {
        return {
          isVerified: false,
          tier: 'UNVERIFIED_AGENT',
          maxTransactionLimitUsd: UNVERIFIED_TRANSACTION_LIMIT_USD,
          allowedActions: ['READ_ONLY_DISCOVERY', 'INDICATIVE_QUOTE', 'MICRO_TRANSFER_50_MAX'],
          reason: result.error || 'Agent signature or on-chain human proof failed verification',
          reauthUrl: result.agentId
            ? `https://api.sivantech.online/api/v1/agent/refresh?agentId=${result.agentId}`
            : 'https://8004scan.io/agents/celo/10089',
          registryUrl: 'https://8004scan.io/agents/celo/10089',
        };
      }
    } catch (sigErr: any) {
      // Signature error
    }
  }

  // 2. Direct On-Chain Registry Read Check (if agent key or address is supplied)
  if (targetKey) {
    try {
      const onChainCheck = await checkAgentHumanProof(targetKey);
      if (onChainCheck.verified) {
        return {
          isVerified: true,
          tier: 'VERIFIED_HUMAN_AGENT',
          agentId: onChainCheck.agentId ? Number(onChainCheck.agentId) : undefined,
          agentKey: formatAgentKey(targetKey),
          agentAddress: targetKey,
          proofExpiresAt: onChainCheck.expiresAt ? onChainCheck.expiresAt.toISOString() : undefined,
          maxTransactionLimitUsd: VERIFIED_TRANSACTION_LIMIT_USD,
          allowedActions: ['TRANSFER', 'SERVICE_AGREEMENT', 'FIAT_OFFRAMP', 'ZERO_GAS_SETTLEMENT'],
          registryUrl: onChainCheck.agentId ? `https://8004scan.io/agents/celo/${onChainCheck.agentId}` : undefined,
        };
      } else {
        return {
          isVerified: false,
          tier: 'UNVERIFIED_AGENT',
          maxTransactionLimitUsd: UNVERIFIED_TRANSACTION_LIMIT_USD,
          allowedActions: ['READ_ONLY_DISCOVERY', 'INDICATIVE_QUOTE', 'MICRO_TRANSFER_50_MAX'],
          reason: onChainCheck.reason || 'Agent key lacks valid Proof of Human on Self Protocol Celo Registry',
          reauthUrl: (onChainCheck as any).reauthUrl || 'https://8004scan.io/agents/celo/10089',
          registryUrl: 'https://8004scan.io/agents/celo/10089',
        };
      }
    } catch (rpcErr: any) {
      // Graceful fallback on network unreachable
    }
  }

  // 3. Unverified Agent Default Outcome
  return {
    isVerified: false,
    tier: 'UNVERIFIED_AGENT',
    maxTransactionLimitUsd: UNVERIFIED_TRANSACTION_LIMIT_USD,
    allowedActions: ['READ_ONLY_DISCOVERY', 'INDICATIVE_QUOTE', 'MICRO_TRANSFER_50_MAX'],
    reason: 'No Self Agent ID credentials provided. Agent is unverified.',
    reauthUrl: 'https://8004scan.io/agents/celo/10089',
    registryUrl: 'https://8004scan.io/agents/celo/10089',
  };
}

/**
 * Guard utility to enforce tier limits before executing high-value or restricted operations.
 */
export function assertSelfAgentLimit(
  verification: SelfAgentVerificationOutcome,
  amountUsd: number,
  operationName: string
): { allowed: boolean; errorResponse?: Record<string, any> } {
  const verifiedLimit = getVerifiedLimit();
  const unverifiedLimit = getUnverifiedLimit();

  if (verification.isVerified) {
    if (amountUsd > verifiedLimit) {
      return {
        allowed: false,
        errorResponse: {
          success: false,
          code: 'VERIFIED_AGENT_LIMIT_EXCEEDED',
          error: `Amount ($${amountUsd} USD) exceeds verified agent maximum tier limit ($${verifiedLimit} USD).`,
          tier: verification.tier,
          maxAllowedUsd: verifiedLimit,
        },
      };
    }
    return { allowed: true };
  }

  // Unverified Agent check
  if (amountUsd > unverifiedLimit) {
    return {
      allowed: false,
      errorResponse: {
        success: false,
        code: 'SELF_AGENT_ID_REQUIRED',
        error: `Action '${operationName}' of $${amountUsd} USD exceeds unverified agent limit ($${unverifiedLimit} USD).`,
        message: 'Only verified human-backed agents with Self Agent ID may initiate high-value transfers, Service Agreements, or fiat off-ramps.',
        tier: verification.tier,
        unverifiedLimitUsd: unverifiedLimit,
        verifiedLimitUsd: verifiedLimit,
        reauthUrl: verification.reauthUrl,
        registryUrl: verification.registryUrl,
      },
    };
  }

  return { allowed: true };
}
