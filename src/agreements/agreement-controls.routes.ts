import type { FastifyInstance } from 'fastify';
import {
  getAgreementControls,
  updateAgreementControls,
  buildPublicControlsPayload,
} from './agreement-controls.service.js';

/**
 * Agreement Controls Routes
 *
 * Public endpoint:
 *   GET /api/agreements/controls
 *   Short-lived cache headers allow clients to avoid hammering the API on every
 *   page load while still getting near-real-time updates when an admin toggles
 *   a flag. Served without authentication so frontend apps and MiniPay can read
 *   it before a user session is established.
 *
 * Admin endpoints:
 *   GET  /api/admin/agreements/controls  — Full state including audit fields.
 *   PUT  /api/admin/agreements/controls  — Toggle any combination of the three
 *        control axes. Requires a valid admin key (enforced by the upstream
 *        Fastify admin-auth hook in app.ts).
 */
export async function agreementControlsRoutes(app: FastifyInstance) {
  /**
   * GET /api/agreements/controls
   * Public feature-flag endpoint consumed by Web App, MiniPay, and Telegram AI
   * on startup to decide whether to render Service Agreement UI surfaces.
   */
  app.get('/api/agreements/controls', async (_req, reply) => {
    const controls = await getAgreementControls();
    reply.header('Cache-Control', 'public, max-age=10, stale-while-revalidate=10');
    return reply.code(200).send({
      status: 'success',
      controls: buildPublicControlsPayload(controls),
    });
  });

  /**
   * GET /api/admin/agreements/controls
   * Admin-only view that includes the full record including audit trail fields.
   * Protected by the admin-key middleware registered in app.ts.
   */
  app.get('/api/admin/agreements/controls', async (_req, reply) => {
    const controls = await getAgreementControls();
    return reply.code(200).send({
      status: 'success',
      controls,
    });
  });

  /**
   * PUT /api/admin/agreements/controls
   * Toggles any combination of creationEnabled, servicingEnabled, emergencyHalt,
   * pilotWhitelistOnly, allowedNetworks, and maintenanceMessage.
   * Immediately flushes the in-memory cache on success.
   *
   * Body shape (all fields optional, only provided fields are updated):
   * {
   *   creationEnabled?: boolean;
   *   servicingEnabled?: boolean;
   *   emergencyHalt?: boolean;
   *   pilotWhitelistOnly?: boolean;
   *   allowedNetworks?: string[];
   *   maintenanceMessage?: string;
   * }
   */
  app.put<{
    Body: {
      creationEnabled?: boolean;
      servicingEnabled?: boolean;
      emergencyHalt?: boolean;
      pilotWhitelistOnly?: boolean;
      allowedNetworks?: string[];
      maintenanceMessage?: string;
    };
  }>('/api/admin/agreements/controls', async (req, reply) => {
    const body = req.body ?? {};
    const adminId =
      (req as any).adminActor?.email ||
      (req as any).adminActor?.role ||
      'admin_api_key';

    const updates: Record<string, unknown> = {};
    if (typeof body.creationEnabled === 'boolean') updates.creationEnabled = body.creationEnabled;
    if (typeof body.servicingEnabled === 'boolean') updates.servicingEnabled = body.servicingEnabled;
    if (typeof body.emergencyHalt === 'boolean') updates.emergencyHalt = body.emergencyHalt;
    if (typeof body.pilotWhitelistOnly === 'boolean') updates.pilotWhitelistOnly = body.pilotWhitelistOnly;
    if (Array.isArray(body.allowedNetworks)) updates.allowedNetworks = body.allowedNetworks;
    if (typeof body.maintenanceMessage === 'string') updates.maintenanceMessage = body.maintenanceMessage;

    if (Object.keys(updates).length === 0) {
      return reply.code(400).send({
        status: 'error',
        code: 'NO_UPDATES_PROVIDED',
        message: 'At least one field must be provided to update agreement controls.',
      });
    }

    const updated = await updateAgreementControls(updates as any, adminId);
    return reply.code(200).send({
      status: 'success',
      controls: updated,
      message: 'Agreement controls updated and cache refreshed.',
    });
  });
}
