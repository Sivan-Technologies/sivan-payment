import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { NgnAgreementError, type NgnAgreementLedger } from './ledger.js';

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const credential = z.string().min(1).max(4096);
const createBody = z.object({ id, sellerId:id, title:z.string().trim().min(1).max(240),
  principalKobo:z.string().regex(/^[1-9][0-9]{0,14}$/), credential }).strict();
const actionBody = z.object({ credential }).strict();

/** Explicit dependency injection: registered by runtime.ts only when opted in.
 * Funding remains blocked pending the documented operational prerequisites.
 * authenticate must validate a user JWT/delegation and return canonical payment
 * user ID. A bot/service API key plus arbitrary userId is NOT authentication.
 * Register in an encapsulated Fastify plugin to scope the error handler.
 */
export async function ngnBalanceAgreementRoutes(app: FastifyInstance, dependencies: {
  ledger: NgnAgreementLedger;
  authenticate(request: FastifyRequest): Promise<string>;
  fundingEnabled?: () => boolean;
}) {
  const { ledger, authenticate } = dependencies;
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error:'INVALID_REQUEST' });
    if (error instanceof NgnAgreementError) return reply.code(error.statusCode).send({ error:error.code });
    // Never echo database errors, credentials, provider payloads or stack traces.
    return reply.code(503).send({ error:'NGN_AGREEMENT_UNAVAILABLE' });
  });
  async function actor(request: FastifyRequest) {
    const actorId = await authenticate(request);
    if (!actorId) throw new NgnAgreementError('AUTHENTICATION_REQUIRED',401);
    return actorId;
  }
  const root = '/api/ngn/balance-agreements';
  app.get(root,async req => ({ data:await ledger.list(await actor(req)) }));
  app.get(`${root}/balance`,async req => ({ data:await ledger.available(await actor(req)) }));
  app.post(root,async req => {
    const buyerId = await actor(req);
    return { data:await ledger.create({ ...createBody.parse(req.body),buyerId }) };
  });
  app.get(`${root}/:id`,async req => {
    const actorId = await actor(req);
    return { data:await ledger.get(id.parse((req.params as any).id),actorId) };
  });
  const actions = {
    fund:ledger.fund.bind(ledger), accept:ledger.accept.bind(ledger), start:ledger.start.bind(ledger),
    deliver:ledger.deliver.bind(ledger), release:ledger.release.bind(ledger),
    dispute:ledger.dispute.bind(ledger), cancel:ledger.consentCancellation.bind(ledger),
  };
  for (const [action,perform] of Object.entries(actions)) {
    app.post(`${root}/:id/${action}`,async req => {
      const actorId = await actor(req);
      if (action === 'fund' && dependencies.fundingEnabled && !dependencies.fundingEnabled()) {
        throw new NgnAgreementError('NGN_FUNDING_NOT_ENABLED',503);
      }
      const agreementId = id.parse((req.params as any).id);
      const { credential } = actionBody.parse(req.body);
      return { data:await perform(agreementId,actorId,credential) };
    });
  }
  // No client endpoint to credit deposits, authorize rulings, alter eligibility,
  // mark payouts successful, override fee policy or run provider transfers.
}
