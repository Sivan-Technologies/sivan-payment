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

const generateCodeSchema = z.object({
  adminActorId: z.string().min(1, 'adminActorId is required'),
  adminPhone: z.string().min(7, 'adminPhone is required'),
  displayName: z.string().optional(),
});

const allocateRevshareSchema = z.object({
  agreementId: z.string().min(1, 'agreementId is required'),
  originatingGroupId: z.string().optional(),
  partnerCode: z.string().optional(),
  dealAmountNgn: z.number().positive('dealAmountNgn must be positive'),
  platformFeeNgn: z.number().min(0, 'platformFeeNgn cannot be negative'),
});

const updateControlsSchema = z.object({
  groupId: z.string().optional(),
  groupJid: z.string().optional(),
  isEarningEnabled: z.boolean().optional(),
  isBroadcastEnabled: z.boolean().optional(),
  revsharePercent: z.number().min(0).max(100).optional(),
  status: z.enum(['ACTIVE', 'PAUSED', 'SUSPENDED']).optional(),
}).refine(data => data.groupId || data.groupJid, {
  message: 'Either groupId or groupJid must be provided',
});

export async function communityRoutes(app: FastifyInstance) {
  /**
   * POST /api/community/partner/generate-code
   * Called from whatsapp-bot private DM when a user types "partner code" or "my referral code".
   * Returns or creates a stable SIV-XXX-XX partner referral code for the actor.
   */
  app.post('/api/community/partner/generate-code', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const input = generateCodeSchema.parse(request.body);
      const result = await communityRevshareService.generatePartnerCode(input);
      return reply.send({ success: true, ...result });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to generate partner code' });
    }
  });

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
   * PUT /api/community/admin/controls & /api/admin/community/controls
   * Enables Admin Hub to toggle admin earnings on/off, edit revshare percent, or pause group.
   */
  const handleUpdateControls = async (request: FastifyRequest, reply: FastifyReply) => {
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
  };
  app.put('/api/community/admin/controls', handleUpdateControls);
  app.put('/api/admin/community/controls', handleUpdateControls);

  /**
   * GET /api/community/admin/:adminActorId/stats & /api/admin/community/:adminActorId/stats
   * Fetches aggregate earnings and deals for an admin across all their linked groups.
   */
  const handleAdminStats = async (request: FastifyRequest<{ Params: { adminActorId: string } }>, reply: FastifyReply) => {
    try {
      const { adminActorId } = request.params;
      const stats = await communityRevshareService.getAdminStats(adminActorId);
      return reply.send({ success: true, stats });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err?.message || 'Failed to fetch admin stats' });
    }
  };
  app.get('/api/community/admin/:adminActorId/stats', handleAdminStats);
  app.get('/api/admin/community/:adminActorId/stats', handleAdminStats);

  /**
   * GET /api/community/admin/groups & /api/admin/community/groups
   * Lists all community partner groups for the Sivan Admin Hub dashboard.
   * Supports ?broadcastOnly=true filter.
   */
  const handleGetGroups = async (request: FastifyRequest<{ Querystring: { broadcastOnly?: string } }>, reply: FastifyReply) => {
    try {
      if (request.query?.broadcastOnly === 'true') {
        const groups = await communityRevshareService.getBroadcastEnabledGroups();
        return reply.send({ success: true, groups, count: groups.length });
      }
      const stats = await communityRevshareService.getAllGroupsSummary();
      return reply.send({ success: true, ...stats });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err?.message || 'Failed to list community groups' });
    }
  };
  app.get('/api/community/admin/groups', handleGetGroups);
  app.get('/api/admin/community/groups', handleGetGroups);

  /**
   * POST /api/community/group/toggle-broadcast
   * Called by WhatsApp community bot when admin sends "sivan broadcast on" or "sivan broadcast off".
   */
  app.post('/api/community/group/toggle-broadcast', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const toggleSchema = z.object({
        groupJid: z.string().min(1, 'groupJid is required'),
        isBroadcastEnabled: z.boolean(),
      });
      const input = toggleSchema.parse(request.body);
      const updated = await communityRevshareService.updateAdminControls({
        groupJid: input.groupJid,
        isBroadcastEnabled: input.isBroadcastEnabled,
      });
      if (!updated) {
        return reply.status(404).send({ success: false, error: 'Community group not found or not linked' });
      }
      return reply.send({ success: true, group: updated });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to toggle broadcast' });
    }
  });

  /**
   * GET /api/community/admin/developer-controls & /api/admin/community/developer-controls
   */
  const handleGetDeveloperControls = async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const controls = await communityRevshareService.getDeveloperControls();
      return reply.send({ success: true, controls });
    } catch (err: any) {
      return reply.status(500).send({ success: false, error: err?.message || 'Failed to get developer controls' });
    }
  };
  app.get('/api/community/admin/developer-controls', handleGetDeveloperControls);
  app.get('/api/admin/community/developer-controls', handleGetDeveloperControls);

  /**
   * PUT /api/community/admin/developer-controls & /api/admin/community/developer-controls
   */
  const handleUpdateDeveloperControls = async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = request.body as any;
      const controls = await communityRevshareService.updateDeveloperControls(body || {});
      return reply.send({ success: true, controls });
    } catch (err: any) {
      return reply.status(400).send({ success: false, error: err?.message || 'Failed to update developer controls' });
    }
  };
  app.put('/api/community/admin/developer-controls', handleUpdateDeveloperControls);
  app.put('/api/admin/community/developer-controls', handleUpdateDeveloperControls);
}

