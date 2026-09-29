import type { FastifyInstance } from 'fastify';
import { forbidden, notFound, badRequest } from '../../shared/errors.js';
import { parseBody } from '../../shared/validation.js';
import { listGhsBanks, resolveGhsBankAccount } from '../service/ghs-banks.service.js';
import {
  saveGhsPayoutAccount,
  saveGhsPayoutAccountSchema,
  listGhsPayoutAccounts,
} from '../service/ghs-payout-accounts.service.js';
import { createGhsQuote, createGhsQuoteSchema, listGhsQuotes } from '../service/ghs-quotes.service.js';
import {
  acceptGhsQuote,
  acceptGhsQuoteSchema,
  listGhsTransfers,
  findGhsTransferById,
} from '../service/ghs-transfers.service.js';

function ensureOwnUser(request: any, userId: string) {
  const authUserId = request.authUser?.sub;
  if (authUserId && authUserId !== userId) {
    throw forbidden('You cannot access another user account');
  }
}

export async function ghsRoutes(app: FastifyInstance) {
  /**
   * List all verified Ghanaian financial institutions (MoMo networks & commercial banks).
   */
  app.get('/api/ghs/banks', async (request) => {
    const query = (request.query || {}) as { userId?: string };
    if (query.userId) ensureOwnUser(request, query.userId);
    return { data: await listGhsBanks() };
  });

  /**
   * Resolve a Ghana Mobile Money number or bank account to registered Ghana Card name.
   */
  app.get('/api/ghs/bank-account/resolve', async (request) => {
    const query = (request.query || {}) as {
      userId?: string;
      bankId?: string;
      accountNumber?: string;
    };
    if (query.userId) ensureOwnUser(request, query.userId);
    if (!query.bankId || !query.accountNumber) {
      throw badRequest('bankId and accountNumber are required');
    }
    return { data: await resolveGhsBankAccount(query.bankId, query.accountNumber) };
  });

  /**
   * Save a verified Ghana payout account, matching the bank-resolved name against profile name.
   */
  app.post('/api/ghs/payout-accounts', async (request, reply) => {
    const body = parseBody(saveGhsPayoutAccountSchema, request.body);
    ensureOwnUser(request, body.userId);
    const result = await saveGhsPayoutAccount(body);
    return reply.code(201).send({ data: result });
  });

  /**
   * List saved Ghana payout accounts for the authenticated user.
   */
  app.get('/api/ghs/payout-accounts', async (request) => {
    const query = (request.query || {}) as { userId?: string };
    if (!query.userId) throw badRequest('userId is required');
    ensureOwnUser(request, query.userId);
    return { data: await listGhsPayoutAccounts(query.userId) };
  });

  /**
   * Generate a conversion quote for GHS offramp or onramp.
   */
  app.get('/api/ghs/quote', async (request) => {
    const query = createGhsQuoteSchema.parse(request.query ?? {});
    ensureOwnUser(request, query.userId);
    return { data: await createGhsQuote(query) };
  });

  /**
   * Create an offramp order to cash out crypto into Ghana MoMo or bank account.
   */
  app.post('/api/ghs/offramp/orders', async (request) => {
    const body = parseBody(acceptGhsQuoteSchema, request.body);
    ensureOwnUser(request, body.userId);
    return { data: await acceptGhsQuote(body) };
  });

  /**
   * List GHS offramp orders for a user.
   */
  app.get('/api/ghs/offramp/orders', async (request) => {
    const query = (request.query || {}) as { userId?: string };
    if (query.userId) ensureOwnUser(request, query.userId);
    return { data: await listGhsTransfers({ userId: query.userId }) };
  });

  /**
   * Get specific GHS offramp order by ID.
   */
  app.get('/api/ghs/offramp/orders/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const order = await findGhsTransferById(id);
    if (!order) {
      return reply.status(404).send({ error: 'ORDER_NOT_FOUND', message: `Order ${id} not found`, statusCode: 404 });
    }
    ensureOwnUser(request, order.userId);
    return { data: order };
  });
}
