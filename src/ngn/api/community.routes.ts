// Sivan Ai . Community Partner & Revenue Share Fastify Routes
// Exposes endpoints for:
// - Verifying and linking partner codes (sivan link <CODE>)
// - Allocating revshare upon deal completion
// - Updating admin earning toggles and custom fee percentages
// - Viewing admin stats and group metrics

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import { communityRevshareService } from '../service/community-revshare.service.js';

const linkGroupSchema = z.object({
  groupJid: z.string().min(1, 'groupJid is required'),
  groupName: z.string().optional().default(''),
  partnerCode: z.string().min(1, 'partnerCode is required'),
});

const allocateRevshareSchema = z.object({
  agreementId: z.string().min(1, 'agreementId is required'),
  originatingGroupId: z.string().optional(),
  partnerCode: z.string().optional(),
  dealAmountNgn: z.number().positive('dealAmountNgn must be positive'),
  platformFeeNgn: z.number().min(0, 'platformFeeNgn cannot be negative'),
});

const updateControlsSchema = z.object({
  groupId: z.string().min(1, 'groupId is required'),
  isEarningEnabled: z.boolean().optional(),
  revsharePercent: z.number().min(0).max(100).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'SUSPENDED']).optional(),
});

export async function communityRoutes(app: FastifyInstance) {
  /**
   * POST /api/community/verify-link
   * Used by WhatsApp Community Bridge when an admin sends "sivan link <CODE>".
   */
  app.post('/api/community/verify-link', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = linkGroupSchema.parse(request.body);
      const result = await communityRevshareService.linkGroup({
        groupJid: input.groupJid,
        groupName: input.groupName,
        partnerCode: input.partnerCode,
      });

      if (!result.success) {
        return reply.status(404).send({ success: false, error: result.error });
      }

      return reply.send({
        success: true,
        group: result.group,
        message: `Group successfully linked to partner code ${result.group?.referralCode}`,
      });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Invalid link request' });
    }
  });

  /**
   * POST /api/community/allocate-revshare
   * Called upon terminal RELEASED status of a Service Agreement.
   */
  app.post('/api/community/allocate-revshare', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = allocateRevshareSchema.parse(request.body);
      const result = await communityRevshareService.allocateRevshare(input);
      return reply.send({ success: true, allocation: result });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to allocate revshare' });
    }
  });

  /**
   * PUT /api/community/admin/controls
   * Enables Admin Hub to toggle admin earnings on/off, edit revshare percent, or pause group.
   */
  app.put('/api/community/admin/controls', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = updateControlsSchema.parse(request.body);
      const updated = await communityRevshareService.updateAdminControls(input);
      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Community group not found' });
      }
      return reply.send({ success: true, group: updated });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to update controls' });
    }
  });

  /**
   * GET /api/community/admin/:adminActorId/stats
   * Fetches aggregate earnings and deals for an admin across all their linked groups.
   */
  app.get('/api/community/admin/:adminActorId/stats', async (request: FastifyRequest<{ Params: { adminActorId: string } }>, reply: FastifyReply) => {
    try {
      const { adminActorId } = request.params;
      const stats = await communityRevshareService.getAdminStats(adminActorId);
      return reply.send({ success: true, stats });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err?.message || 'Failed to fetch admin stats' });
    }
  });
}

