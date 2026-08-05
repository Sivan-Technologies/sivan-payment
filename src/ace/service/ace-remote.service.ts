import { env } from '../../config/env.js';
import type { AceEvidenceBundle, AceSupportAnswer, AceSupportChannel } from '../types/ace.types.js';

type RemoteAceResponse = {
  answer: string;
  confidence: 'high' | 'medium' | 'low';
  needsHuman: boolean;
  currentStage?: string;
  estimatedCompletion?: string;
  evidenceUsed?: string[];
  suggestedActions?: Array<{ label: string; actionType: string; priority: 'low' | 'normal' | 'high' | 'urgent'; reason: string }>;
  safetyNotes?: string[];
  aiTrace?: unknown;
};

/**
 * Wake Sivan AI without asking it anything.
 *
 * Sivan AI is a free Render instance that sleeps after 15 minutes idle; a cold
 * start measured 23s against the deployed service. That is longer than any
 * timeout we can afford on the answer path, because the Cloudflare worker in
 * front of the API aborts at 12s.
 *
 * So the wake-up is moved OFF the answer path: the frontend calls this when the
 * Ask Sivan drawer opens, which is typically several seconds before the user has
 * finished typing, and by the time the question arrives the instance is warm.
 *
 * Deliberately cheap and deliberately quiet. It hits /health rather than the
 * answer endpoint so warming costs no model tokens, and it resolves a status
 * rather than throwing: a failed warmup is not a failed support session, it just
 * means the first answer may fall back to the local one.
 */
export async function warmRemoteAce(): Promise<{ warm: boolean; ms: number; reason?: string }> {
  const startedAt = Date.now();
  if (env.ACE_PROVIDER !== 'remote' || !env.SIVAN_AI_API_URL) {
    return { warm: false, ms: 0, reason: 'Sivan AI is not configured as the remote ACE provider.' };
  }
  const controller = new AbortController();
  // Generous relative to the answer timeout, because this call is not blocking a
  // user-visible response - it runs while they type.
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(`${env.SIVAN_AI_API_URL.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
      headers: env.SIVAN_AI_API_KEY ? { 'x-sivan-ai-key': env.SIVAN_AI_API_KEY } : {}
    });
    return { warm: response.ok, ms: Date.now() - startedAt, reason: response.ok ? undefined : `Sivan AI health returned ${response.status}` };
  } catch (error) {
    const reason = error instanceof Error && error.name === 'AbortError'
      ? 'Sivan AI did not wake within 30s.'
      : error instanceof Error ? error.message : String(error);
    return { warm: false, ms: Date.now() - startedAt, reason };
  } finally {
    clearTimeout(timeout);
  }
}

export async function requestRemoteAceSupport(input: {
  message: string;
  channel: AceSupportChannel;
  admin?: boolean;
  bundle: AceEvidenceBundle;
  localAnswer: AceSupportAnswer;
}): Promise<AceSupportAnswer & { remoteTrace?: unknown }> {
  if (!env.SIVAN_AI_API_URL) throw new Error('SIVAN_AI_API_URL is not configured');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.SIVAN_AI_TIMEOUT_MS);
  try {
    const response = await fetch(`${env.SIVAN_AI_API_URL.replace(/\/$/, '')}/api/ace/support/answer`, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(env.SIVAN_AI_API_KEY ? { 'x-sivan-ai-key': env.SIVAN_AI_API_KEY } : {})
      },
      body: JSON.stringify({
        tenant: 'sivan_payment',
        product: 'payment',
        useCase: 'support_answer',
        channel: input.channel === 'admin_hub' ? 'admin_hub' : input.channel === 'whatsapp' ? 'whatsapp' : 'web_dashboard',
        question: input.message,
        objective: buildObjective(input),
        evidence: input.bundle.evidenceItems
          .filter((item) => input.admin || item.customerSafe)
          .map((item) => ({ source: item.source, label: item.label, value: item.value ?? null, metadata: input.admin ? item.metadata : undefined })),
        policy: { customerVisible: !input.admin, allowInternalDetails: Boolean(input.admin), allowActions: false },
        constraints: [
          'Use supplied evidence only.',
          'Do not promise exact payout time.',
          'Do not expose raw webhooks, internal notes, secrets, or private provider diagnostics to customers.',
          'Do not trigger payouts, refunds, retries, or status overrides.'
        ],
        correlationId: input.localAnswer.sessionId,
        requestedBy: input.admin ? 'admin_hub' : 'customer_web'
      })
    });
    const payload = await response.json().catch(() => ({})) as { data?: RemoteAceResponse; error?: string; message?: string };
    if (!response.ok || !payload.data) throw new Error(payload.error || payload.message || `Sivan AI returned ${response.status}`);
    return mergeRemoteAnswer(input.localAnswer, payload.data);
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`Sivan AI timed out after ${env.SIVAN_AI_TIMEOUT_MS}ms`);
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function buildObjective(input: { bundle: AceEvidenceBundle }) {
  const tx = input.bundle.transaction;
  if (!tx) return 'Answer a Sivan Payment support question from evidence';
  return `Answer a Sivan Payment support question about ${tx.type} ${tx.id}`;
}

function mergeRemoteAnswer(localAnswer: AceSupportAnswer, remote: RemoteAceResponse): AceSupportAnswer & { remoteTrace?: unknown } {
  return {
    ...localAnswer,
    answer: remote.answer || localAnswer.answer,
    confidence: remote.confidence || localAnswer.confidence,
    needsHuman: typeof remote.needsHuman === 'boolean' ? remote.needsHuman : localAnswer.needsHuman,
    currentStage: remote.currentStage || localAnswer.currentStage,
    estimatedCompletion: remote.estimatedCompletion || localAnswer.estimatedCompletion,
    suggestedActions: (remote.suggestedActions ?? []).map((action) => ({
      label: action.label,
      actionType: action.actionType === 'open_ticket' ? 'open_ticket' : action.actionType === 'review' ? 'human_review' : 'none',
      priority: action.priority,
      reason: action.reason
    })) as AceSupportAnswer['suggestedActions'],
    evidenceChecked: Array.from(new Set([...localAnswer.evidenceChecked, ...(remote.evidenceUsed ?? []).map((item) => item.replace(/^knowledge\./, 'Knowledge: '))])),
    remoteTrace: remote.aiTrace
  };
}
