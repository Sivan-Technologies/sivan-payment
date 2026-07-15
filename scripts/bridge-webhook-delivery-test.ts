import crypto from 'node:crypto';
import { BridgeClient } from '../src/providers/bridge/bridge.client.js';
import { env } from '../src/config/env.js';

const webhookId = process.env.BRIDGE_WEBHOOK_ID || process.env.BRIDGE_TEST_WEBHOOK_ID || process.env.BRIDGE_LIVE_WEBHOOK_ID;
const explicitEventId = process.env.BRIDGE_WEBHOOK_EVENT_ID;
const category = process.env.BRIDGE_WEBHOOK_CATEGORY || 'customer';
const apiBaseUrl = process.env.SIVAN_API_BASE_URL || process.env.API_BASE_URL || env.APP_URL;
const adminApiKey = process.env.ADMIN_API_KEY || env.ADMIN_API_KEY;
const pollSeconds = Number(process.env.BRIDGE_WEBHOOK_POLL_SECONDS || 60);

if (!webhookId) {
  throw new Error('BRIDGE_WEBHOOK_ID is required. Get it from the Bridge dashboard or webhook API.');
}
if (!env.BRIDGE_API_KEY) {
  throw new Error('BRIDGE_API_KEY is required.');
}

const client = new BridgeClient();

const eventId = explicitEventId ?? await pickRecentEventId(category);
if (!eventId) {
  throw new Error(`No Bridge webhook event found for category=${category}. Set BRIDGE_WEBHOOK_EVENT_ID to test a specific event.`);
}

console.log(JSON.stringify({
  step: 'bridge_webhook_send_start',
  bridgeBaseUrl: env.BRIDGE_BASE_URL,
  webhookId,
  eventId,
  category,
  apiBaseUrl: redactUrl(apiBaseUrl),
  willPollBackend: Boolean(apiBaseUrl && adminApiKey)
}, null, 2));

const sendResult = await client.request(`/webhooks/${webhookId}/send`, {
  method: 'POST',
  idempotencyKey: `sivan-webhook-test-${eventId}-${Date.now()}-${crypto.randomUUID()}`,
  body: { event_id: eventId }
});
console.log(JSON.stringify({ step: 'bridge_webhook_send_requested', sendResult }, null, 2));

if (apiBaseUrl && adminApiKey) {
  const observed = await pollBackendForWebhook(eventId, pollSeconds);
  console.log(JSON.stringify({ step: 'sivan_backend_webhook_observed', observed }, null, 2));
  if (!observed) process.exit(1);
} else {
  console.log(JSON.stringify({
    step: 'manual_poll_required',
    message: 'Bridge accepted the send request. Set SIVAN_API_BASE_URL and ADMIN_API_KEY to auto-confirm the event in /api/admin/webhooks.'
  }, null, 2));
}

async function pickRecentEventId(category: string): Promise<string | undefined> {
  const response: any = await client.request('/webhook_events', { query: { limit: '50', category } });
  const events = Array.isArray(response?.data) ? response.data : [];
  const event = events.find((item: any) => typeof item?.event_id === 'string') ?? events[0];
  console.log(JSON.stringify({
    step: 'bridge_webhook_events_listed',
    category,
    count: response?.count ?? events.length,
    selectedEventId: event?.event_id
  }, null, 2));
  return event?.event_id;
}

async function pollBackendForWebhook(eventId: string, seconds: number) {
  const deadline = Date.now() + seconds * 1000;
  let lastStatus = 0;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const url = new URL('/api/admin/webhooks', apiBaseUrl);
      url.searchParams.set('limit', '50');
      const res = await fetch(url, { headers: { 'x-admin-api-key': adminApiKey } });
      lastStatus = res.status;
      const json: any = await res.json().catch(() => ({}));
      if (res.ok) {
        const rows = Array.isArray(json?.data) ? json.data : [];
        const match = rows.find((row: any) => row.providerEventId === eventId || row.provider_event_id === eventId);
        if (match) {
          return {
            providerEventId: match.providerEventId ?? match.provider_event_id,
            eventCategory: match.eventCategory ?? match.event_category,
            eventType: match.eventType ?? match.event_type,
            processedAt: match.processedAt ?? match.processed_at,
            createdAt: match.createdAt ?? match.created_at
          };
        }
      } else {
        lastError = JSON.stringify(json?.error ?? json).slice(0, 300);
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  console.error(JSON.stringify({ step: 'sivan_backend_webhook_not_observed', eventId, lastStatus, lastError }, null, 2));
  return undefined;
}

function redactUrl(value: string) {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return value;
  }
}
