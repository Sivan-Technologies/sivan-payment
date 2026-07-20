import { db } from '../../database/json-database.js';
import { id, nowIso } from '../../shared/id.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { buildAceEvidence } from './ace-evidence.service.js';
import { inferAceResourceType } from './ace-intent.service.js';
import { composeAceSupportAnswer } from './ace-response.service.js';
import type { AceResourceType } from '../types/ace.types.js';

export async function answerAceSupport(input: { userId?: string; message: string; resourceType?: AceResourceType; resourceId?: string; channel?: 'web_dashboard' | 'admin_hub' | 'whatsapp' | 'api'; admin?: boolean }) {
  const resourceType = inferAceResourceType(input.message, input.resourceType);
  const sessionId = id('ace');
  const now = nowIso();
  const evidence = await buildAceEvidence({ userId: input.userId, message: input.message, resourceType, resourceId: input.resourceId, admin: input.admin });
  const answer = composeAceSupportAnswer(evidence, { admin: input.admin, sessionId });
  const toolsUsed = answer.evidenceChecked;

  await db.insertAceSupportRecords({
    session: {
      id: sessionId,
      userId: input.userId,
      channel: input.channel ?? (input.admin ? 'admin_hub' : 'web_dashboard'),
      resourceType,
      resourceId: input.resourceId ?? evidence.transaction?.id,
      confidence: answer.confidence,
      needsHuman: answer.needsHuman,
      toolsUsed,
      evidenceSnapshot: input.admin ? evidence : answer.evidence,
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
    metadata: { resourceType, resourceId: input.resourceId ?? evidence.transaction?.id, confidence: answer.confidence, needsHuman: answer.needsHuman, toolsUsed }
  });

  return answer;
}
