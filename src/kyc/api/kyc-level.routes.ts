import type { FastifyInstance } from 'fastify';
import { parseBody } from '../../shared/validation.js';
import { bvnInfoMatchSchema, completeNgnBvnConsent, getNgnKycProviderHealth, ninInfoMatchSchema, verifyNgnBvnIdentity, verifyNgnNinIdentity } from '../service/ngn-kyc-level.service.js';

export async function kycLevelRoutes(app: FastifyInstance) {
  app.get('/api/admin/kyc/ngn/provider-health', async () => ({ data: await getNgnKycProviderHealth() }));

  app.post('/api/users/:userId/kyc/ngn-bvn/verify', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(bvnInfoMatchSchema, request.body);
    return { data: await verifyNgnBvnIdentity(userId, body) };
  });

  /**
   * Verify a NIN. THE SECOND ROUTE TO LEVEL 2, not a higher level.
   *
   * The ladder already documents IDENTITY as "NIN and/or BVN validated against
   * the national source" and names the action 'nin_bvn'. Until now BVN was the
   * only implementation, which meant a user unwilling to share a BVN - a
   * reasonable position, since it links every bank account they own - had no
   * way to verify at all.
   *
   * Synchronous, unlike the Flutterwave BVN consent flow: there is no NIMC
   * approval page, so this settles in one call and needs no /complete twin.
   */
  app.post('/api/users/:userId/kyc/ngn-nin/verify', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(ninInfoMatchSchema, request.body);
    return { data: await verifyNgnNinIdentity(userId, body) };
  });

  /**
   * FINISH a consent-based BVN check. The other half of /verify.
   *
   * Flutterwave's flow is asynchronous by regulation - the CBN requires the
   * BVN owner to approve on a NIBSS page - so /verify can only ever return
   * 'review' plus a consent URL. Without this route the customer approved and
   * nothing ever collected the result: the row stayed at 'review' and they
   * stayed at Level 1. The provider method to do it existed and had no caller.
   *
   * POST, not GET, because it settles a verification and writes a row - a GET
   * would be prefetchable by a browser and retried by intermediaries.
   *
   * Takes NO BODY. The provider reference comes from the user's own stored
   * pending row, so nobody can complete another person's consent by supplying
   * a reference they happened to see in a redirect URL.
   */
  app.post('/api/users/:userId/kyc/ngn-bvn/complete', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await completeNgnBvnConsent(userId) };
  });
}
