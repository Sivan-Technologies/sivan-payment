import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PostgresBuyOrderStore, type BuyOrderStore, type BuyResult } from '../service/textile-buy-store.js';

class ProviderError extends Error {
  constructor(public statusCode: number, public body: Record<string, unknown>) {
    super('Provider request failed');
  }
}

// Preserve actionable errors, never echo arbitrary upstream bodies (proofs or credentials).
function providerError(body: any) {
  const input = body?.error;
  const result: Record<string, unknown> = {};
  for (const key of ['code', 'message', 'expectedTargetAmount', 'actualTargetAmount', 'rateLabel', 'feeLabel', 'providerRecipientId']) {
    if (typeof input?.[key] === 'string') result[key] = input[key].slice(0, 1000);
  }
  if (!result.message) result.message = 'Textile request failed. Please check the purchase status before retrying.';
  if (input?.details && typeof input.details.reason === 'string') result.details = { reason: input.details.reason.slice(0, 500) };
  if (input?.kyc && typeof input.kyc === 'object') {
    result.kyc = Object.fromEntries(['state', 'providerStatus', 'rejectionReasons', 'requirementsDue', 'canDeposit', 'level', 'maxBuy'].filter(key => key in input.kyc).map(key => [key, input.kyc[key]]));
  }
  return result;
}

const identity = z.object({
  provider: z.string().min(1).max(64),
  wallet: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  chainId: z.number().int().positive(),
  proof: z.object({ nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/), issuedAt: z.number().int().positive(), signature: z.string().regex(/^0x[0-9a-fA-F]+$/) }),
});
const image = z.string().min(1).max(5592500);
const orderResult = z.object({
  transfer: z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/), status: z.string().min(1) }).passthrough(),
  claimToken: z.string().min(1).max(2048),
});
const schemas = {
  register: identity.extend({ acceptedTerms: z.literal(true), firstName: z.string().min(1), lastName: z.string().min(1), email: z.string().email(), phone: z.string().min(1), birthDate: z.string().regex(/^\d{2}-\d{2}-\d{4}$/), address: z.object({ line1: z.string().min(1), line2: z.string().optional(), city: z.string().min(1), state: z.string().min(1), postalCode: z.string().min(1) }) }),
  status: identity.extend({ fiat: z.literal('NGN').optional() }),
  submit: identity.extend({ document: z.object({ type: z.enum(['passport', 'national-id', 'drivers-license']), number: z.string().min(1), expiryDate: z.string().optional(), imageFront: image, imageBack: image.optional() }), selfieImage: image }),
  link: identity,
};

export async function textileBuyRoutes(parent: FastifyInstance, store: BuyOrderStore = new PostgresBuyOrderStore()) {
  // Error handling is scoped to this feature, not the existing payment routes.
  await parent.register(async app => {
  app.addHook('onClose', async () => store.close());
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'invalid_input', message: 'Please check the submitted fields.', details: error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code, message: issue.message })) } });
    if (error instanceof ProviderError) return reply.code(error.statusCode).send({ error: error.body });
    const code = Number((error as any).statusCode);
    const status = Number.isInteger(code) && code >= 400 && code <= 599 ? code : 503;
    return reply.code(status).send({ error: { code: 'buy_request_failed', message: status < 500 && error instanceof Error ? error.message : 'The purchase could not be checked or saved. Reopen Buy cNGN to recover the same attempt before retrying.' } });
  });
  async function upstream(path: string, body?: unknown, claim?: string) {
    const configured = process.env.TEXTILE_CREDIT_API_URL;
    if (!configured) throw Object.assign(new Error('Textile API is not configured'), { statusCode: 503 });
    const base = configured.replace(/\/+$/, '').replace(/\/ramp$/, '');
    const url = new URL(base);
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw Object.assign(new Error('Invalid Textile API configuration'), { statusCode: 503 });
    let response: Response;
    try { response = await fetch(`${base}/ramp${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(claim ? { 'X-Ramp-Claim': claim } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      redirect: 'error',
    }); } catch {
      throw new ProviderError(504, { code: 'provider_unreachable', message: 'Provider response unavailable. Check or retry the same purchase reference; do not start another payment.' });
    }
    let data: any;
    try { data = await response.json(); } catch { throw new ProviderError(502, { code: 'invalid_provider_response', message: 'Provider response could not be read. Recover the same purchase before retrying.' }); }
    if (!response.ok) throw new ProviderError(response.status, providerError(data));
    return data;
  }
  app.post('/api/v1/buy-cngn/orders/recover', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const owner = identity.omit({ provider: true }).parse(request.body);
    const orders = await store.list(owner);
    // Never return local claim tokens until Textile verifies ownership for each provider.
    // Recovery does not depend on the corridor currently accepting new purchases.
    for (const provider of new Set(orders.map(order => order.provider))) {
      await upstream('/customers/kyc/status', { ...owner, provider });
    }
    return { orders };
  });
  app.get('/api/v1/buy-cngn/providers', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const query = z.object({ chainId: z.coerce.number().int().positive() }).parse(request.query);
    return upstream(`/providers?fiat=NGN&token=CNGN&side=buy&chainId=${query.chainId}`);
  });
  for (const [action, schema] of Object.entries(schemas)) {
    const paths: Record<string, string> = { register: '/customers', status: '/customers/kyc/status', submit: '/customers/kyc', link: '/customers/kyc/link' };
    app.post(`/api/v1/cashout/kyc/${action}`, { bodyLimit: 18 * 1024 * 1024 }, async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      return upstream(paths[action], schema.parse(request.body));
    });
  }
  app.post('/api/v1/buy-cngn/orders', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const body = identity.extend({ amount: z.string().regex(/^\d+(\.\d{1,2})?$/).refine(value => Number(value) > 0), intentKey: z.string().regex(/^[A-Za-z0-9_-]{12,64}$/), acceptedTerms: z.literal(true) }).parse(request.body);
    const capability = await upstream(`/providers?fiat=NGN&token=CNGN&side=buy&chainId=${body.chainId}`);
    if (!capability.providers?.some((provider: any) => provider.provider === body.provider && provider.chainIds?.includes(body.chainId) && provider.sides?.includes('buy'))) {
      return reply.code(422).send({ error: 'Buy cNGN is unavailable on this network.' });
    }
    const review = await upstream('/customers/kyc/status', { ...identity.parse(body), fiat: 'NGN' });
    if (review.kyc?.state !== 'verified' || review.kyc?.canDeposit !== true) {
      return reply.code(422).send({ error: { code: 'kyc_required', message: 'Identity verification is required before buying.', kyc: review.kyc }, kyc: review.kyc });
    }
    return store.create(body, async () => {
      const result = await upstream('/transfers', { ...body, side: 'buy', fiat: 'NGN', token: 'CNGN' });
      const validated = orderResult.safeParse(result);
      if (!validated.success) {
        throw new ProviderError(502, { code: 'invalid_order_response', message: 'Order confirmation is incomplete. Recover and retry the same purchase reference.' });
      }
      return validated.data as BuyResult;
    });
  });
  app.get('/api/v1/buy-cngn/orders/:id', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const { id } = z.object({ id: z.string().regex(/^[A-Za-z0-9_-]+$/) }).parse(request.params);
    const claim = z.string().min(1).max(2048).parse(request.headers['x-ramp-claim']);
    return upstream(`/transfers/${id}`, undefined, claim);
  });
  });
}
