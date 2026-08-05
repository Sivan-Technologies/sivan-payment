import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { adminBalanceAdjustmentSchema, balanceTransferControlsSchema, balanceTransferDecisionSchema, createAdminBalanceAdjustment, decideBalanceTransfer, createBalanceTransferSchema, getBalanceTransferControls, getUserBalance, listAllBalanceTransfers, listUserBalanceLedger, listUserBalanceTransfers, requestBalanceTransfer, updateBalanceTransferControls } from './balance.service.js';
import { getUnifiedBalance } from './unified-balance.service.js';
import { quoteTransfer } from './balance.service.js';
import { listUserDeposits } from '../deposits/deposit.service.js';
import { db } from '../database/json-database.js';
import { normalizeWhatsappNumber } from '../identity/identity.service.js';

function actor(request: any) {
  return request.adminActor?.email || request.adminActor?.role || 'admin_api_key';
}

export async function balanceRoutes(app: FastifyInstance) {
  // ─── WhatsApp-authenticated balance endpoint (used by whatsapp-bot) ──────────
  app.get('/api/users/whatsapp-balance', async (request, reply) => {
    const secret = request.headers['x-sivan-identity-link-secret'];
    if (!secret || secret !== process.env.PAYMENT_IDENTITY_LINK_SECRET) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { whatsapp } = request.query as { whatsapp?: string };
    if (!whatsapp) return reply.code(400).send({ error: 'whatsapp query param required' });
    const normalized = normalizeWhatsappNumber(whatsapp);
    const data = await db.read();
    const user = (data.users ?? []).find((u: any) => u.whatsappNumber === normalized);
    if (!user) return reply.code(404).send({ error: 'WhatsApp number not linked to a Sivan Payment account' });
    const balance = await getUserBalance(user.id);
    const usdcEntry = balance.balances.find((b: any) => b.asset === 'usdc') ?? balance.balances[0];
    return {
      data: {
        userId: user.id,
        asset: usdcEntry?.asset ?? 'usdc',
        available: Number(usdcEntry?.available ?? 0),
        pending: Number(usdcEntry?.pending ?? 0),
      }
    };
  });

  // ─── WhatsApp-authenticated payout account gate check (used by whatsapp-bot) ──
  app.get('/api/users/whatsapp-payout-account', async (request, reply) => {
    const secret = request.headers['x-sivan-identity-link-secret'];
    if (!secret || secret !== process.env.PAYMENT_IDENTITY_LINK_SECRET) {
      return reply.code(403).send({ error: 'Forbidden' });
    }
    const { whatsapp } = request.query as { whatsapp?: string };
    if (!whatsapp) return reply.code(400).send({ error: 'whatsapp query param required' });
    const normalized = normalizeWhatsappNumber(whatsapp);
    const data = await db.read();
    const user = (data.users ?? []).find((u: any) => u.whatsappNumber === normalized);
    if (!user) return reply.code(404).send({ error: 'WhatsApp number not linked to a Sivan Payment account' });
    
    const userAccounts = (data.externalAccounts ?? []).filter(
      (acc: any) => acc.userId === user.id && ['active', 'verified', 'created'].includes(acc.status)
    );
    const primaryAccount = userAccounts[0] || null;
    return {
      data: {
        userId: user.id,
        hasVerifiedAccount: Boolean(primaryAccount || (user as any).bankAccount || (user as any).payoutAccount),
        account: primaryAccount ? {
          id: primaryAccount.id,
          bankName: primaryAccount.bankName,
          currency: primaryAccount.currency,
          accountOwnerName: primaryAccount.accountOwnerName,
        } : null,
      }
    };
  });

  app.get('/api/users/:userId/balance', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUserBalance(userId) };
  });

  /**
   * ONE BALANCE, chain + ledger, for every screen that shows a number.
   *
   * /balance above stays for the ledger view (the "deposit, hold and spend
   * trail"), which is genuinely a journal and should keep reading like one.
   * Anything answering "how much do I have" reads THIS.
   */
  app.get('/api/users/:userId/balance/unified', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await getUnifiedBalance(userId) };
  });

  app.get('/api/users/:userId/balance/ledger', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserBalanceLedger(userId) };
  });

  app.get('/api/users/:userId/balance/transfers', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserBalanceTransfers(userId) };
  });

  app.post('/api/users/:userId/balance/transfers', async (request) => {
    const { userId } = request.params as { userId: string };
    const body = parseBody(createBalanceTransferSchema, request.body);
    return { data: await requestBalanceTransfer(userId, body, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  /**
   * Inbound deposits - money arriving from outside Sivan.
   *
   * The seventh source for the unified activity feed. Sits under /balance/
   * alongside the other money endpoints and is authenticated identically, by
   * the same userId path convention every sibling route uses.
   */
  /**
   * What a transfer will cost, before committing to it.
   *
   * A GET so the confirm dialog can ask without side effects. The frontend must
   * NOT recompute the curve: two implementations of a pricing rule is how they
   * come to disagree, and a UI quoting a different fee from the one charged
   * reads to a user as theft. Guarded by test:transfer-fee-policy, which fails
   * if the formula appears in frontend source.
   */
  app.get('/api/balance/transfers/quote', async (request) => {
    const { amount } = request.query as { amount?: string };
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { data: await quoteTransfer(0) };
    }
    return { data: await quoteTransfer(parsed) };
  });

  app.get('/api/users/:userId/balance/deposits', async (request) => {
    const { userId } = request.params as { userId: string };
    return { data: await listUserDeposits(userId) };
  });

  app.get('/api/admin/balance/controls', async () => ({ data: await getBalanceTransferControls() }));

  app.put('/api/admin/balance/controls', async (request) => {
    const body = parseBody(balanceTransferControlsSchema, request.body);
    return { data: await updateBalanceTransferControls({ ...body, updatedBy: actor(request) }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.get('/api/admin/balance/transfers', async () => ({ data: await listAllBalanceTransfers() }));

  /**
   * THE ONLY EXIT FROM THE REVIEW QUEUE. There was none before this.
   *
   * A transfer over the manual-review threshold held the user's funds on the
   * ledger with no route, service function or script anywhere in the codebase
   * able to release or refuse it. Approve broadcasts through the same
   * executeBalanceTransfer the automatic path uses; reject returns the hold.
   */
  app.post('/api/admin/balance/transfers/:transferId/decision', async (request) => {
    const { transferId } = request.params as { transferId: string };
    const body = parseBody(balanceTransferDecisionSchema, request.body);
    return { data: await decideBalanceTransfer(transferId, { ...body, decidedBy: actor(request) }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });

  app.post('/api/admin/balance/adjustments', async (request) => {
    const body = parseBody(adminBalanceAdjustmentSchema, request.body);
    return { data: await createAdminBalanceAdjustment({ ...body, adjustedBy: actor(request) }, { ipAddress: request.ip, userAgent: request.headers['user-agent'] }) };
  });
}
