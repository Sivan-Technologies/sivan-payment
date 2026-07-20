import type { DatabaseShape, OnrampOrderRecord, WithdrawalRecord } from '../database/types.js';

export type PublicTimelineStepStatus = 'completed' | 'current' | 'pending' | 'failed';

export interface PublicTransactionTimelineStep {
  key: string;
  label: string;
  description: string;
  status: PublicTimelineStepStatus;
  at?: string;
}

export interface PublicTransactionTimeline {
  transactionType: 'withdrawal' | 'onramp_order' | 'virtual_account_transaction';
  requestId: string;
  internalTransactionId: string;
  providerReference?: string;
  amount?: string;
  currency?: string;
  asset?: string;
  direction: 'sell' | 'buy' | 'deposit';
  provider?: string;
  status: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  steps: PublicTransactionTimelineStep[];
}

type StepDraft = Omit<PublicTransactionTimelineStep, 'status'> & { done: boolean };

export function attachWithdrawalTimeline(withdrawal: WithdrawalRecord, data: DatabaseShape) {
  return {
    ...withdrawal,
    transactionTimeline: buildPublicWithdrawalTimeline(withdrawal, data)
  };
}

export function attachOnrampTimeline(order: OnrampOrderRecord, data: DatabaseShape) {
  return {
    ...order,
    transactionTimeline: buildPublicOnrampTimeline(order, data)
  };
}

export function buildPublicWithdrawalTimeline(withdrawal: WithdrawalRecord, data: DatabaseShape): PublicTransactionTimeline {
  const customer = data.customers.find((item) => item.id === withdrawal.customerId);
  const liquidationAddress = data.liquidationAddresses.find((item) => item.id === withdrawal.liquidationAddressId);
  const refs = (data.transactionReferences ?? []).filter((item) => item.resourceType === 'withdrawal' && item.resourceId === withdrawal.id);
  const providerReference = firstValue(
    withdrawal.providerDrainId,
    refValue(refs, 'bridge_drain_id'),
    withdrawal.destinationReference,
    refValue(refs, 'destination_reference'),
    liquidationAddress?.providerLiquidationAddressId
  );
  const blockchainAt = firstValue(
    withdrawal.depositTxHash ? withdrawal.updatedAt : undefined,
    webhookAt(data, withdrawal.providerDrainId, withdrawal.depositTxHash, liquidationAddress?.providerLiquidationAddressId)
  );
  const settlementAt = ['deposit_received', 'converting', 'payout_processing', 'completed'].includes(withdrawal.status) ? withdrawal.updatedAt : undefined;
  const bankAt = ['payout_processing', 'completed'].includes(withdrawal.status) ? withdrawal.updatedAt : undefined;
  const identityDone = customer?.kycStatus === 'kyc_approved';

  const steps = markTimeline([
    {
      key: 'withdrawal_created',
      label: 'Withdrawal Created',
      description: 'Your withdrawal request was created and assigned a Sivan transaction ID.',
      at: withdrawal.createdAt,
      done: true
    },
    {
      key: 'identity_verified',
      label: 'Identity Verified',
      description: 'Your Sivan identity and payout eligibility were confirmed for this transaction.',
      at: identityDone ? maxIso(customer?.updatedAt, withdrawal.createdAt) : undefined,
      done: identityDone
    },
    {
      key: 'provider_accepted',
      label: 'Provider Accepted',
      description: 'A provider-backed deposit address/reference was issued for this withdrawal.',
      at: liquidationAddress?.createdAt ?? withdrawal.createdAt,
      done: Boolean(liquidationAddress)
    },
    {
      key: 'blockchain_confirmed',
      label: 'Blockchain Confirmed',
      description: 'Your on-chain deposit has been detected or confirmed by the provider.',
      at: blockchainAt,
      done: Boolean(withdrawal.depositTxHash || ['deposit_received', 'converting', 'payout_processing', 'completed'].includes(withdrawal.status))
    },
    {
      key: 'settlement_initiated',
      label: 'Settlement Initiated',
      description: 'Settlement has started from crypto into the selected payout currency.',
      at: settlementAt,
      done: Boolean(settlementAt)
    },
    {
      key: 'bank_processing',
      label: 'Bank Processing',
      description: 'The bank payout is being processed by the provider or banking rail.',
      at: bankAt,
      done: Boolean(bankAt)
    },
    {
      key: 'completed',
      label: 'Completed',
      description: 'The payout is complete and the transaction is closed.',
      at: withdrawal.completedAt,
      done: withdrawal.status === 'completed'
    }
  ], withdrawal.status);

  return {
    transactionType: 'withdrawal',
    requestId: withdrawal.id,
    internalTransactionId: withdrawal.id,
    providerReference,
    amount: firstValue(withdrawal.destinationAmount, withdrawal.sourceAmount),
    currency: withdrawal.destinationCurrency?.toUpperCase(),
    asset: withdrawal.sourceCurrency?.toUpperCase(),
    direction: 'sell',
    provider: withdrawal.provider,
    status: withdrawal.status,
    createdAt: withdrawal.createdAt,
    updatedAt: withdrawal.updatedAt,
    completedAt: withdrawal.completedAt,
    steps
  };
}

export function buildPublicOnrampTimeline(order: OnrampOrderRecord, data: DatabaseShape): PublicTransactionTimeline {
  const customer = data.customers.find((item) => item.id === order.customerId);
  const refs = (data.transactionReferences ?? []).filter((item) => item.resourceType === 'onramp_order' && item.resourceId === order.id);
  const providerReference = firstValue(order.providerTransferId, refValue(refs, 'provider_transfer_id'), order.providerReference, refValue(refs, 'provider_reference'));
  const identityDone = customer?.kycStatus === 'kyc_approved';
  const instructionsIssued = Boolean(order.sourceDepositInstructions || order.providerReference || order.providerTransferId);
  const paymentReceived = ['payment_received', 'processing', 'completed'].includes(order.status);
  const settlementStarted = ['processing', 'completed'].includes(order.status);
  const blockchainDelivered = Boolean(order.destinationTxHash || order.status === 'completed');
  const webhookSeenAt = webhookAt(data, order.providerTransferId, order.providerReference, order.destinationTxHash, order.id);

  const steps = markTimeline([
    {
      key: 'order_created',
      label: 'Order Created',
      description: 'Your buy order was created and assigned a Sivan transaction ID.',
      at: order.createdAt,
      done: true
    },
    {
      key: 'identity_verified',
      label: 'Identity Verified',
      description: 'Your Sivan identity and order eligibility were confirmed.',
      at: identityDone ? maxIso(customer?.updatedAt, order.createdAt) : undefined,
      done: identityDone
    },
    {
      key: 'provider_accepted',
      label: 'Provider Accepted',
      description: 'The provider accepted the order and generated payment instructions.',
      at: instructionsIssued ? order.createdAt : undefined,
      done: instructionsIssued
    },
    {
      key: 'payment_instructions_issued',
      label: 'Payment Instructions Issued',
      description: 'Use the exact payment amount and reference shown for this order.',
      at: instructionsIssued ? order.createdAt : undefined,
      done: instructionsIssued
    },
    {
      key: 'fiat_payment_received',
      label: 'Fiat Payment Received',
      description: 'Your bank payment has been detected by the provider.',
      at: paymentReceived ? firstValue(webhookSeenAt, order.updatedAt) : undefined,
      done: paymentReceived
    },
    {
      key: 'settlement_processing',
      label: 'Settlement Processing',
      description: 'The provider is converting and preparing delivery to your wallet.',
      at: settlementStarted ? order.updatedAt : undefined,
      done: settlementStarted
    },
    {
      key: 'blockchain_delivered',
      label: 'Blockchain Delivered',
      description: 'Crypto delivery to your destination wallet has been submitted or confirmed.',
      at: blockchainDelivered ? (order.completedAt ?? order.updatedAt) : undefined,
      done: blockchainDelivered
    },
    {
      key: 'completed',
      label: 'Completed',
      description: 'The buy order is complete and the transaction is closed.',
      at: order.completedAt,
      done: order.status === 'completed'
    }
  ], order.status);

  return {
    transactionType: 'onramp_order',
    requestId: order.id,
    internalTransactionId: order.id,
    providerReference,
    amount: order.amount,
    currency: order.sourceCurrency?.toUpperCase(),
    asset: order.destinationCurrency?.toUpperCase(),
    direction: 'buy',
    provider: order.provider,
    status: order.status,
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    completedAt: order.completedAt,
    steps
  };
}

function markTimeline(drafts: StepDraft[], transactionStatus: string): PublicTransactionTimelineStep[] {
  const terminalFailed = ['failed', 'cancelled', 'requires_action'].includes(transactionStatus);
  let currentAssigned = false;
  const steps: PublicTransactionTimelineStep[] = drafts.map((draft) => {
    if (draft.done) return { ...withoutDone(draft), status: 'completed' as const };
    if (!terminalFailed && !currentAssigned) {
      currentAssigned = true;
      return { ...withoutDone(draft), status: 'current' as const };
    }
    return { ...withoutDone(draft), status: 'pending' as const };
  });

  if (terminalFailed) {
    steps.push({
      key: transactionStatus === 'requires_action' ? 'requires_action' : 'not_completed',
      label: transactionStatus === 'requires_action' ? 'Action Required' : transactionStatus === 'cancelled' ? 'Cancelled' : 'Failed',
      description: transactionStatus === 'requires_action'
        ? 'This transaction needs additional review or action. Contact support if you need help.'
        : transactionStatus === 'cancelled'
          ? 'This transaction was cancelled.'
          : 'This transaction could not be completed. Contact support with the request ID.',
      status: 'failed',
      at: drafts.find((item) => item.key === 'completed')?.at
    });
  }

  return steps;
}

function withoutDone(draft: StepDraft): Omit<StepDraft, 'done'> {
  const { done, ...rest } = draft;
  return rest;
}

function refValue(refs: Array<{ referenceType: string; referenceValue?: string }>, type: string) {
  return refs.find((item) => item.referenceType === type)?.referenceValue;
}

function webhookAt(data: DatabaseShape, ...values: Array<string | undefined>) {
  const wanted = values.filter(Boolean) as string[];
  if (!wanted.length) return undefined;
  const events = (data.webhookEvents ?? [])
    .filter((event) => {
      const text = JSON.stringify(event.payload ?? {});
      return wanted.some((value) => event.eventObjectId === value || event.providerEventId === value || text.includes(value));
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return events[0]?.createdAt;
}

function firstValue(...values: Array<string | undefined | null>) {
  return values.map((value) => String(value ?? '').trim()).find(Boolean);
}

function maxIso(a?: string, b?: string) {
  if (!a) return b;
  if (!b) return a;
  return new Date(a).getTime() > new Date(b).getTime() ? a : b;
}
