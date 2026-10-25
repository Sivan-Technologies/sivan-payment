/**
 * SIVAN PAYSTACK UTILITY ROUTES
 *
 * Fastify endpoints for:
 * - Airtime topup
 * - Mobile data bundles
 * - Electricity meter inquiry (pre-flight customer lookup)
 * - Electricity bill payment & token issuance
 * - User NGN spendable balance lookup
 */

import { getProviderFloatBalances } from '../provider/utility-registry.js';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { badRequest } from '../../shared/errors.js';
import {
  executeAirtimePurchase,
  executeDataPurchase,
  executeElectricityInquiry,
  executeElectricityPayment,
  getUserNgnBalance,
  fetchDataPlans,
} from '../service/sivanUtilityService.js';
import {
  getAirtimeConversionRate,
  initiateAirtimeCashConversion,
  confirmAirtimeCashConversion,
  cashoutAirtimeToBank,
  initiateAirtimeCashSchema,
  confirmAirtimeCashSchema,
  cashoutAirtimeCashSchema,
} from '../service/airtime-cash.service.js';
import {
  getUtilityDataPlans,
  getProviderPlanCatalogue,
  updateUtilityDataPlans,
  deleteUtilityDataPlan,
  getActiveUtilityProviderInfo,
  setUtilityProvider,
  updateDataPlanSchema,
  updateDataPlansBatchSchema,
  updateUtilityProviderSchema,
} from '../service/utility-data-plans.service.js';
import type { TelcoOperator, DiscoCode, MeterType } from '../types/paystackUtilityTypes.js';
import { requireIdentityServiceSecret } from '../../shared/service-auth.js';
import { verifyPinForUserId, hasWithdrawalPin } from '../../identity/withdrawal-pin.service.js';
import {
  getUtilityRoutingInfo,
  setUtilityRoutingConfig,
  updateUtilityRoutingSchema,
} from '../service/utility-routing.service.js';

/**
 * Which provider fulfils a purchase is an operational decision, not a
 * customer one. These schemas deliberately omit providerName: it used to be
 * accepted from the request body, so a caller could pick their own rail and,
 * on endpoints with no authentication, steer traffic at will. Routing now
 * comes from the persisted per-service map. The admin endpoints below are the
 * only way to change it.
 */
const airtimeSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  phone: z.string().min(10, 'phone is required'),
  amountNgn: z.number().int().min(100, 'Minimum airtime is 100 NGN').max(50000, 'Maximum airtime is 50,000 NGN'),
  operator: z.enum(['mtn', 'airtel', 'glo', '9mobile']).optional(),
  pin: z.string().min(4, 'Invalid PIN').max(12, 'Invalid PIN').optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const dataSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  phone: z.string().min(10, 'phone is required'),
  planCode: z.string().min(1, 'planCode is required'),
  amountNgn: z.number().int().min(100, 'Minimum amount is 100 NGN'),
  operator: z.enum(['mtn', 'airtel', 'glo', '9mobile']).optional(),
  pin: z.string().min(4, 'Invalid PIN').max(12, 'Invalid PIN').optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const electricityInquirySchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  meterNumber: z.string().min(6, 'Valid meter number is required'),
  disco: z.enum([
    'ikeja',
    'eko',
    'abuja',
    'ibadan',
    'enugu',
    'kano',
    'port-harcourt',
    'benin',
    'jos',
    'kaduna',
    'yola',
  ]),
  meterType: z.enum(['prepaid', 'postpaid']).default('prepaid'),
});

const electricityPaymentSchema = z.object({
  userId: z.string().min(1, 'userId is required'),
  meterNumber: z.string().min(6, 'Valid meter number is required'),
  disco: z.enum([
    'ikeja',
    'eko',
    'abuja',
    'ibadan',
    'enugu',
    'kano',
    'port-harcourt',
    'benin',
    'jos',
    'kaduna',
    'yola',
  ]),
  meterType: z.enum(['prepaid', 'postpaid']).default('prepaid'),
  amountNgn: z.number().int().min(1000, 'Minimum electricity recharge is 1,000 NGN'),
  customerName: z.string().optional(),
  pin: z.string().min(4, 'Invalid PIN').max(12, 'Invalid PIN').optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

/**
 * Authenticates the CALLER (a bot or the web backend), not the person.
 *
 * Every /api/ngn/utility route is exempt from user-JWT auth in app.ts because
 * a WhatsApp thread has no user session to produce a token. That exemption was
 * never paired with a service-secret check here, so the entire namespace -
 * including the endpoints that spend a user's balance - was reachable
 * anonymously from the internet. app.ts:770-782 states the rule this violated:
 * nothing that moves money may be exempted without the handler checking the
 * service secret itself.
 */
function requireServiceCaller(request: FastifyRequest): void {
  requireIdentityServiceSecret(request as unknown as { headers: Record<string, unknown> });
}

/**
 * Authenticates the PERSON, for anything that spends their balance.
 *
 * The service secret proves the request came from our own bot; it cannot show
 * that the account holder intended to spend. verifyPinForUserId carries its own
 * attempt counter and lockout, so brute force is handled there.
 */
async function requireSpendAuthorization(
  request: FastifyRequest,
  userId: string,
  pin?: string
): Promise<void> {
  requireServiceCaller(request);

  if (pin) {
    await verifyPinForUserId(userId, pin, { ipAddress: request.ip });
    return;
  }

  /**
   * Same contract as assertWithdrawalAuthorised, so the chat bots' existing
   * PIN flow router handles these without new client code. The two cases are
   * told apart on purpose: someone who has never set a PIN needs Settings,
   * someone who has one just needs to be asked for it.
   */
  const configured = await hasWithdrawalPin(userId);
  throw badRequest(
    configured
      ? 'Enter your Sivan PIN to approve this purchase.'
      : 'Set a Sivan PIN before buying airtime, data or electricity.',
    { code: configured ? 'PIN_REQUIRED' : 'PIN_NOT_SET' }
  );
}

export async function paystackUtilityRoutes(app: FastifyInstance) {
  /**
   * GET /api/ngn/utility/balance/:userId
   * Spendable NGN balance check for a user.
   */
  app.get(
    '/api/ngn/utility/balance/:userId',
    async (request: FastifyRequest<{ Params: { userId: string } }>, reply: FastifyReply) => {
      // Any user's balance was readable by anyone who knew their id.
      requireServiceCaller(request);
      const { userId } = request.params;
      if (!userId || !userId.trim()) {
        throw badRequest('userId is required');
      }

      const balance = await getUserNgnBalance(userId);
      return reply.code(200).send({
        status: 'success',
        data: {
          userId,
          currency: 'NGN',
          spendableBalanceNgn: balance,
        },
      });
    }
  );

  /**
   * POST /api/ngn/utility/airtime
   * Purchases telco airtime and atomically debits user balance.
   */
  app.post('/api/ngn/utility/airtime', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(airtimeSchema, request.body);
    await requireSpendAuthorization(request, body.userId, body.pin);
    const idempotencyKey =
      body.idempotencyKey ||
      (request.headers['x-idempotency-key'] as string | undefined) ||
      (request.headers['idempotency-key'] as string | undefined);
    const receipt = await executeAirtimePurchase({
      userId: body.userId,
      phone: body.phone,
      amountNgn: body.amountNgn,
      operator: body.operator as TelcoOperator | undefined,
      idempotencyKey,
    });

    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });

  /**
   * POST /api/ngn/utility/data
   * Purchases telco data bundle and atomically debits user balance.
   */
  app.post('/api/ngn/utility/data', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(dataSchema, request.body);
    await requireSpendAuthorization(request, body.userId, body.pin);
    const idempotencyKey =
      body.idempotencyKey ||
      (request.headers['x-idempotency-key'] as string | undefined) ||
      (request.headers['idempotency-key'] as string | undefined);
    const receipt = await executeDataPurchase({
      userId: body.userId,
      phone: body.phone,
      planCode: body.planCode,
      amountNgn: body.amountNgn,
      operator: body.operator as TelcoOperator | undefined,
      idempotencyKey,
    });

    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });

  /**
   * POST /api/ngn/utility/electricity/inquire
   * Pre-flight inquiry: retrieves registered customer name for the meter.
   */
  app.post('/api/ngn/utility/electricity/inquire', async (request: FastifyRequest, reply: FastifyReply) => {
    requireServiceCaller(request);
    const body = parseBody(electricityInquirySchema, request.body);
    const inquiry = await executeElectricityInquiry({
      userId: body.userId,
      meterNumber: body.meterNumber,
      disco: body.disco as DiscoCode,
      meterType: body.meterType as MeterType,
    });

    return reply.code(200).send({
      status: 'success',
      data: inquiry,
    });
  });

  /**
   * POST /api/ngn/utility/electricity/pay
   * Purchases electricity and issues a 20-digit token for prepaid meters.
   */
  app.post('/api/ngn/utility/electricity/pay', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(electricityPaymentSchema, request.body);
    await requireSpendAuthorization(request, body.userId, body.pin);
    const idempotencyKey =
      body.idempotencyKey ||
      (request.headers['x-idempotency-key'] as string | undefined) ||
      (request.headers['idempotency-key'] as string | undefined);
    const receipt = await executeElectricityPayment({
      userId: body.userId,
      meterNumber: body.meterNumber,
      disco: body.disco as DiscoCode,
      meterType: body.meterType as MeterType,
      amountNgn: body.amountNgn,
      customerName: body.customerName,
      idempotencyKey,
    });

    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });

  /**
   * GET /api/ngn/utility/data/plans
   * Fetches available data bundles across plug-and-play aggregator providers.
   */
  app.get(
    '/api/ngn/utility/data/plans',
    async (
      request: FastifyRequest<{ Querystring: { operator: TelcoOperator; providerName?: string } }>,
      reply: FastifyReply
    ) => {
      const { operator, providerName } = request.query;
      if (!operator || !['mtn', 'airtel', 'glo', '9mobile'].includes(operator)) {
        throw badRequest('Valid operator (mtn, airtel, glo, 9mobile) is required in query params');
      }

      const plans = await fetchDataPlans(operator, providerName);
      return reply.code(200).send({
        status: 'success',
        data: {
          operator,
          plans,
        },
      });
    }
  );

  /**
   * GET /api/ngn/utility/airtime-cash/rates
   * Fetches current conversion rate for turning airtime into cash.
   */
  app.get(
    '/api/ngn/utility/airtime-cash/rates',
    async (
      request: FastifyRequest<{ Querystring: { operator: TelcoOperator; providerName?: string } }>,
      reply: FastifyReply
    ) => {
      const { operator, providerName } = request.query;
      if (!operator || !['mtn', 'airtel', 'glo', '9mobile'].includes(operator)) {
        throw badRequest('Valid operator (mtn, airtel, glo, 9mobile) is required in query params');
      }

      const rate = await getAirtimeConversionRate(operator, providerName);
      return reply.code(200).send({
        status: 'success',
        data: rate,
      });
    }
  );

  /**
   * POST /api/ngn/utility/airtime-cash/initiate
   * Quotes conversion and creates an airtime-to-cash session.
   */
  app.post('/api/ngn/utility/airtime-cash/initiate', async (request: FastifyRequest, reply: FastifyReply) => {
    requireServiceCaller(request);
    const body = parseBody(initiateAirtimeCashSchema, request.body);
    const session = await initiateAirtimeCashConversion(body);
    return reply.code(200).send({
      status: 'success',
      data: session,
    });
  });

  /**
   * POST /api/ngn/utility/airtime-cash/confirm
   * Confirms airtime transfer and credits the user's NGN ledger balance.
   */
  app.post('/api/ngn/utility/airtime-cash/confirm', async (request: FastifyRequest, reply: FastifyReply) => {
    requireServiceCaller(request);
    const body = parseBody(confirmAirtimeCashSchema, request.body);
    const receipt = await confirmAirtimeCashConversion(body);
    return reply.code(200).send({
      status: 'success',
      data: receipt,
    });
  });

  /**
   * POST /api/ngn/utility/airtime-cash/cashout
   * Cashes out NGN balance to Nigerian bank with strict verified name matching anti-fraud check.
   */
  app.post('/api/ngn/utility/airtime-cash/cashout', async (request: FastifyRequest, reply: FastifyReply) => {
    requireServiceCaller(request);
    const body = parseBody(cashoutAirtimeCashSchema, request.body);
    const payout = await cashoutAirtimeToBank(body);
    return reply.code(200).send({
      status: 'success',
      data: payout,
    });
  });

  /**
   * GET /api/utilities/data/plans (and alias /api/ngn/utility/data-plans)
   * Public/Bot endpoint: read-only active data bundle tiers and retail rates with sub-millisecond caching.
   */
  const getDataPlansHandler = async (
    request: FastifyRequest<{ Querystring: { network?: string } }>,
    reply: FastifyReply
  ) => {
    const { network } = request.query;
    const plans = await getUtilityDataPlans({ activeOnly: true, network });
    const providerInfo = await getActiveUtilityProviderInfo();
    return reply.code(200).send({
      status: 'success',
      data: {
        plans,
        activeProvider: providerInfo.activeProvider,
      },
    });
  };

  app.get('/api/utilities/data/plans', getDataPlansHandler);
  app.get('/api/ngn/utility/data-plans', getDataPlansHandler);

  /**
   * GET /api/admin/utilities/data-plans
   * Admin endpoint: fetch all bundle tiers and prices.
   */
  app.get('/api/admin/utilities/data-plans', async (_request: FastifyRequest, reply: FastifyReply) => {
    const plans = await getUtilityDataPlans();
    const providerInfo = await getActiveUtilityProviderInfo();
    return reply.code(200).send({
      status: 'success',
      data: {
        plans,
        activeProvider: providerInfo.activeProvider,
        availableProviders: providerInfo.availableProviders,
      },
    });
  });

  /**
   * PUT /api/admin/utilities/data-plans
   * Admin endpoint: update price for any bundle size with audit trail.
   * Supports updating a single plan object or a batch of plans (with full list sync).
   */
  app.put('/api/admin/utilities/data-plans', async (request: FastifyRequest, reply: FastifyReply) => {
    const body: any = request.body;
    let updatedPlans;
    if (body && Array.isArray(body.plans)) {
      const parsedBatch = parseBody(updateDataPlansBatchSchema, body);
      updatedPlans = await updateUtilityDataPlans(parsedBatch.plans, parsedBatch.updatedBy, { replaceAll: true });
    } else {
      const parsedSingle = parseBody(updateDataPlanSchema, body);
      updatedPlans = await updateUtilityDataPlans([parsedSingle], parsedSingle.updatedBy);
    }
    return reply.code(200).send({
      status: 'success',
      data: {
        plans: updatedPlans,
      },
    });
  });

  /**
   * DELETE /api/admin/utilities/data-plans/:target
   * Admin endpoint: removes a bundle plan tier by bundle size or plan id.
   */
  app.delete(
    '/api/admin/utilities/data-plans/:target',
    async (
      request: FastifyRequest<{ Params: { target: string }; Querystring: { network?: string } }>,
      reply: FastifyReply
    ) => {
      const { target } = request.params;
      const { network } = request.query;
      const remainingPlans = await deleteUtilityDataPlan(target, network || 'all');
      return reply.code(200).send({
        status: 'success',
        data: {
          plans: remainingPlans,
          deletedTarget: target,
        },
      });
    }
  );

  /**
   * GET /api/admin/utilities/provider
   * Admin endpoint: retrieves the currently active utility fulfillment provider.
   */
  app.get('/api/admin/utilities/provider', async (_request: FastifyRequest, reply: FastifyReply) => {
    const info = await getActiveUtilityProviderInfo();
    return reply.code(200).send({
      status: 'success',
      data: info,
    });
  });

  /**
   * PUT /api/admin/utilities/provider
   * Admin endpoint: switches active utility provider (e.g. 'paystack' or 'vtu_ng') with audit trail.
   */
  app.put('/api/admin/utilities/provider', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(updateUtilityProviderSchema, request.body);
    const result = await setUtilityProvider(body.provider, body.updatedBy);
    return reply.code(200).send({
      status: 'success',
      data: result,
    });
  });

  /**
   * GET /api/admin/utilities/provider-catalogue?provider=smeapi&operator=mtn
   * The provider's own live plan list, with the wholesale price that provider
   * actually charges this account. This is what the admin hub prices against,
   * so margins are computed from a real cost rather than a remembered one.
   */
  app.get(
    '/api/admin/utilities/provider-catalogue',
    async (
      request: FastifyRequest<{ Querystring: { provider?: string; operator?: string } }>,
      reply: FastifyReply
    ) => {
      const providerName = (request.query.provider || '').trim();
      const operator = (request.query.operator || '').trim().toLowerCase() as TelcoOperator;
      if (!providerName) {
        return reply.code(400).send({ status: 'error', message: 'provider query parameter is required.' });
      }
      if (!operator) {
        return reply.code(400).send({ status: 'error', message: 'operator query parameter is required.' });
      }
      const catalogue = await getProviderPlanCatalogue(providerName, operator);
      return reply.code(200).send({ status: 'success', data: catalogue });
    }
  );

  /**
   * GET /api/admin/utilities/routing
   * Current per-service routing, the defaults, and which services each
   * registered provider can actually fulfil.
   */
  app.get('/api/admin/utilities/routing', async (_request: FastifyRequest, reply: FastifyReply) => {
    const info = await getUtilityRoutingInfo();
    return reply.code(200).send({ status: 'success', data: info });
  });

  /**
   * GET /api/admin/utilities/float
   *
   * Live wallet balance at each provider that holds one. This is the number
   * that decides whether traffic routed to an aggregator can actually be
   * fulfilled, and until now it existed only as an unused method on one
   * adapter - so the float could run dry with nothing on any screen saying so.
   */
  app.get('/api/admin/utilities/float', async (_request: FastifyRequest, reply: FastifyReply) => {
    const balances = await getProviderFloatBalances();
    return reply.code(200).send({ status: 'success', data: { balances } });
  });

  /**
   * PUT /api/admin/utilities/routing
   * Repoints one or more services at different providers, persisted so the
   * change survives a restart and reaches every instance.
   *
   * Body: { routes?: { airtime?: string[], data?: string[], electricity?: string[] },
   *         failover?: { airtime?: boolean, data?: boolean, electricity?: boolean },
   *         updatedBy?: string }
   *
   * A chain naming a provider that cannot serve that service is rejected.
   */
  app.put('/api/admin/utilities/routing', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = parseBody(updateUtilityRoutingSchema, request.body);
    const routing = await setUtilityRoutingConfig(body, body.updatedBy);
    return reply.code(200).send({ status: 'success', data: { routing } });
  });
}

