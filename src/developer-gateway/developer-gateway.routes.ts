import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireDeveloperApiKey } from './apiKeyAuth.js';
import { developerGatewayService } from './developer-gateway.service.js';
import {
  DeveloperTransferRequest,
  DeveloperAgreementRequest,
  DeveloperSettleRequest,
} from './developer-api.types.js';

export const developerGatewayRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  // Public developer health check (no auth needed)
  app.get('/api/v1/developer/health', async () => {
    return {
      status: 'healthy',
      service: 'sivan-developer-gateway',
      supportedChains: ['stellar', 'celo', 'solana', 'base', 'ethereum'],
      zeroGasSponsorshipActive: true,
      timestamp: new Date().toISOString(),
    };
  });

  // Authenticated Developer Gateway Routes
  app.register(async (authedRoutes) => {
    authedRoutes.addHook('preHandler', requireDeveloperApiKey);

    // 1-Click Multi-Chain Programmatic Transfer
    authedRoutes.post<{ Body: DeveloperTransferRequest }>(
      '/api/v1/developer/transfers',
      async (req, reply) => {
        const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
        const result = await developerGatewayService.executeProgrammaticTransfer(req.body, idempotencyKey);
        return reply.code(200).send(result);
      }
    );

    // Programmatic Service Agreement Creation
    authedRoutes.post<{ Body: DeveloperAgreementRequest }>(
      '/api/v1/developer/agreements',
      async (req, reply) => {
        const result = await developerGatewayService.createProgrammaticAgreement(req.body);
        return reply.code(201).send(result);
      }
    );

    // Programmatic Settlement & Release
    authedRoutes.post<{ Body: DeveloperSettleRequest }>(
      '/api/v1/developer/settle',
      async (req, reply) => {
        const result = await developerGatewayService.settleProgrammaticAgreement(req.body);
        return reply.code(200).send(result);
      }
    );

    // Unified Spendable Balance Query
    authedRoutes.get<{ Params: { userId: string } }>(
      '/api/v1/developer/balance/:userId',
      async (req, reply) => {
        const result = await developerGatewayService.getProgrammaticBalance(req.params.userId);
        return reply.code(200).send(result);
      }
    );
  });
};
