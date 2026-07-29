import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { listPaymentControls, updatePaymentControls, updatePaymentControlsSchema } from './payment-controls.service.js';
import { listApprovalRequests } from '../admin/admin-ops.service.js';

/**
 * Pending maker-checker requests that target payment controls, keyed so the
 * admin UI can show a "pending approval" state directly on each toggle.
 *
 * Without this the UI had no way to know a toggle had been submitted, so a
 * control that was awaiting approval looked identical to one nobody had
 * touched - which reads as "the toggle is broken".
 */
async function pendingControlApprovals() {
  const requests = await listApprovalRequests();
  return requests
    .filter((item: any) => item.status === 'pending' && item.request?.action === 'controls.update')
    .map((item: any) => ({
      id: item.id,
      resourceType: item.request?.resourceType ?? null,
      resourceId: item.request?.resourceId ?? null,
      requestedBy: item.requestedBy ?? item.request?.requestedBy ?? null,
      requestedAt: item.requestedAt,
      reason: item.request?.reason ?? null,
      riskLevel: item.request?.riskLevel ?? null
    }));
}

export async function paymentControlsRoutes(app: FastifyInstance) {
  app.get('/api/offramp/controls', async () => ({ data: await listPaymentControls() }));

  app.get('/api/admin/offramp/controls', async () => {
    const [data, pendingApprovals] = await Promise.all([listPaymentControls(), pendingControlApprovals()]);
    return { data: { ...data, pendingApprovals } };
  });

  app.put('/api/admin/offramp/controls', async (request) => {
    const body = parseBody(updatePaymentControlsSchema, request.body);
    const actor = (request as any).adminActor?.email || (request as any).adminActor?.role || 'admin_api_key';
    return { data: await updatePaymentControls(body, actor) };
  });
}
