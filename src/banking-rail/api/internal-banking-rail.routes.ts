import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { getBankingRailAdapter } from '../banking-rail-registry.js';
import type { CreateTransferInput } from '../banking-rail.adapter.js';

interface InternalVirtualAccountBody {
  agreementId?: string;
  userId?: string;
  amountKobo?: number;
  title?: string;
  customerName?: string;
  customerEmail?: string;
  customerPhone?: string;
}

interface InternalDisbursementBody {
  agreementId?: string;
  providerRef: string;
  accountNumber: string;
  bankCode: string;
  amountKobo: number;
  narration?: string;
  userId?: string;
}

function verifyCoreApiAuth(req: FastifyRequest, reply: FastifyReply): boolean {
  const coreSecret = process.env.CORE_API_SECRET;
  if (!coreSecret) {
    console.error('[internal-banking-rail] CORE_API_SECRET is not configured.');
    void reply.code(503).send({ error: 'CORE_API_SECRET not configured on payment service' });
    return false;
  }

  const incomingSecret =
    req.headers['x-core-api-key'] ||
    req.headers['x-core-api-secret'] ||
    req.headers['x-internal-secret'] ||
    '';

  if (incomingSecret !== coreSecret) {
    void reply.code(401).send({ error: 'Unauthorized internal service request' });
    return false;
  }

  return true;
}

export async function internalBankingRailRoutes(app: FastifyInstance) {
  /**
   * Generates a Dedicated Virtual Account for a Service Agreement or User.
   * Service Agreement engine calls this instead of calling Nomba directly.
   */
  const handleVirtualAccounts = async (req: FastifyRequest<{ Body: InternalVirtualAccountBody }>, reply: FastifyReply) => {
    if (!verifyCoreApiAuth(req, reply)) return;

    const body = req.body || {};
    const agreementId = body.agreementId ? String(body.agreementId).trim() : undefined;
    const userId = body.userId ? String(body.userId).trim() : (agreementId ? `agr_${agreementId}` : `usr_${Date.now()}`);
    const legalName = body.customerName || (agreementId ? `SIVAN AGREEMENT ${agreementId}` : 'SIVAN CLIENT');

    try {
      const adapter = getBankingRailAdapter();
      const customer = await adapter.createCustomer({
        userId,
        legalName,
        phone: body.customerPhone,
        email: body.customerEmail,
        metadata: { agreementId },
      });

      const virtualAccount = await adapter.assignVirtualAccount(customer.providerCustomerId);

      return reply.code(200).send({
        success: true,
        data: {
          provider: adapter.name,
          accountNumber: virtualAccount.accountNumber,
          bankName: virtualAccount.bankName,
          accountName: virtualAccount.accountName,
          providerAccountId: virtualAccount.providerAccountId,
          currency: virtualAccount.currency,
          active: virtualAccount.active,
          agreementId: agreementId || null,
        },
      });
    } catch (err: any) {
      console.error('[internal-banking-rail] assignVirtualAccount failed:', err.message);
      return reply.code(500).send({
        success: false,
        error: `Virtual account issuance failed: ${err.message}`,
      });
    }
  };
  app.post('/api/payment/internal/virtual-accounts', handleVirtualAccounts);
  app.post('/internal/virtual-accounts', handleVirtualAccounts);

  /**
   * Dispatches an outbound bank transfer.
   * Service Agreement engine calls this to pay out verified agreements.
   */
  const handleDisbursements = async (req: FastifyRequest<{ Body: InternalDisbursementBody }>, reply: FastifyReply) => {
    if (!verifyCoreApiAuth(req, reply)) return;

    const body = req.body;
    if (!body?.accountNumber || !body?.bankCode || !body?.amountKobo || !body?.providerRef) {
      return reply.code(400).send({
        error: 'Missing required disbursement fields: providerRef, accountNumber, bankCode, amountKobo',
      });
    }

    try {
      const adapter = getBankingRailAdapter();
      const transferInput: CreateTransferInput = {
        providerRef: body.providerRef,
        accountNumber: body.accountNumber,
        bankCode: body.bankCode,
        amountKobo: Math.round(Number(body.amountKobo)),
        userId: body.userId || (body.agreementId ? `agr_${body.agreementId}` : 'internal_service'),
        narration: body.narration || `Sivan Release ${body.agreementId || body.providerRef}`,
      };

      const result = await adapter.createTransfer(transferInput);

      return reply.code(200).send({
        success: true,
        data: {
          provider: adapter.name,
          providerRef: result.providerRef,
          providerTransferId: result.providerTransferId || null,
          status: result.status,
          amountKobo: result.amountKobo,
          confirmedAt: result.confirmedAt || null,
          failureReason: result.failureReason || null,
        },
      });
    } catch (err: any) {
      console.error('[internal-banking-rail] createTransfer failed:', err.message);
      return reply.code(500).send({
        success: false,
        error: `Disbursement dispatch failed: ${err.message}`,
      });
    }
  };
  app.post('/api/payment/internal/disbursements', handleDisbursements);
  app.post('/internal/disbursements', handleDisbursements);

  /**
   * Checks status of an in-flight or completed disbursement.
   */
  const handleGetDisbursement = async (req: FastifyRequest<{ Params: { providerRef: string } }>, reply: FastifyReply) => {
    if (!verifyCoreApiAuth(req, reply)) return;

    const { providerRef } = req.params;
    if (!providerRef) {
      return reply.code(400).send({ error: 'providerRef parameter required' });
    }

    try {
      const adapter = getBankingRailAdapter();
      const record = await adapter.getTransfer(providerRef);
      return reply.code(200).send({
        success: true,
        data: {
          provider: adapter.name,
          providerRef: record.providerRef,
          providerTransferId: record.providerTransferId || null,
          status: record.status,
          amountKobo: record.amountKobo,
          confirmedAt: record.confirmedAt || null,
          failureReason: record.failureReason || null,
        },
      });
    } catch (err: any) {
      console.error('[internal-banking-rail] getTransfer failed:', err.message);
      return reply.code(500).send({
        success: false,
        error: `Disbursement status query failed: ${err.message}`,
      });
    }
  };
  app.get('/api/payment/internal/disbursements/:providerRef', handleGetDisbursement);
  app.get('/internal/disbursements/:providerRef', handleGetDisbursement);

  /**
   * Generates a hosted checkout order link (restricted to Transfer and USSD only).
   * Service Agreement engine calls this to generate web checkout links without holding API keys.
   */
  const handleCheckout = async (
    req: FastifyRequest<{
      Body: {
        agreementId?: string;
        orderReference?: string;
        amountKobo: number;
        customerEmail: string;
        callbackUrl?: string;
        allowedPaymentMethods?: ('Transfer' | 'USSD')[];
      };
    }>,
    reply: FastifyReply
  ) => {
    if (!verifyCoreApiAuth(req, reply)) return;

    const body = req.body || {};
    const orderReference = body.orderReference || (body.agreementId ? `sivan_agr_${body.agreementId}_${Date.now()}` : `sivan_order_${Date.now()}`);

    if (!body.amountKobo || !body.customerEmail) {
      return reply.code(400).send({
        error: 'Missing required checkout fields: amountKobo, customerEmail',
      });
    }

    try {
      const adapter = getBankingRailAdapter();
      if (!adapter.createCheckoutOrder) {
        return reply.code(501).send({
          error: `Active banking rail (${adapter.name}) does not support hosted checkout`,
        });
      }

      const result = await adapter.createCheckoutOrder({
        orderReference,
        amountKobo: Math.round(Number(body.amountKobo)),
        customerEmail: body.customerEmail,
        callbackUrl: body.callbackUrl,
        allowedPaymentMethods: body.allowedPaymentMethods || ['Transfer', 'USSD'],
      });

      return reply.code(200).send({
        success: true,
        data: {
          provider: adapter.name,
          checkoutLink: result.checkoutLink,
          orderReference: result.orderReference,
          allowedPaymentMethods: result.allowedPaymentMethods,
          agreementId: body.agreementId || null,
        },
      });
    } catch (err: any) {
      console.error('[internal-banking-rail] createCheckoutOrder failed:', err.message);
      return reply.code(500).send({
        success: false,
        error: `Checkout order generation failed: ${err.message}`,
      });
    }
  };
  app.post('/api/payment/internal/checkout', handleCheckout);
  app.post('/internal/checkout', handleCheckout);
}

