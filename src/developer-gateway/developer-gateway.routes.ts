import { FastifyInstance, FastifyPluginAsync } from 'fastify';
import { requireDeveloperApiKey } from './apiKeyAuth.js';
import { developerGatewayService } from './developer-gateway.service.js';
import { mcpServerEngine, McpJsonRpcRequest } from './mcp-server.js';
import { SIVAN_MCP_TOOLS } from './mcp-schema.js';
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
      supportedChains: ['stellar', 'celo', 'solana', 'base', 'bsc', 'ethereum'],
      zeroGasSponsorshipActive: true,
      mcpEndpoint: 'https://api.sivantech.online/mcp',
      timestamp: new Date().toISOString(),
    };
  });

  // A2A Capabilities & Discovery Manifest (ERC-8004 compatible)
  const capabilitiesHandler = async () => {
    return {
      protocol: 'sivan-a2a-v1',
      standard: 'ERC-8004-Compatible',
      serviceName: 'Sivan Payment AI',
      description: 'Autonomous Multi-Chain Settlement & Service Agreement Engine for AI Agents.',
      website: 'https://sivantech.online',
      endpoints: {
        mcp: 'https://api.sivantech.online/mcp',
        transfers: 'https://api.sivantech.online/api/v1/developer/transfers',
        agreements: 'https://api.sivantech.online/api/v1/developer/agreements',
        settle: 'https://api.sivantech.online/api/v1/developer/settle',
        balance: 'https://api.sivantech.online/api/v1/developer/balance/:userId',
      },
      supportedChains: [
        { network: 'stellar', nativeAsset: 'USDC', feeModel: 'ZERO_GAS_SPONSORED (CAP-0015)' },
        { network: 'celo', nativeAssets: ['cUSD', 'USDC'], feeModel: 'MICRO_GAS' },
        { network: 'solana', nativeAssets: ['USDC', 'USDT'], feeModel: 'SUB_CENT_HIGH_SPEED' },
        { network: 'base', nativeAsset: 'USDC', feeModel: 'L2_HIGH_THROUGHPUT' },
        { network: 'bsc', nativeAssets: ['USDT', 'USDC'], feeModel: 'EVM_LOW_FEE' },
      ],
      mcpToolsCount: SIVAN_MCP_TOOLS.length,
      tools: SIVAN_MCP_TOOLS.map((t) => ({ name: t.name, description: t.description })),
    };
  };

  app.get('/api/v1/developer/capabilities', capabilitiesHandler);
  app.get('/api/v1/agent/capabilities', capabilitiesHandler);

  // Model Context Protocol (MCP) JSON-RPC 2.0 Handler
  app.post<{ Body: McpJsonRpcRequest }>('/mcp', async (req, reply) => {
    const response = await mcpServerEngine.handleJsonRpc(req.body || {});
    return reply.code(200).send(response);
  });

  // Model Context Protocol (MCP) Server-Sent Events (SSE) Stream
  app.get<{ Querystring: { stream?: string } }>('/mcp', async (req, reply) => {
    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.setHeader('Access-Control-Allow-Origin', '*');

    // Send initial endpoint and server info event
    const initPayload = JSON.stringify({
      jsonrpc: '2.0',
      method: 'sivan/connected',
      params: {
        server: 'sivan-mcp-server',
        version: '1.0.0',
        tools: SIVAN_MCP_TOOLS.map((t) => t.name),
      },
    });

    reply.raw.write(`event: message\ndata: ${initPayload}\n\n`);

    if (req.query.stream === 'false') {
      reply.raw.end();
      return;
    }

    // Keep-alive heartbeat (unref to avoid hanging process/tests)
    const interval = setInterval(() => {
      try {
        reply.raw.write(': heartbeat\n\n');
      } catch {
        clearInterval(interval);
      }
    }, 15000).unref();

    req.raw.on('close', () => {
      clearInterval(interval);
    });
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
