import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import {
  getComplianceThresholds,
  updateComplianceThresholds,
  updateComplianceThresholdsSchema,
  getUserComplianceProfile,
} from './compliance-thresholds.service.js';

export async function complianceRoutes(app: FastifyInstance) {
  /**
   * GET /api/admin/compliance/thresholds
   * Returns current Step-Up KYC thresholds and enforcement status for both Nigeria and Global corridors.
   */
  app.get('/api/admin/compliance/thresholds', async () => {
    return { data: await getComplianceThresholds() };
  });

  /**
   * PUT /api/admin/compliance/thresholds
   * Updates Step-Up KYC thresholds and toggles Tier 2 enforcement (Growth Mode vs Compliance Mode).
   */
  app.put('/api/admin/compliance/thresholds', async (request) => {
    const body = parseBody(updateComplianceThresholdsSchema, request.body);
    const actor =
      (request as any).adminActor?.email ||
      (request as any).adminActor?.role ||
      'admin_api_key';
    return { data: await updateComplianceThresholds(body, actor) };
  });

  /**
   * GET /api/compliance/status/:userId
   * Returns user compliance tier, rolling 30-day volumes, and applicable corridor limits.
   */
  app.get('/api/compliance/status/:userId', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUserComplianceProfile(userId) };
  });
}
