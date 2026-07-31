import { db } from '../../database/json-database.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import type { NgnProviderName } from '../types/ngn.types.js';

/**
 * Record an inbound provider webhook.
 *
 * Typed against NgnProviderName rather than a hand-written union: the union had
 * drifted and omitted 'breet', which meant the Breet adapter's verification -
 * secret comparison and fetch-by-id confirmation - was unreachable code. A new
 * provider must not be able to be registered without its webhooks working.
 */
export async function recordNgnWebhook(providerName: NgnProviderName, payload: unknown, headers: unknown) {
  const provider = getNgnProvider(providerName);
  const event = await provider.verifyWebhook(payload, headers);
  await db.upsertNgnWebhookRecord({ ...event, processedAt: new Date().toISOString() });
  return event;
}

export async function listNgnWebhooks() {
  return (await db.listNgnWebhooks()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
