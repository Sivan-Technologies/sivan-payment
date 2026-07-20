import type { AceConfidence, AceEvidenceBundle, AceSupportAnswer } from '../types/ace.types.js';

export function composeAceSupportAnswer(bundle: AceEvidenceBundle, options: { admin?: boolean; sessionId: string }): AceSupportAnswer {
  if (!bundle.transaction) {
    return {
      answer: [
        'I could not find a matching transaction yet.',
        '',
        'Next step:',
        'Please share the Request ID from your transaction page, or open a support ticket so the team can trace it.'
      ].join('\n'),
      confidence: 'low',
      needsHuman: true,
      evidence: publicEvidence(bundle, options.admin),
      evidenceChecked: checked(bundle),
      suggestedActions: [{ label: 'Open support ticket', actionType: 'open_ticket', priority: 'high', reason: 'Ace could not identify the transaction from the request.' }],
      sessionId: options.sessionId
    };
  }

  const current = bundle.timeline.find((step) => step.status === 'current') ?? [...bundle.timeline].reverse().find((step) => step.status === 'completed');
  const completed = bundle.timeline.filter((step) => step.status === 'completed').slice(-2);
  const incident = bundle.incidents[0];
  const confidence = calculateConfidence(bundle);
  const needsHuman = shouldNeedHuman(bundle, confidence);
  const estimatedCompletion = estimateCompletion(bundle, incident);
  const tx = bundle.transaction;
  const statusLine = `Your ${tx.type === 'withdrawal' ? 'withdrawal' : 'buy order'} is currently ${tx.status.replaceAll('_', ' ')}${tx.provider ? ` with ${tx.provider}` : ''}.`;

  const answer = incident
    ? [
        `There is currently a ${incident.provider} incident affecting ${incident.affectedService?.replaceAll?.('_', ' ') ?? 'payments'}.`,
        '',
        'Incident:',
        incident.message,
        '',
        'ETA:',
        incident.eta || 'Provider has not published an ETA yet.',
        '',
        'Your transaction is safe. We are waiting for the provider to complete the affected step.',
        '',
        'Reference:',
        `Request ID: ${tx.id}`
      ].join('\n')
    : [
        'Current status:',
        statusLine,
        '',
        'Current stage:',
        ...completed.map((step) => `✅ ${step.label}`),
        current && current.status !== 'completed' ? `⏳ ${current.label}` : current ? `✅ ${current.label}` : '⏳ Processing',
        '',
        'What this means:',
        tx.explanation || 'Your transaction is moving through provider processing.',
        '',
        'Estimated completion:',
        estimatedCompletion,
        '',
        'Do you need to do anything?',
        needsHuman ? 'I recommend contacting support so a human can review the evidence.' : 'No action is needed right now.',
        '',
        'Reference:',
        `Request ID: ${tx.id}`
      ].filter(Boolean).join('\n');

  return {
    answer,
    confidence,
    needsHuman,
    currentStage: current?.key ?? current?.label,
    estimatedCompletion,
    evidence: publicEvidence(bundle, options.admin),
    evidenceChecked: checked(bundle),
    suggestedActions: needsHuman ? [{ label: 'Escalate to human support', actionType: 'human_review', priority: 'high', reason: humanReason(bundle) }] : [],
    sessionId: options.sessionId
  };
}

function calculateConfidence(bundle: AceEvidenceBundle): AceConfidence {
  if (!bundle.transaction) return 'low';
  if (bundle.timeline.length >= 4 && bundle.evidenceItems.length >= 6) return 'high';
  return 'medium';
}

function shouldNeedHuman(bundle: AceEvidenceBundle, confidence: AceConfidence) {
  if (confidence === 'low') return true;
  if (bundle.transaction && ['failed', 'requires_action'].includes(bundle.transaction.status)) return true;
  if (bundle.reconciliationFindings.some((finding) => finding.status === 'open')) return true;
  if (bundle.queue.some((item) => ['open_findings', 'watch', 'not_found'].includes(item.status))) return true;
  return false;
}

function estimateCompletion(bundle: AceEvidenceBundle, incident?: any) {
  if (incident?.eta) return incident.eta;
  const status = bundle.transaction?.status;
  if (status === 'completed') return 'Completed';
  if (status === 'pending_deposit' || status === 'awaiting_payment') return 'After your payment/deposit is confirmed';
  if (['deposit_received', 'converting', 'payout_processing', 'payment_received', 'processing'].includes(String(status))) return 'Usually 2–5 minutes after provider confirmation';
  if (status === 'requires_action') return 'Requires support review';
  return 'Timing depends on provider confirmation';
}

function checked(bundle: AceEvidenceBundle) {
  return [
    bundle.user ? 'User' : undefined,
    bundle.transaction ? 'Transaction' : undefined,
    bundle.timeline.length ? 'Timeline' : undefined,
    bundle.trace.length ? 'Transaction trace' : undefined,
    'Incidents',
    'Webhook events',
    'Queue status',
    'Provider health',
    'Reconciliation findings',
    'Support ticket history'
  ].filter(Boolean) as string[];
}

function publicEvidence(bundle: AceEvidenceBundle, admin?: boolean) {
  return {
    requestId: bundle.transaction?.id,
    provider: bundle.transaction?.provider,
    providerReference: bundle.transaction?.providerReference,
    status: bundle.transaction?.status,
    timelineStage: bundle.timeline.find((step) => step.status === 'current')?.label,
    incident: bundle.incidents[0] ? { provider: bundle.incidents[0].provider, message: bundle.incidents[0].message, eta: bundle.incidents[0].eta, severity: bundle.incidents[0].severity } : null,
    lastWebhook: bundle.webhooks[0]?.eventType ?? bundle.webhooks[0]?.eventCategory ?? null,
    queueStatus: bundle.queue.map((item) => `${item.name}:${item.status}`).join(', ') || 'normal',
    providerHealth: bundle.providerHealth,
    ...(admin ? { trace: bundle.trace, reconciliationFindings: bundle.reconciliationFindings, supportTickets: bundle.supportTickets } : {})
  };
}

function humanReason(bundle: AceEvidenceBundle) {
  if (!bundle.transaction) return 'No transaction was found.';
  if (['failed', 'requires_action'].includes(bundle.transaction.status)) return 'Transaction status requires human support review.';
  if (bundle.reconciliationFindings.some((finding) => finding.status === 'open')) return 'Open reconciliation findings exist for this transaction.';
  if (bundle.queue.some((item) => item.status === 'watch')) return 'Transaction has been in the same processing state longer than expected.';
  return 'Ace needs human validation.';
}
