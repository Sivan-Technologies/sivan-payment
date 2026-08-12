import type { FastifyInstance } from 'fastify';
import { parseBody } from '../shared/validation.js';
import { adminBalanceAdjustmentSchema, balanceTransferControlsSchema, balanceTransferDecisionSchema, createAdminBalanceAdjustment, decideBalanceTransfer, createBalanceTransferSchema, getBalanceTransferControls, getUserBalance, listAllBalanceTransfers, listUserBalanceLedger, listUserBalanceTransfers, requestBalanceTransfer, updateBalanceTransferControls } from './balance.service.js';
import { getUnifiedBalance } from './unified-balance.service.js';
import { quoteTransfer } from './balance.service.js';
import { recipientNeedsTokenAccount } from '../wallets/solana/spl-transfer.js';
import { resolveNetworkMode } from '../wallets/network-mode.js';
import { listUserDeposits } from '../deposits/deposit.service.js';
import { db } from '../database/json-database.js';
import { normalizeWhatsappNumber, activeLinkForTelegram } from '../identity/identity.service.js';
import { requireIdentityServiceSecret } from '../shared/service-auth.js';

/**
 * Resolve a chat-channel caller to a payment user.
 */
async function findUserByChannelPhone(phone: string) {
  const rawClean = phone.trim().replace(/^whatsapp:\+?/, '').replace(/^\+/, '');
  const normalized = normalizeWhatsappNumber(phone);

  let user = await db.findUserByWhatsappNumber(normalized);
  if (user) return user;

  const identityLinks = await db.listCustomerIdentityLinks();
  const whatsappLink = identityLinks.find(
    (l) => l.status === 'linked' && (l.whatsappNumber === normalized || l.whatsappNumber === `whatsapp:+${rawClean}`)
  );
  if (whatsappLink) {
    user = await db.findUserById(whatsappLink.paymentUserId);
    if (user) return user;
  }

  if (rawClean) {
    user = await db.findUserByTelegramUserId(rawClean);
    if (user) return user;

    const link = await activeLinkForTelegram(rawClean);
    if (link) {
      user = await db.findUserById(link.paymentUserId);
      if (user) return user;
    }
  }

  return user;
}

function actor(request: any) {
  return request.adminActor?.email || request.adminActor?.role || 'admin_api_key';
}

export async function balanceRoutes(app: FastifyInstance) {
  /**
   * Balance for a chat-channel caller. Used by the WhatsApp bot and the
   * Telegram layer.
   *
   * Auth is the shared service-secret guard. The inline check that used to live
   * here compared against `process.env.PAYMENT_IDENTITY_LINK_SECRET` - the
   * variable name the BOTS use. This service names the same secret
   * IDENTITY_LINK_SERVICE_SECRET, so the comparison was against undefined and
   * this route returned 403 to every caller. Balance never worked from chat.
   *
   * Returns BOTH shapes on purpose: a flat `available`/`asset` for callers that
   * read a single spendable figure, and the full `balances[]` array for callers
   * that list every asset. Returning only the flat shape made the Telegram
   * balance card render "Nothing held yet" for users who did hold funds,
   * because it reads `data.balances`.
   *
   * READS THE UNIFIED BALANCE, NOT THE LEDGER. This called getUserBalance,
   * which is the LEDGER journal - and the ledger is credited from exactly two
   * places (Bridge virtual-account settlements and admin adjustments). NOTHING
   * credits it when crypto lands in a user's own wallet, so an on-chain deposit
   * was money the chat channels believed did not exist.
   *
   * The symptom was reported from a live account: the web dashboard showed a
   * funded balance and an NGN withdrawal it would happily quote, while Telegram
   * said "Balance: 0.00 USDC" for the same user - and because the withdraw gate
   * reads this same figure, cash out refused with "there is nothing to
   * withdraw". Two screens disagreeing about someone's money is the worst
   * possible bug in a payments product.
   *
   * unified-balance.service.ts is the single answer to "how much do I have",
   * and the dashboard already reads it via /balance/unified. Pointing chat at
   * it makes every surface agree by construction rather than by coincidence.
   */
  app.get('/api/users/whatsapp-balance', async (request, reply) => {
    requireIdentityServiceSecret(request as any);
    const { whatsapp } = request.query as { whatsapp?: string };
    if (!whatsapp) return reply.code(400).send({ error: 'whatsapp query param required' });
    const user = await findUserByChannelPhone(whatsapp);
    if (!user) return reply.code(404).send({ error: 'WhatsApp number not linked to a Sivan Payment account' });

    const unified = await getUnifiedBalance(user.id);

    /**
     * A FAILED CHAIN READ MUST NOT LEAVE AS A CONFIDENT ZERO.
     *
     * The bots have no field for "we could not check": they read a number and
     * show it. So when the chain is unreadable and the ledger holds nothing,
     * the honest figure is not 0 - it is unknown - and the only way to say so
     * over this wire is to fail. 503 lands in the bots' existing "temporarily
     * unreachable, nothing has changed" branch, which is true and actionable,
     * instead of telling a funded user their balance is empty.
     */
    const unreadable = unified.balances.length
      ? unified.balances.every((b) => b.chainUnavailable && Number(b.credited) === 0)
      : // NO ASSET ROWS AT ALL is the subtler half of the same problem. Rows are
        // built from the chain read plus the ledger, so a wallet whose read
        // failed contributes nothing; if the ledger is also empty, `balances` is
        // `[]` and a length-guarded check would wave it through as zero. Here
        // "empty" is only trustworthy when every wallet actually answered.
        unified.wallets.some((w) => w.balancesUnavailable);
    if (unreadable) {

      return reply.code(503).send({
        error: { message: 'Could not reach the network to read this balance. Nothing has changed.' },
      });
    }

    const usdcEntry = unified.balances.find((b) => b.asset === 'usdc') ?? unified.balances[0];
    return {
      data: {
        userId: user.id,
        asset: usdcEntry?.asset ?? 'usdc',
        // `spendable` is chain + credited - held: what the user may actually
        // move right now, which is the question both bots are really asking.
        available: Number(usdcEntry?.spendable ?? 0),
        pending: Number(usdcEntry?.pending ?? 0),
        balances: unified.balances.map((b) => ({
          asset: b.asset,
          amount: Number(b.spendable),
          available: Number(b.spendable),
          pending: Number(b.pending),
        })),
      }
    };
  });


  /**
   * Does this chat user have somewhere to be paid out to?
   *
   * Same auth correction as the balance route above; cash out reads this first,
   * so the 403 here is what made cash out unusable from chat.
   */
  app.get('/api/users/whatsapp-payout-account', async (request, reply) => {
    requireIdentityServiceSecret(request as any);
    const { whatsapp } = request.query as { whatsapp?: string };
    if (!whatsapp) return reply.code(400).send({ error: 'whatsapp query param required' });
    const user = await findUserByChannelPhone(whatsapp);
    if (!user) return reply.code(404).send({ error: 'Identity not linked to a Sivan Payment account' });

    const ngnAccounts = await db.listNgnPayoutAccounts(user.id);
    const activeNgn = ngnAccounts.find((acc: any) => ['approved', 'verified', 'active'].includes(acc.status)) || ngnAccounts[0];

    if (activeNgn) {
      return {
        data: {
          userId: user.id,
          hasVerifiedAccount: true,
          account: {
            id: activeNgn.id,
            bankName: activeNgn.bankName || 'Bank',
            currency: 'NGN',
            accountName: activeNgn.accountName,
            accountOwnerName: activeNgn.accountName,
            accountNumber: activeNgn.accountNumber,
          }
        }
      };
    }

    const externalAccounts = await db.listExternalAccountsByUser(user.id);
    const primaryAccount = externalAccounts.find((acc: any) => ['active', 'verified', 'created'].includes(acc.status)) || null;

    return {
      data: {
        userId: user.id,
        hasVerifiedAccount: Boolean(primaryAccount || (user as any).bankAccount || (user as any).payoutAccount),
        account: primaryAccount ? {
          id: primaryAccount.id,
          bankName: primaryAccount.bankName,
          currency: primaryAccount.currency,
          accountName: primaryAccount.accountName || primaryAccount.accountOwnerName,
          accountOwnerName: primaryAccount.accountOwnerName,
          accountNumber: primaryAccount.accountLast4,
        } : null,
      }
    };
  });

  /**
   * Auto-link a Nigerian bank payout account for a WhatsApp / Telegram user on the fly.
   */
  app.post('/api/users/whatsapp-payout-account/auto-link', async (request, reply) => {
    requireIdentityServiceSecret(request as any);
    const { whatsapp, bankName, accountNumber } = (request.body ?? {}) as { whatsapp?: string; bankName?: string; accountNumber?: string };
    if (!whatsapp || !bankName || !accountNumber) {
      return reply.code(400).send({ error: 'whatsapp, bankName and accountNumber required' });
    }
    const user = await findUserByChannelPhone(whatsapp);
    if (!user) return reply.code(404).send({ error: 'Identity not linked to a Sivan Payment account' });

    try {
      const { resolveBankId } = await import('../ngn/service/ngn-banks.service.js');
      const bankId = await resolveBankId(bankName);

      const { saveNgnPayoutAccount } = await import('../ngn/service/ngn-payout-accounts.service.js');
      const saved = await saveNgnPayoutAccount({ userId: user.id, bankId, accountNumber: accountNumber.trim() });

      return {
        data: {
          userId: user.id,
          hasVerifiedAccount: true,
          account: {
            id: saved.id,
            bankName: saved.bankName || 'Bank',
            currency: 'NGN',
            accountName: saved.accountName,
            accountOwnerName: saved.accountName,
            accountNumber: saved.accountNumber,
          }
        }
      };
    } catch (err: any) {
      return reply.code(400).send({ error: err.message || 'Unable to resolve or link bank account' });
    }
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
    const { amount, network, asset, destinationAddress } = request.query as {
      amount?: string; network?: string; asset?: string; destinationAddress?: string;
    };
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      return { data: await quoteTransfer(0) };
    }

    /**
     * The new-recipient surcharge needs the DESTINATION, not just the amount.
     *
     * Optional on purpose: the confirm dialog quotes as soon as an amount is
     * typed, before an address may be complete. Without one the quote returns
     * the base fee and the UI says the surcharge "may apply"; with one it is
     * exact. The transfer path re-checks regardless, so a stale or absent
     * quote can never decide what is actually charged.
     */
    const createsRecipientAccount = destinationAddress && String(network).toLowerCase() === 'solana'
      ? await recipientNeedsTokenAccount({
          recipientAddress: String(destinationAddress),
          asset: String(asset ?? 'usdc'),
          production: resolveNetworkMode() === 'mainnet',
        })
      : false;

    return { data: await quoteTransfer(parsed, { createsRecipientAccount }) };
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
