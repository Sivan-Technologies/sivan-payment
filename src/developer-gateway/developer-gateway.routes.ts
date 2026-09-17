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

  // REST Agent Invocation Endpoint (Registered on 8004scan / ERC-8004)
  const agentInvokeHandler = async (req: any, reply: any) => {
    if (req.method === 'GET') {
      return reply.code(200).send({
        status: 'active',
        agent: {
          name: 'Sivan AI',
          agentId: 9827,
          network: 'celo',
          chainId: 42220,
          walletAddress: '0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc',
          attributionTag: 'celo_bafcc2e56bd7',
          registryUrl: 'https://8004scan.io/agents/celo/9827',
        },
        supportedMethods: ['POST'],
        capabilities: [
          'sivan_create_payment_link',
          'sivan_initiate_service_agreement',
          'sivan_verify_milestone_and_release',
          'sivan_resolve_bank_account',
          'sivan_fiat_bank_cashout',
          'sivan_get_balance',
        ],
        examplePayload: {
          prompt: 'Transfer 5 USDC on Celo to 0x...',
          tool: 'sivan_create_payment_link',
          params: {
            destinationAddress: '0x4a1A9cf30A86b2b333D1a743181aAE71a50BAFBc',
            amount: 5,
            network: 'celo',
            currency: 'usdc',
          },
        },
      });
    }

    const body = req.body || {};
    const toolName = body.tool || body.name || (body.method ? String(body.method).replace(/^tools\//, '') : undefined);
    const toolArgs = body.params || body.arguments || body.args || body;

    if (toolName) {
      try {
        const result = await mcpServerEngine.executeTool(toolName, toolArgs);
        return reply.code(200).send({
          status: 'success',
          agent: {
            name: 'Sivan AI',
            agentId: 9827,
            attributionTag: 'celo_bafcc2e56bd7',
          },
          tool: toolName,
          result,
        });
      } catch (err: any) {
        return reply.code(400).send({
          status: 'error',
          agent: {
            name: 'Sivan AI',
            agentId: 9827,
            attributionTag: 'celo_bafcc2e56bd7',
          },
          error: err.message || 'Execution failed',
        });
      }
    }

    // Natural language prompt invocation fallback
    const prompt = body.prompt || body.message || body.input || '';
    return reply.code(200).send({
      status: 'success',
      agent: {
        name: 'Sivan AI',
        agentId: 9827,
        network: 'celo',
        attributionTag: 'celo_bafcc2e56bd7',
      },
      input: prompt,
      response: 'Sivan Payment AI processed request for agent #9827. Multi-chain zero-gas settlement and Service Agreement protocol active.',
      availableTools: SIVAN_MCP_TOOLS.map((t) => t.name),
    });
  };

  app.get('/api/v1/agent/invoke', agentInvokeHandler);
  app.post('/api/v1/agent/invoke', agentInvokeHandler);

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
