import type { AceConfidence, AceEvidenceBundle, AceSupportAnswer } from '../types/ace.types.js';

export function composeAceSupportAnswer(bundle: AceEvidenceBundle, options: { admin?: boolean; sessionId: string }): AceSupportAnswer {
  /**
   * ANSWER THE QUESTION THAT WAS ASKED.
   *
   * Everything below used to run only one way: describe a transaction. With no
   * transaction it apologised, and with the WRONG transaction - which
   * 'general' guaranteed by attaching the newest record to any question - it
   * described that one confidently. A verification question could not be
   * answered at all, because there was no branch that could.
   */
  if (bundle.verification && bundle.intent === 'verification') {
    return verificationAnswer(bundle, options);
  }

  /**
   * A reference the user typed that we could not find.
   *
   * Named explicitly, because "I could not find ngnt_f17c5017" tells the user
   * their id is wrong or belongs to another account, while the old generic
   * apology left them re-pasting the same string.
   */
  if (bundle.unresolvedReference) {
    return {
      answer: [
        `I could not find any transaction matching ${bundle.unresolvedReference}.`,
        '',
        'That usually means one of three things:',
        '- the reference belongs to a different account',
        '- it was copied incompletely',
        '- the transaction has not been created yet',
        '',
        'Next step:',
        'Check the reference on your Transactions page, or create a support ticket and the team will trace it.'
      ].join('\n'),
      confidence: 'low',
      needsHuman: true,
      evidence: publicEvidence(bundle, options.admin),
      evidenceChecked: checked(bundle),
      suggestedActions: [{ label: 'Open support ticket', actionType: 'open_ticket', priority: 'high', reason: `Reference ${bundle.unresolvedReference} did not match any transaction.` }],
      sessionId: options.sessionId
    };
  }

  if (!bundle.transaction) {
    /**
     * NO TRANSACTION, AND NONE WAS ASKED FOR.
     *
     * The old copy said "I could not find a matching transaction yet" to
     * everyone - including a user who asked about 2FA and had never made one.
     * Apologising for failing at a task nobody set reads as broken. Each
     * intent gets the question it actually deserves.
     */
    const byIntent: Record<string, { answer: string[]; needsHuman: boolean }> = {
      account_recovery: {
        answer: [
          'Account access and 2FA recovery are handled by a human, always.',
          '',
          'Why:',
          'I am read-only. I cannot reset 2FA, change an email, or unlock an account - and neither can any automated flow, because that is exactly what an attacker would try.',
          '',
          'Next step:',
          'Create a support ticket from this chat. Sivan Support will verify your identity and take it from there.'
        ],
        needsHuman: true,
      },
      deposit: {
        answer: [
          'I could not find a deposit on your account yet.',
          '',
          'What usually explains it:',
          '- the transfer is still clearing at the sending bank',
          '- it was sent without the exact reference shown on your virtual account',
          '- it was sent from an account in a different name',
          '',
          'Next step:',
          'Share the bank reference or the sending account name, or create a ticket with proof of payment attached.'
        ],
        needsHuman: false,
      },
      transaction: {
        answer: [
          'I could not find any transactions on your account yet.',
          '',
          'Next step:',
          'If you were expecting one, share its Request ID and I will look it up. Otherwise the Transactions page will list everything as soon as it exists.'
        ],
        needsHuman: false,
      },
    };

    const chosen = byIntent[String(bundle.intent)] ?? {
      /**
       * The genuinely open question. This is the branch that used to be a
       * wrong answer: it now ASKS instead of guessing.
       */
      answer: [
        'I can help with payments, verification, deposits, transfers and account recovery.',
        '',
        'To answer precisely, tell me which one you mean - or paste a Request ID and I will look that transaction up directly.',
        '',
        'I will not guess: I would rather ask than describe the wrong transaction.'
      ],
      needsHuman: false,
    };

    return {
      answer: chosen.answer.join('\n'),
      confidence: 'low',
      needsHuman: chosen.needsHuman,
      evidence: publicEvidence(bundle, options.admin),
      evidenceChecked: checked(bundle),
      suggestedActions: chosen.needsHuman
        ? [{ label: 'Open support ticket', actionType: 'open_ticket', priority: 'high', reason: 'This request needs a human reviewer.' }]
        : [],
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
  /**
   * An NGN transfer is neither "a withdrawal" nor "a buy order".
   *
   * The ternary called everything that was not a withdrawal a buy order, so a
   * naira payout - once it became findable at all - would have been announced
   * as "Your buy order is currently settlement processing".
   */
  const typeLabel = tx.type === 'withdrawal'
    ? 'withdrawal'
    : tx.type === 'ngn_transfer'
      ? 'naira payout'
      : tx.type === 'virtual_account_transaction'
        ? 'deposit'
        : 'buy order';
  const statusLine = `Your ${typeLabel} is currently ${tx.status.replaceAll('_', ' ')}${tx.provider ? ` with ${tx.provider}` : ''}.`;

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

/**
 * The verification answer - built from the user's REAL state.
 *
 * getVerificationSummary() has always known the level, the path, every
 * individual check and the next step available. None of it reached the
 * assistant, so "I need help with verification" could only ever be answered
 * with a sentence about identity checks in general.
 *
 * Ordered as a person would ask it: where am I, what is done, what is left.
 */
function verificationAnswer(bundle: AceEvidenceBundle, options: { admin?: boolean; sessionId: string }): AceSupportAnswer {
  const v = bundle.verification!;
  const humanCheck = (status: string) => String(status ?? '').replaceAll('_', ' ');

  /**
   * FIELD NAMES ARE NOT USER-FACING COPY.
   *
   * Caught in the rendered screenshot, not in the assertions: the answer was
   * printing the raw object keys - "proofOfAddress (not started)", "nin",
   * "sourceOfFunds". Those are database columns. A customer reading
   * "⏳ proofOfAddress" has to decode camelCase to work out they need a
   * utility bill, and "nin"/"bvn" mean nothing to a non-Nigerian user.
   */
  const CHECK_LABELS: Record<string, string> = {
    identity: 'Photo ID and selfie',
    bank: 'Bank account',
    nin: 'NIN (National Identity Number)',
    bvn: 'BVN (Bank Verification Number)',
    proofOfAddress: 'Proof of address',
    sourceOfFunds: 'Source of funds',
  };
  const checkLabel = (name: string) => CHECK_LABELS[name] ?? name.replace(/([A-Z])/g, ' $1').toLowerCase();

  /** Only the checks that mean something on this user's path. */
  const notableChecks = Object.entries(v.checks ?? {})
    .filter(([, status]) => status && status !== 'not_required');

  const done = notableChecks.filter(([, s]) => /verified|approved|complete/i.test(String(s)));
  const outstanding = notableChecks.filter(([, s]) => !/verified|approved|complete/i.test(String(s)));

  const lines = [
    'Your verification:',
    `${v.levelLabel} — ${v.pathComplete ? 'complete' : 'not finished yet'}.`,
    '',
  ];

  if (done.length) {
    lines.push('Done:');
    lines.push(...done.map(([name, status]) => `✅ ${checkLabel(name)} (${humanCheck(String(status))})`));
    lines.push('');
  }

  /**
   * A COMPLETE USER HAS NOTHING OUTSTANDING - SAY SO.
   *
   * Caught by reading the rendered answer, not the code: a Level 2 user whose
   * path was complete was told "complete" and then handed a list of four
   * "Still outstanding" items (bank, bvn, proofOfAddress, sourceOfFunds).
   * Those checks are simply not part of their path - `not_started` here means
   * "never asked of you", not "you failed to do it".
   *
   * Printing both is a flat contradiction on the one screen where a user is
   * trying to find out whether they are done, and it would send a verified
   * customer to support for no reason. When the path is complete the
   * unstarted checks are reframed as what they are: optional, for higher
   * limits only.
   */
  if (outstanding.length && !v.pathComplete) {
    lines.push('Still outstanding:');
    lines.push(...outstanding.map(([name, status]) => `⏳ ${checkLabel(name)} (${humanCheck(String(status))})`));
    lines.push('');
  } else if (outstanding.length && v.pathComplete) {
    lines.push('Not required for your level:');
    lines.push(outstanding.map(([name]) => checkLabel(name)).join(', ') + ' — these only matter if you later need higher limits.');
    lines.push('');
  }

  if (v.termsRequired && !v.termsAccepted) {
    lines.push('Provider terms:');
    lines.push('You still need to accept the provider terms before verification counts as finished.');
    lines.push('');
  }

  if (v.hasPendingPayoutReview) {
    lines.push('Payout account:');
    lines.push('One of your payout accounts is with a reviewer right now. That is a manual check and it does not block your verification level.');
    lines.push('');
  }

  if (v.nextStep) {
    lines.push('Next step:');
    lines.push(v.nextStep.available
      ? `${v.nextStep.label}: ${v.nextStep.description}`
      : `${v.nextStep.label}: ${v.nextStep.description} (not available yet — nothing for you to do about this one.)`);
  } else if (v.pathComplete) {
    lines.push('Next step:');
    lines.push('Nothing. You are fully verified for your region.');
  }

  /**
   * A user who is complete does not need a human, and one who is stuck behind
   * a manual review does. Confidence is high either way: this is read straight
   * from the verification record, not inferred.
   */
  const needsHuman = !v.pathComplete && !v.nextStep?.available && !v.identityComplete;

  return {
    answer: lines.join('\n').trim(),
    confidence: 'high',
    needsHuman,
    currentStage: v.levelLabel,
    evidence: publicEvidence(bundle, options.admin),
    evidenceChecked: checked(bundle),
    suggestedActions: needsHuman
      ? [{ label: 'Open support ticket', actionType: 'open_ticket', priority: 'normal', reason: 'Verification is not progressing and has no self-serve next step.' }]
      : [],
    sessionId: options.sessionId
  };
}
