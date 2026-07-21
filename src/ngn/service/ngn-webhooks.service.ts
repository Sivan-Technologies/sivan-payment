import { db } from '../../database/json-database.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';

export async function recordNgnWebhook(providerName: 'mock' | 'linkio' | 'eversend' | 'nomba', payload: unknown, headers: unknown) {
  const provider = getNgnProvider(providerName);
  const event = await provider.verifyWebhook(payload, headers);
  await db.upsertNgnWebhookRecord({ ...event, processedAt: new Date().toISOString() });
  return event;
}

export async function listNgnWebhooks() {
  return (await db.listNgnWebhooks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
