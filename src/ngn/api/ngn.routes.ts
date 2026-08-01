import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { badRequest, forbidden } from '../../shared/errors.js';
import { parseBody } from '../../shared/validation.js';
import { createNgnQuote, createNgnQuoteSchema, listNgnQuotes } from '../service/ngn-quotes.service.js';
import { acceptNgnQuote, acceptNgnQuoteSchema, listNgnTransfers, retryNgnTransfer } from '../service/ngn-transfers.service.js';
import { getNgnControls, updateNgnControls, updateNgnControlsSchema } from '../service/ngn-controls.service.js';
import {
  getVerificationLimitMatrix,
  setVerificationLimit,
  setVerificationLimitSchema,
  clearVerificationLimit,
  clearVerificationLimitSchema,
} from '../../kyc/service/verification-limits.service.js';
import { getNgnProvider } from '../provider/ngn-provider-registry.js';
import { PajNgnProvider } from '../provider/paj.provider.js';
import { getNgnReconciliationSummary } from '../service/ngn-reconciliation.service.js';
import { listNgnSettlementQueue } from '../service/ngn-settlement.service.js';
import { listNgnWebhooks, recordNgnWebhook } from '../service/ngn-webhooks.service.js';

function ensureOwnUser(request: any, userId: string) {
  const authUserId = request.authUser?.sub;
  if (authUserId && authUserId !== userId) {
    throw forbidden('You cannot access another user account');
  }
}

export async function ngnRoutes(app: FastifyInstance) {
  app.get('/api/ngn/quote', async (request) => {
    const query = createNgnQuoteSchema.parse(request.query ?? {});
    ensureOwnUser(request, query.userId);
    return { data: await createNgnQuote(query) };
  });

  app.post('/api/ngn/onramp/orders', async (request) => {
    const body = parseBody(acceptNgnQuoteSchema, request.body);
    ensureOwnUser(request, body.userId);
    return { data: await acceptNgnQuote(body) };
  });

  app.post('/api/ngn/offramp/orders', async (request) => {
    const body = parseBody(acceptNgnQuoteSchema, request.body);
    ensureOwnUser(request, body.userId);
    return { data: await acceptNgnQuote(body) };
  });

  app.get('/api/users/:userId/ngn-transfers', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listNgnTransfers({ userId }) };
  });


  app.get('/api/ngn/paj/banks', async (request) => {
    const query = request.query as { userId?: string };
    if (query.userId) ensureOwnUser(request, query.userId);
    return { data: await new PajNgnProvider().getBanks() };
  });

  app.get('/api/ngn/paj/bank-account/resolve', async (request) => {
    const query = request.query as { userId?: string; bankId?: string; accountNumber?: string };
    if (query.userId) ensureOwnUser(request, query.userId);
    if (!query.bankId || !query.accountNumber) throw badRequest('bankId and accountNumber are required');
    return { data: await new PajNgnProvider().resolveBankAccount(query.bankId, query.accountNumber) };
  });

  app.get('/api/admin/ngn/paj/banks', async () => ({ data: await new PajNgnProvider().getBanks() }));
  app.get('/api/admin/ngn/paj/bank-account/resolve', async (request) => {
    const query = request.query as { bankId?: string; accountNumber?: string };
    if (!query.bankId || !query.accountNumber) throw badRequest('bankId and accountNumber are required');
    return { data: await new PajNgnProvider().resolveBankAccount(query.bankId, query.accountNumber) };
  });

  app.post('/api/webhooks/paj', async (request) => ({ data: await recordNgnWebhook('paj', request.body, request.headers) }));
  // Breet delivers to its own path so the two providers' secrets and payload
  // shapes never reach the wrong verifier. Breet's verifyWebhook checks the
  // x-webhook-secret header and then re-fetches the transaction from Breet, so
  // a forged amount in the body cannot be credited.
  app.post('/api/webhooks/breet', async (request) => ({ data: await recordNgnWebhook('breet', request.body, request.headers) }));

  app.get('/api/admin/ngn/controls', async () => ({ data: await getNgnControls() }));
  app.put('/api/admin/ngn/controls', async (request) => ({ data: await updateNgnControls(parseBody(updateNgnControlsSchema, request.body)) }));

  /**
   * Verification ceilings, admin-controlled.
   *
   * These were compiled into FLOW_LIMITS and could only be changed by editing
   * code and redeploying. That produced a deadlock worth stating: Breet's live
   * minimum deposit is $50 (~NGN 80,000) while the BANK off-ramp ceiling was
   * NGN 50,000 per 30 days, so a Level 1 user could not clear a single
   * withdrawal.
   *
   * GET returns default, override and effective side by side, because an
   * operator cannot judge a limit without seeing what it was changed from.
   */
  app.get('/api/admin/verification-limits', async () => ({ data: await getVerificationLimitMatrix() }));

  app.put('/api/admin/verification-limits', async (request) => ({
    data: await setVerificationLimit(parseBody(setVerificationLimitSchema, request.body)),
  }));

  /** Remove an override and fall back to the shipped default. */
  app.delete('/api/admin/verification-limits', async (request) => ({
    data: await clearVerificationLimit(parseBody(clearVerificationLimitSchema, request.body)),
  }));
  app.get('/api/admin/ngn/quotes', async (request) => {
    const query = request.query as { userId?: string };
    return { data: await listNgnQuotes({ userId: query.userId }) };
  });
  app.get('/api/admin/ngn/transfers', async (request) => {
    const query = request.query as { userId?: string; status?: string };
    return { data: await listNgnTransfers(query) };
  });
  app.get('/api/admin/ngn/settlement-queue', async () => ({ data: await listNgnSettlementQueue() }));
  app.get('/api/admin/ngn/webhooks', async () => ({ data: await listNgnWebhooks() }));
  app.get('/api/admin/ngn/reconciliation', async () => ({ data: await getNgnReconciliationSummary() }));
  app.get('/api/admin/ngn/provider-health', async () => {
    const controls = await getNgnControls();
    const active = getNgnProvider(controls.activeProvider);
    const backup = controls.backupProvider ? getNgnProvider(controls.backupProvider) : null;
    return { data: { active: await active.health(), backup: backup ? await backup.health() : null, controls } };
  });
  app.post('/api/admin/ngn/transfers/:id/retry', async (request) => {
    const { id } = request.params as { id: string };
    return { data: await retryNgnTransfer(id, (request as any).adminActor?.email || 'admin_api_key') };
  });
  app.post('/api/admin/ngn/webhooks/:provider', async (request) => {
    const { provider } = request.params as { provider: 'mock' | 'linkio' | 'eversend' | 'nomba' | 'paj' };
    return { data: await recordNgnWebhook(provider, request.body, request.headers) };
  });
}
