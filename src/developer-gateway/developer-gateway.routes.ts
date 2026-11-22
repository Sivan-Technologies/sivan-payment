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
import {
  getAgreementControls,
  isCreationAllowed,
} from '../agreements/agreement-controls.service.js';
import {
  verifyFastifyAgentRequest,
  assertSelfAgentLimit,
  CANONICAL_SELF_REGISTRY_CELO,
  UNVERIFIED_TRANSACTION_LIMIT_USD,
  VERIFIED_TRANSACTION_LIMIT_USD,
} from '../security/self-agent-verifier.service.js';
import {
  isX402Requested,
  extractX402PaymentPayload,
  settleX402Payment,
  sendX402RequiredResponse,
  generateX402Challenge,
  X402_FACILITATOR_MAINNET_URL,
  SIVAN_CELO_AGENT_ADDRESS,
  SIVAN_CELO_AGENT_ID,
  SIVAN_CELO_ATTRIBUTION_TAG,
  CELO_ASSETS,
} from '../security/x402-facilitator.service.js';

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
      x402Facilitator: {
        standard: 'x402 V2 Protocol',
        network: 'eip155:42220',
        facilitatorUrl: X402_FACILITATOR_MAINNET_URL,
        supportedAssets: Object.keys(CELO_ASSETS),
        agentId: SIVAN_CELO_AGENT_ID,
        payTo: SIVAN_CELO_AGENT_ADDRESS,
        attributionTag: SIVAN_CELO_ATTRIBUTION_TAG,
        challengeEndpoint: 'https://api.sivantech.online/api/v1/agent/x402',
      },
    };
  };

  app.get('/api/v1/developer/capabilities', capabilitiesHandler);
  app.get('/api/v1/agent/capabilities', capabilitiesHandler);

  // REST Agent Invocation Endpoint (Registered on 8004scan / ERC-8004)
  const agentInvokeHandler = async (req: any, reply: any) => {
    // If client or scanner requests x402 challenge via GET
    if (req.method === 'GET' && isX402Requested(req)) {
      return sendX402RequiredResponse(reply);
    }

    if (req.method === 'GET') {
      return reply.code(200).send({
        status: 'active',
        agent: {
          name: 'Sivan AI',
          agentId: SIVAN_CELO_AGENT_ID,
          network: 'celo',
          chainId: 42220,
          walletAddress: SIVAN_CELO_AGENT_ADDRESS,
          attributionTag: SIVAN_CELO_ATTRIBUTION_TAG,
          registryUrl: `https://8004scan.io/agents/celo/${SIVAN_CELO_AGENT_ID}`,
        },
        x402: {
          supported: true,
          version: 2,
          scheme: 'exact',
          network: 'eip155:42220',
          payTo: SIVAN_CELO_AGENT_ADDRESS,
          facilitator: X402_FACILITATOR_MAINNET_URL,
          assets: ['USDC', 'USDT', 'cUSD'],
        },
        selfAgentId: {
          standard: 'ERC-8004 / Self Protocol Proof-of-Human',
          registryAddress: CANONICAL_SELF_REGISTRY_CELO,
          network: 'celo-mainnet',
          tiers: {
            verified: `Up to $${VERIFIED_TRANSACTION_LIMIT_USD} USD limit per tx, full access to Service Agreements & fiat off-ramps`,
            unverified: `Up to $${UNVERIFIED_TRANSACTION_LIMIT_USD} USD limit, micro-queries & indicative quotes`,
          },
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
            destinationAddress: SIVAN_CELO_AGENT_ADDRESS,
            amount: 5,
            network: 'celo',
            currency: 'usdc',
          },
        },
      });
    }

    // Handle x402 Payment Flow for POST requests
    let x402Settlement: any = null;
    if (isX402Requested(req)) {
      const payment = extractX402PaymentPayload(req);
      if (!payment || (!payment.paymentPayload && !payment.signature)) {
        // Return 402 Payment Required with base64 payment-required header
        return sendX402RequiredResponse(reply);
      }

      // Settle payment with Celo hosted facilitator
      const settlement = await settleX402Payment(payment.paymentPayload, payment.paymentRequirements);
      if (!settlement.success) {
        return reply.code(402).send({
          status: 'error',
          code: 402,
          error: settlement.error || 'x402 payment settlement failed on Celo',
          challenge: generateX402Challenge().challenge,
        });
      }
      x402Settlement = settlement;
    }

    const selfVerification = await verifyFastifyAgentRequest(req);
    const body = req.body || {};
    const toolName = body.tool || body.name || (body.method ? String(body.method).replace(/^tools\//, '') : undefined);
    const toolArgs = body.params || body.arguments || body.args || body;

    if (toolName) {
      // Enforce Self Agent ID verification for restricted tools or amounts exceeding unverified threshold
      const requestedAmount = parseFloat(toolArgs?.amount || '0');
      const limitCheck = assertSelfAgentLimit(selfVerification, requestedAmount, toolName);
      if (!limitCheck.allowed) {
        return reply.code(403).send({
          status: 'error',
          ...limitCheck.errorResponse,
          selfVerification,
        });
      }

      try {
        const result = await mcpServerEngine.executeTool(toolName, toolArgs);
        return reply.code(200).send({
          status: 'success',
          agent: {
            name: 'Sivan AI',
            agentId: SIVAN_CELO_AGENT_ID,
            attributionTag: SIVAN_CELO_ATTRIBUTION_TAG,
          },
          x402Payment: x402Settlement
            ? {
                settled: true,
                transaction: x402Settlement.transaction || x402Settlement.txHash,
                asset: x402Settlement.asset,
                amount: x402Settlement.amount,
                settledVia: x402Settlement.settledVia,
              }
            : undefined,
          selfVerification: {
            isVerified: selfVerification.isVerified,
            tier: selfVerification.tier,
            maxTransactionLimitUsd: selfVerification.maxTransactionLimitUsd,
          },
          tool: toolName,
          result,
        });
      } catch (err: any) {
        return reply.code(400).send({
          status: 'error',
          agent: {
            name: 'Sivan AI',
            agentId: SIVAN_CELO_AGENT_ID,
            attributionTag: SIVAN_CELO_ATTRIBUTION_TAG,
          },
          selfVerification: {
            isVerified: selfVerification.isVerified,
            tier: selfVerification.tier,
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
        agentId: SIVAN_CELO_AGENT_ID,
        network: 'celo',
        attributionTag: SIVAN_CELO_ATTRIBUTION_TAG,
      },
      x402Payment: x402Settlement
        ? {
            settled: true,
            transaction: x402Settlement.transaction || x402Settlement.txHash,
            settledVia: x402Settlement.settledVia,
          }
        : undefined,
      selfVerification: {
        isVerified: selfVerification.isVerified,
        tier: selfVerification.tier,
        maxTransactionLimitUsd: selfVerification.maxTransactionLimitUsd,
      },
      input: prompt,
      response: 'Sivan Payment AI processed request for agent #10089. Multi-chain zero-gas settlement and Service Agreement protocol active.',
      availableTools: SIVAN_MCP_TOOLS.map((t) => t.name),
    });
  };

  app.get('/api/v1/agent/invoke', agentInvokeHandler);
  app.post('/api/v1/agent/invoke', agentInvokeHandler);

  // Dedicated Celo x402 Facilitator Challenge & Discovery Endpoint
  app.get('/api/v1/agent/x402', async (_req, reply) => {
    return sendX402RequiredResponse(reply);
  });

  app.post('/api/v1/agent/x402', async (req, reply) => {
    const payment = extractX402PaymentPayload(req);
    if (!payment || (!payment.paymentPayload && !payment.signature)) {
      return sendX402RequiredResponse(reply);
    }
    const settlement = await settleX402Payment(payment.paymentPayload, payment.paymentRequirements);
    if (!settlement.success) {
      return reply.code(402).send({
        status: 'error',
        code: 402,
        error: settlement.error || 'x402 payment settlement failed on Celo',
        challenge: generateX402Challenge().challenge,
      });
    }
    return reply.code(200).send({
      status: 'success',
      settlement,
      agentId: SIVAN_CELO_AGENT_ID,
      attributionTag: SIVAN_CELO_ATTRIBUTION_TAG,
    });
  });

  // Direct Settlement Forwarding to Celo Hosted Facilitator
  app.post<{ Body: { paymentPayload?: any; paymentRequirements?: any; apiKey?: string } }>(
    '/api/v1/agent/x402/settle',
    async (req, reply) => {
      const { paymentPayload, paymentRequirements, apiKey } = req.body || {};
      if (!paymentPayload) {
        return reply.code(400).send({
          status: 'error',
          error: 'Missing paymentPayload in request body',
        });
      }
      const settlement = await settleX402Payment(paymentPayload, paymentRequirements, apiKey);
      if (!settlement.success) {
        return reply.code(402).send({
          status: 'error',
          error: settlement.error || 'Settlement rejected',
        });
      }
      return reply.code(200).send({
        status: 'success',
        ...settlement,
      });
    }
  );

  // Self Agent ID Proof Status Check
  app.get('/api/v1/agent/self-status', async (req: any, reply: any) => {
    const outcome = await verifyFastifyAgentRequest(req);
    return reply.code(200).send({
      status: 'ok',
      verification: outcome,
    });
  });

  // Self Agent ID Re-Auth & Universal Deep Link
  app.get<{ Querystring: { agentId?: string; chainId?: string; registry?: string } }>(
    '/api/v1/agent/refresh',
    async (req, reply) => {
      const agentId = req.query.agentId || '10089';
      const celoChainId = req.query.chainId || '42220';
      const registry = req.query.registry || CANONICAL_SELF_REGISTRY_CELO;
      const universalLink = `https://self.xyz/verify?agentId=${agentId}&chainId=${celoChainId}&registry=${registry}`;
      return reply.code(200).send({
        status: 'ok',
        agentId: Number(agentId),
        chainId: Number(celoChainId),
        registryAddress: registry,
        universalLink,
        message: 'Open this link in the Self mobile app to refresh or claim your human-backed agent proof.',
      });
    }
  );

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
        const selfVerification = await verifyFastifyAgentRequest(req);
        const limitCheck = assertSelfAgentLimit(selfVerification, req.body?.amount || 0, 'ProgrammaticTransfer');
        if (!limitCheck.allowed) {
          return reply.code(403).send(limitCheck.errorResponse);
        }

        const idempotencyKey = req.headers['x-idempotency-key'] as string | undefined;
        const result = await developerGatewayService.executeProgrammaticTransfer(req.body, idempotencyKey);
        return reply.code(200).send(result);
      }
    );

    // Programmatic Service Agreement Creation
    authedRoutes.post<{ Body: DeveloperAgreementRequest }>(
      '/api/v1/developer/agreements',
      async (req, reply) => {
        const selfVerification = await verifyFastifyAgentRequest(req);
        const limitCheck = assertSelfAgentLimit(selfVerification, req.body?.amount || 0, 'ServiceAgreementCreation');
        if (!limitCheck.allowed) {
          return reply.code(403).send(limitCheck.errorResponse);
        }

        // PSA Creation Guard: developer API and MCP agent creation is subject to
        // the same creation_enabled flag as the web and MiniPay surfaces.
        const controls = await getAgreementControls();
        if (!isCreationAllowed(controls, req.body?.buyerUserId)) {
          return reply.code(503).send({
            success: false,
            code: 'AGREEMENT_CREATION_PAUSED',
            message: controls.maintenanceMessage,
          });
        }
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
