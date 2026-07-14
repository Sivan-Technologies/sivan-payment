import { db } from '../database/json-database.js';
import { id, nowIso } from './id.js';

export interface UnifiedWebhookLogInput {
  serviceName: string;
  provider: string;
  providerEventId?: string;
  paymentReference?: string;
  eventCategory?: string;
  eventType?: string;
  payload: unknown;
}

export async function recordUnifiedWebhookLog(input: UnifiedWebhookLogInput) {
  const now = nowIso();
  return db.mutate((data) => {
    const record = {
      id: id('uwl'),
      serviceName: input.serviceName,
      provider: input.provider,
      providerEventId: input.providerEventId,
      paymentReference: input.paymentReference,
      eventCategory: input.eventCategory,
      eventType: input.eventType,
      payload: input.payload,
      createdAt: now
    };
    if (!data.unifiedWebhookLogs) {
      data.unifiedWebhookLogs = [];
    }
    data.unifiedWebhookLogs.push(record);
    return record;
  });
}
