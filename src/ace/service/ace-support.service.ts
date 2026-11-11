import { db } from '../../database/json-database.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { buildAceEvidence } from './ace-evidence.service.js';
import { classifyAceMessage } from './ace-intent.service.js';
import { composeAceSupportAnswer } from './ace-response.service.js';
import { requestRemoteAceSupport } from './ace-remote.service.js';
import { querySivanKnowledgeBase } from './ace-knowledge.service.js';
import { env } from '../../config/env.js';
import type { AceResourceType, AceSupportChannel } from '../types/ace.types.js';

export async function answerAceSupport(input: { userId?: string; message: string; resourceType?: AceResourceType; resourceId?: string; channel?: AceSupportChannel; admin?: boolean }) {
  /**
   * ONE classification, used for the lookup AND for the answer.
   *
   * Previously the resource type was inferred and the intent was never
   * computed at all, so nothing downstream could tell "asking about
   * verification" from "asking about a transaction". A reference pasted in the
   * message is picked up here too, which is why `resourceId` prefers the
   * detected one.
   */
  const classified = classifyAceMessage(input.message, input.resourceType, input.resourceId);
  const resourceType = classified.resourceType;
  const resourceId = classified.resourceId ?? input.resourceId;
  const sessionId = id('ace');
  const now = nowIso();
  const evidence = await buildAceEvidence({ userId: input.userId, message: input.message, resourceType, resourceId, intent: classified.intent, admin: input.admin });
  let localAnswer = composeAceSupportAnswer(evidence, { admin: input.admin, sessionId });

  /**
   * When the user asks a general protocol/product question (e.g. "How do Service Agreements work?",
   * "Which networks are supported?", "How fast are bank withdrawals?") and there is no specific
   * transaction or unresolved reference attached, consult the Sivan Ai Knowledge Base so the user
   * receives an accurate knowledge-backed answer instead of a generic fallback.
   */
  if (!evidence.transaction && !evidence.unresolvedReference && classified.intent !== 'verification') {
    try {
      const kbResult = await querySivanKnowledgeBase({
        question: input.message,
        context: input.channel ?? 'web_dashboard',
      });
      if (kbResult && kbResult.articleId && (kbResult.confidence === 'high' || classified.intent === 'unknown')) {
        localAnswer = {
          ...localAnswer,
          answer: kbResult.answer,
          confidence: kbResult.confidence,
          needsHuman: kbResult.needsHuman,
          evidenceChecked: Array.from(new Set([...localAnswer.evidenceChecked, ...kbResult.evidenceChecked])),
          suggestedActions: kbResult.suggestedActions.length > 0 ? kbResult.suggestedActions : localAnswer.suggestedActions,
        };
      }
    } catch {
      // Keep localAnswer if knowledge lookup fails
    }
  }

  const { answer, providerMode, fallbackReason } = await resolveAceAnswer({ input, evidence, localAnswer });
  const toolsUsed = answer.evidenceChecked;

  await db.insertAceSupportRecords({
    session: {
      id: sessionId,
      userId: input.userId,
      channel: input.channel ?? (input.admin ? 'admin_hub' : 'web_dashboard'),
      resourceType,
      resourceId: resourceId ?? evidence.transaction?.id,
      confidence: answer.confidence,
      needsHuman: answer.needsHuman,
      toolsUsed,
      evidenceSnapshot: input.admin ? { evidence, aceProvider: providerMode, fallbackReason, remoteTrace: (answer as any).remoteTrace } : { ...answer.evidence, aceProvider: providerMode, fallbackReason },
      createdAt: now
    },
    messages: [
      { id: id('acemsg'), sessionId, role: input.admin ? 'admin' : 'user', message: input.message, createdAt: now },
      { id: id('acemsg'), sessionId, role: 'ace', message: answer.answer, createdAt: now }
    ],
    toolCalls: toolsUsed.map((tool) => ({ id: id('acetool'), sessionId, toolName: tool, status: 'success' as const, summary: `${tool} checked`, createdAt: now })),
    resolution: { id: id('aceres'), sessionId, resolutionType: answer.needsHuman ? 'escalated' : 'answered', summary: answer.needsHuman ? 'Ace recommended human review.' : 'Ace answered from read-only evidence.', createdAt: now }
  });

  await createAuditLog({
    actorType: input.admin ? 'admin' : 'user',
    actorId: input.admin ? 'admin_api_key' : input.userId,
    action: 'ace.support_answered',
    resourceType: 'ace_support_session',
    resourceId: sessionId,
    severity: answer.needsHuman ? 'warning' : 'info',
    metadata: { resourceType, intent: classified.intent, referenceDetected: classified.referenceDetected, resourceId: resourceId ?? evidence.transaction?.id, confidence: answer.confidence, needsHuman: answer.needsHuman, toolsUsed, aceProvider: providerMode, fallbackReason }
  });

  return answer;
}

async function resolveAceAnswer({ input, evidence, localAnswer }: { input: { userId?: string; message: string; resourceType?: AceResourceType; resourceId?: string; channel?: AceSupportChannel; admin?: boolean }; evidence: Awaited<ReturnType<typeof buildAceEvidence>>; localAnswer: ReturnType<typeof composeAceSupportAnswer> }) {
  if (env.ACE_PROVIDER !== 'remote') return { answer: localAnswer, providerMode: 'local' as const, fallbackReason: undefined };
  try {
    const remote = await requestRemoteAceSupport({
      message: input.message,
      channel: input.channel ?? (input.admin ? 'admin_hub' : 'web_dashboard'),
      admin: input.admin,
      bundle: evidence,
      localAnswer
    });
    return { answer: remote, providerMode: 'remote' as const, fallbackReason: undefined };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    if (!env.SIVAN_AI_FALLBACK_ENABLED) throw error;
    return { answer: localAnswer, providerMode: 'local_fallback' as const, fallbackReason: reason };
  }
}
