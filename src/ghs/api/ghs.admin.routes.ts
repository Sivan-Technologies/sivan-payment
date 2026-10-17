import type { FastifyInstance } from 'fastify';
import { badRequest, notFound } from '../../shared/errors.js';
import { db } from '../../database/json-database.js';
import { listGhsTransfers, findGhsTransferById } from '../service/ghs-transfers.service.js';
import { listGhsPayoutAccounts } from '../service/ghs-payout-accounts.service.js';
import type { GhsTransferRecord } from '../../database/types.js';
import { env } from '../../config/env.js';

/**
 * Admin-only GHS endpoints.
 *
 * All routes are protected by the x-admin-api-key guard in app.ts.
 * The RBAC rule mirrors /api/admin/ngn: ops, operator, compliance,
 * finance, and engineering roles are permitted.
 */
export async function ghsAdminRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------------
  // Transfers
  // ------------------------------------------------------------------

  /**
   * List all GHS offramp transfers (admin view, no user scoping).
   * GET /api/admin/ghs/transfers?userId=&status=&limit=&offset=
   */
  app.get('/api/admin/ghs/transfers', async (request) => {
    const query = (request.query || {}) as {
      userId?: string;
      status?: string;
      limit?: string;
      offset?: string;
    };
    const all = await listGhsTransfers({ userId: query.userId || undefined });
    const filtered = query.status ? all.filter((t) => t.status === query.status) : all;
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 100);
    return { data: filtered.slice(offset, offset + limit) };
  });

  /**
   * Get a single GHS transfer by ID.
   * GET /api/admin/ghs/transfers/:id
   */
  app.get('/api/admin/ghs/transfers/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const transfer = await findGhsTransferById(id);
    if (!transfer) {
      return reply.status(404).send({ error: 'GHS_TRANSFER_NOT_FOUND', message: `Transfer ${id} not found` });
    }
    return { data: transfer };
  });

  /**
   * DEVELOPMENT / TEST ONLY — advance a GHS transfer status.
   * POST /api/admin/ghs/transfers/:id/dev-status { status: string }
   *
   * Mirrors /api/admin/ngn/transfers/:id/dev-status.
   * Refused in production and staging.
   */
  app.post('/api/admin/ghs/transfers/:id/dev-status', async (request, reply) => {
    if (env.APP_ENV === 'production' || env.APP_ENV === 'staging') {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Not found' } });
    }
    const { id } = request.params as { id: string };
    const body = request.body as { status?: string };
    const status = String(body?.status ?? '').trim();
    if (!status) throw badRequest('status is required.');

    const all = await db.listGhsTransfers();
    const transfer = all.find((t) => t.id === id);
    if (!transfer) throw notFound('GHS transfer');

    const updated = { ...transfer, status, updatedAt: new Date().toISOString() } as GhsTransferRecord;
    await db.upsertGhsTransferRecord(updated);
    return { data: updated };
  });

  // ------------------------------------------------------------------
  // Payout Accounts
  // ------------------------------------------------------------------

  /**
   * List all GHS payout accounts — optionally filtered by userId or status.
   * GET /api/admin/ghs/payout-accounts?userId=&status=
   */
  app.get('/api/admin/ghs/payout-accounts', async (request) => {
    const query = (request.query || {}) as { userId?: string; status?: string };
    let accounts = query.userId
      ? await listGhsPayoutAccounts(query.userId)
      : await db.listGhsPayoutAccounts();
    if (query.status) {
      accounts = accounts.filter((a) => a.status === query.status);
    }
    return { data: accounts };
  });

  /**
   * Get a single GHS payout account by ID.
   * GET /api/admin/ghs/payout-accounts/:id
   */
  app.get('/api/admin/ghs/payout-accounts/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const account = await db.findGhsPayoutAccountById(id);
    if (!account) {
      return reply.status(404).send({ error: 'GHS_PAYOUT_ACCOUNT_NOT_FOUND', message: `Payout account ${id} not found` });
    }
    return { data: account };
  });

  /**
   * Admin override: approve or reject a GHS payout account that is in pending_review.
   * PUT /api/admin/ghs/payout-accounts/:id/review { decision: 'approved' | 'rejected'; reason?: string }
   */
  app.put('/api/admin/ghs/payout-accounts/:id/review', async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body || {}) as { decision?: string; reason?: string };
    if (!body.decision || !['approved', 'rejected'].includes(body.decision)) {
      throw badRequest('decision must be "approved" or "rejected".');
    }
    const account = await db.findGhsPayoutAccountById(id);
    if (!account) throw notFound('GHS payout account');

    const updated = {
      ...account,
      status: body.decision === 'approved' ? 'verified' : 'rejected',
      reviewReason: body.reason ?? (body.decision === 'approved' ? 'admin_approved' : 'admin_rejected'),
      needsHumanReview: false,
      updatedAt: new Date().toISOString(),
    } as typeof account;

    await db.upsertGhsPayoutAccountRecord(updated);
    return { data: updated };
  });

  // ------------------------------------------------------------------
  // Quotes (read-only view)
  // ------------------------------------------------------------------

  /**
   * List all GHS quotes — optionally filtered by userId.
   * GET /api/admin/ghs/quotes?userId=&limit=&offset=
   */
  app.get('/api/admin/ghs/quotes', async (request) => {
    const query = (request.query || {}) as { userId?: string; limit?: string; offset?: string };
    const all = await db.listGhsQuotes(query.userId || undefined);
    const offset = Number(query.offset ?? 0);
    const limit = Number(query.limit ?? 100);
    return { data: all.slice(offset, offset + limit) };
  });

  // ------------------------------------------------------------------
  // Summary / Dashboard
  // ------------------------------------------------------------------

  /**
   * High-level GHS corridor health dashboard.
   * GET /api/admin/ghs/dashboard
   */
  app.get('/api/admin/ghs/dashboard', async () => {
    const [transfers, accounts, quotes] = await Promise.all([
      db.listGhsTransfers(),
      db.listGhsPayoutAccounts(),
      db.listGhsQuotes(),
    ]);

    const statusCounts = transfers.reduce<Record<string, number>>((acc, t) => {
      acc[t.status] = (acc[t.status] ?? 0) + 1;
      return acc;
    }, {});

    const completedTransfers = transfers.filter((t) => t.status === 'completed');
    const totalGhsVolume = completedTransfers.reduce((sum, t) => sum + Number(t.destinationAmount ?? 0), 0);
    const pendingReviewAccounts = accounts.filter((a) => a.needsHumanReview);

    return {
      data: {
        generatedAt: new Date().toISOString(),
        transfers: {
          total: transfers.length,
          byStatus: statusCounts,
          completedCount: completedTransfers.length,
          totalGhsVolume: totalGhsVolume.toFixed(2),
        },
        payoutAccounts: {
          total: accounts.length,
          verified: accounts.filter((a) => a.status === 'verified').length,
          pendingReview: pendingReviewAccounts.length,
          rejected: accounts.filter((a) => a.status === 'rejected').length,
        },
        quotes: {
          total: quotes.length,
        },
      },
    };
  });
}
