import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { parseBody } from '../shared/validation.js';
import { forbidden } from '../shared/errors.js';
import {
  DEFAULT_CHAIN,
  assetsForChain,
  ensureUserWallet,
  getUserWalletWithBalances,
  listUserWallets,
} from './user-wallet.service.js';
import type { WalletChain } from '../database/types.js';

const chainSchema = z.enum(['solana', 'base', 'ethereum']);

const createWalletSchema = z.object({
  chain: chainSchema.default(DEFAULT_CHAIN),
});

/**
 * Defence in depth on ownership.
 *
 * The global preHandler in app.ts already rejects a mismatch between
 * params.userId and the JWT subject. This repeats the check locally so these
 * routes stay safe if that hook is ever narrowed or reordered - deposit
 * addresses leak transaction routing and enable social-engineering, so they
 * should never rely on a single guard.
 */
function assertSelf(request: any, userId: string) {
  const subject = request.authUser?.sub;
  if (subject && subject !== userId) {
    throw forbidden('You can only access your own wallets');
  }
}

export async function walletRoutes(app: FastifyInstance) {
  /**
   * List the caller's wallets, one per chain.
   *
   * `?balances=true` reads live balances from the provider. It is opt-in
   * because Bridge's list endpoint does NOT return balances: each wallet needs
   * its own GET, so N wallets means N upstream calls. The Receive screen asks
   * for them; anything that only needs addresses should not pay that cost.
   */
  app.get('/api/users/:userId/wallets', async (request) => {
    const { userId } = request.params as { userId: string };
    assertSelf(request, userId);
    const { balances } = request.query as { balances?: string };
    const wallets = await listUserWallets(userId);

    if (String(balances).toLowerCase() !== 'true') {
      return {
        data: wallets.map((wallet) => ({
          ...wallet,
          acceptedAssets: assetsForChain(wallet.chain),
        })),
      };
    }

    // One slow or failing chain must not blank the others, so these resolve
    // independently and a failure yields undefined balances rather than an
    // empty array. Undefined means "not loaded"; [] would render as a
    // confirmed zero, which is a different and possibly false claim.
    const withBalances = await Promise.all(
      wallets.map(async (wallet) => {
        const detailed = await getUserWalletWithBalances(userId, wallet.chain).catch(() => null);
        return detailed ?? { ...wallet, acceptedAssets: assetsForChain(wallet.chain) };
      })
    );

    return { data: withBalances };
  });

  /**
   * The caller's wallet for a chain, with live balances read from the
   * provider. Returns null rather than 404 when absent so the UI can render
   * a "generate address" state without treating it as an error.
   */
  app.get('/api/users/:userId/wallets/:chain', async (request) => {
    const { userId, chain } = request.params as { userId: string; chain: string };
    assertSelf(request, userId);
    const parsed = chainSchema.safeParse(chain);
    if (!parsed.success) return { data: null };
    return { data: await getUserWalletWithBalances(userId, parsed.data as WalletChain) };
  });

  /**
   * Create the caller's wallet for a chain, defaulting to Solana.
   * Idempotent: repeat calls return the existing wallet.
   */
  app.post('/api/users/:userId/wallets', async (request) => {
    const { userId } = request.params as { userId: string };
    assertSelf(request, userId);
    const body = parseBody(createWalletSchema, request.body ?? {});
    const wallet = await ensureUserWallet(userId, body.chain as WalletChain);
    return { data: { ...wallet, acceptedAssets: assetsForChain(wallet.chain) } };
  });
}
