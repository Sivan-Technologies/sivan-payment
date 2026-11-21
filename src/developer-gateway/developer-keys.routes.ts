import type { FastifyInstance } from 'fastify';
import { developerKeysService, IssueDeveloperKeyInput } from './developer-keys.service.js';
import {
  checkAgentHumanProof,
  CANONICAL_SELF_REGISTRY_CELO,
  getUnverifiedLimit,
  getVerifiedLimit,
  setAgentLimits,
} from '../security/self-agent-verifier.service.js';

export async function developerKeysRoutes(app: FastifyInstance) {
  // Admin list all developer keys
  app.get('/api/admin/developer-keys', async () => {
    const keys = await developerKeysService.listKeys();
    return { success: true, keys, total: keys.length };
  });

  // Admin issue new developer key
  app.post('/api/admin/developer-keys', async (request, reply) => {
    const body = (request.body as IssueDeveloperKeyInput) || {};
    if (!body.developerName || !body.email) {
      return reply.code(400).send({
        error: { code: 'bad_request', message: 'developerName and email are required' },
      });
    }

    const createdBy = (request as any).adminUser?.id || (request.headers['x-admin-actor'] as string) || 'superadmin';
    const result = await developerKeysService.issueKey({ ...body, createdBy });
    return reply.code(201).send({
      success: true,
      key: result.record,
      secretKey: result.secretKey, // Returned once only!
    });
  });

  // Admin revoke developer key
  app.post('/api/admin/developer-keys/:id/revoke', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = (request.body as { reason?: string }) || {};
    const success = await developerKeysService.revokeKey(id, body.reason);
    if (!success) {
      return reply.code(404).send({
        error: { code: 'not_found', message: 'Developer API key not found' },
      });
    }
    return { success: true, message: 'Developer API key revoked' };
  });

  // Admin view key request logs
  app.get('/api/admin/developer-keys/:id/logs', async (request) => {
    const { id } = request.params as { id: string };
    const query = (request.query as { limit?: string }) || {};
    const limit = Number(query.limit) > 0 ? Number(query.limit) : 50;
    const logs = await developerKeysService.getKeyLogs(id, limit);
    return { success: true, logs, total: logs.length };
  });

  // Admin view aggregate usage analytics
  app.get('/api/admin/developer-analytics', async () => {
    const analytics = await developerKeysService.getAnalytics();
    return { success: true, analytics };
  });

  // Admin list all connected AI agents and Self Agent ID controls
  app.get('/api/admin/agent-controls', async () => {
    const unverifiedLimit = getUnverifiedLimit();
    const verifiedLimit = getVerifiedLimit();

    const fleet = [
      {
        id: 'agent_10089',
        name: 'Sivan Payment AI',
        agentId: 10089,
        owner: 'Sivan Technology (Samson Micheal)',
        walletAddress: '0x46eFfe0409BFE99b0435e7bb7219DC6586612345',
        network: 'celo',
        chainId: 42220,
        attributionTag: 'celo_bdb587d550be',
        status: 'ACTIVE',
        isHumanVerified: true,
        tier: 'VERIFIED_HUMAN_AGENT',
        transactionLimitUsd: verifiedLimit,
        registryUrl: 'https://8004scan.io/agents/celo/10089',
        reauthUrl: 'https://api.sivantech.online/api/v1/agent/refresh?agentId=10089',
        services: [
          { name: 'REST Web API', endpoint: 'https://api.sivantech.online/api/v1/agent/invoke', status: 'ONLINE' },
          { name: 'Model Context Protocol (MCP)', endpoint: 'https://api.sivantech.online/mcp', status: 'ONLINE' },
          { name: 'A2A Discovery Handshake', endpoint: 'https://api.sivantech.online/api/v1/agent/capabilities', status: 'ONLINE' },
        ],
      },
    ];

    return {
      success: true,
      fleet,
      settings: {
        unverifiedLimitUsd: unverifiedLimit,
        verifiedLimitUsd: verifiedLimit,
        sybilLimit: 1,
        replayProtection: true,
        registryAddress: CANONICAL_SELF_REGISTRY_CELO,
        network: 'celo-mainnet',
        rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org',
      },
      stats: {
        totalAgents: fleet.length,
        verifiedAgents: fleet.filter((a) => a.isHumanVerified).length,
        unverifiedAgents: fleet.filter((a) => !a.isHumanVerified).length,
        activeAttributionTag: 'celo_bdb587d550be',
      },
    };
  });

  // Admin update agent limit thresholds
  app.post('/api/admin/agent-controls/limits', async (request) => {
    const body = (request.body as { unverifiedLimitUsd?: number; verifiedLimitUsd?: number }) || {};
    setAgentLimits(body.unverifiedLimitUsd, body.verifiedLimitUsd);
    return {
      success: true,
      message: 'Agent risk limit thresholds updated',
      settings: {
        unverifiedLimitUsd: getUnverifiedLimit(),
        verifiedLimitUsd: getVerifiedLimit(),
      },
    };
  });

  // Admin trigger on-chain Self Proof verification check
  app.post('/api/admin/agent-controls/verify-check', async (request, reply) => {
    const { agentKeyOrAddress } = (request.body as { agentKeyOrAddress?: string }) || {};
    if (!agentKeyOrAddress) {
      return reply.code(400).send({ error: { code: 'bad_request', message: 'agentKeyOrAddress is required' } });
    }
    try {
      const check = await checkAgentHumanProof(agentKeyOrAddress);
      return { success: true, check };
    } catch (err: any) {
      return reply.code(500).send({
        success: false,
        error: { code: 'verification_failed', message: err.message || 'On-chain check failed' },
      });
    }
  });

  // Admin generate Self Agent ID Universal Deep Link
  app.post('/api/admin/agent-controls/deep-link', async (request) => {
    const { agentId } = (request.body as { agentId?: number | string }) || {};
    const id = agentId || 10089;
    const universalLink = `https://self.xyz/verify?agentId=${id}&chainId=42220&registry=${CANONICAL_SELF_REGISTRY_CELO}`;
    return {
      success: true,
      agentId: Number(id),
      universalLink,
      qrData: universalLink,
    };
  });
}
