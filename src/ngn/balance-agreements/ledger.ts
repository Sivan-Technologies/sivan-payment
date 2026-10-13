import { createHash } from 'node:crypto';

/** No env loading, network access, provider defaults or in-memory fallback.
 * The runtime must supply a real PostgreSQL transaction and trusted policies.
 * Amounts cross the API boundary as integer-kobo strings, never JS floats.
 */
export interface Sql {
  query(sql: string, params?: any[]): Promise<{ rows: any[] }>;
}
export type Transaction = <T>(run: (sql: Sql) => Promise<T>) => Promise<T>;
export interface Authorization {
  actorId: string;
  action: string;
  agreementId: string;
  amountKobo: string;
  credential: string;
}
export interface Policies {
  // Resolve canonical identities, validate bound authorization and rate limits.
  // Must not trust userIds/eligibility flags supplied by a channel.
  authorize(input: Authorization): Promise<void>;
  sellerEligible(userId: string): Promise<boolean>;
  authorizeRuling(reviewerId: string, agreementId: string, buyerKobo: string, reason: string, credential: string): Promise<void>;
  verifyDeposit(reference: string): Promise<{ userId: string; netKobo: string; currency: 'NGN'; reference: string }>;
}
export class NgnAgreementError extends Error {
  constructor(public code: string, public statusCode = 409) { super(code); }
}
export interface Agreement {
  id: string; buyer_id: string; seller_id: string; title: string;
  principal_kobo: string; fee_kobo: string; fee_bps: number; policy_version: string;
  status: string; accepted_at: string | null; funded_at: string | null;
  started_at: string | null; delivered_at: string | null; expires_at: string; created_at: string;
}
const terminal = new Set(['COMPLETED', 'CANCELLED']);
const userAccount = (userId: string) => `user:${userId}:available`;
const principalAccount = (id: string) => `agreement:${id}:principal`;
const feeAccount = (id: string) => `agreement:${id}:pending_fee`;
const fail = (code: string, status = 409): never => { throw new NgnAgreementError(code, status); };
function identifier(value: string) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) fail('INVALID_IDENTIFIER', 400);
  return value;
}
function amount(value: string, allowZero = false) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,14})$/.test(value)) fail('INVALID_KOBO_AMOUNT', 400);
  const parsed = BigInt(value);
  if (!allowZero && parsed === 0n) fail('INVALID_KOBO_AMOUNT', 400);
  return parsed;
}
function fingerprint(input: unknown) { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }

export class NgnAgreementLedger {
  constructor(private transaction: Transaction, private policies: Policies) {}

  async get(id: string, actorId: string) {
    return this.transaction(async sql => {
      const a = await this.load(sql,id);
      if (![a.buyer_id,a.seller_id].includes(actorId)) fail('PARTICIPANT_REQUIRED',403);
      return a;
    });
  }

  async list(actorId: string) {
    identifier(actorId);
    return this.transaction(async sql => (await sql.query(`SELECT *,principal_kobo::text,fee_kobo::text
      FROM ngn_balance_agreements WHERE buyer_id=$1 OR seller_id=$1 ORDER BY created_at DESC LIMIT 100`, [actorId])).rows as Agreement[]);
  }

  async available(actorId: string) {
    identifier(actorId);
    return this.transaction(async sql => {
      const rows = (await sql.query('SELECT balance_kobo::text FROM ngn_agreement_accounts WHERE id=$1',[userAccount(actorId)])).rows;
      return { currency: 'NGN', availableKobo: rows[0]?.balance_kobo ?? '0' };
    });
  }

  /** Worker entry point: expiration is checked again under the agreement lock.
   * No auto-starting timer or dependency on a web request to refund overdue funds.
   */
  async expireDue() {
    const ids = await this.transaction(async sql => (await sql.query(`SELECT id FROM ngn_balance_agreements
      WHERE accepted_at IS NULL AND expires_at<=clock_timestamp() AND status IN
      ('DRAFT_PENDING_SELLER_KYC','PENDING_PAYMENT','FUNDED_PENDING_ACCEPTANCE')
      ORDER BY expires_at LIMIT 100`)).rows.map(row => row.id as string));
    let expired = 0;
    for (const id of ids) {
      try { await this.expire(id); expired++; }
      catch (error) { if (!(error instanceof NgnAgreementError && error.code === 'NOT_EXPIRED')) throw error; }
    }
    return { expired };
  }

  private async account(sql: Sql, id: string) {
    await sql.query('INSERT INTO ngn_agreement_accounts (id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    return (await sql.query('SELECT balance_kobo::text FROM ngn_agreement_accounts WHERE id=$1 FOR UPDATE', [id])).rows[0];
  }

  private async operation<T>(sql: Sql, id: string, input: unknown, run: () => Promise<T>): Promise<T> {
    const hash = fingerprint(input);
    // An operation row serializes retries across processes, before any money changes.
    const inserted = await sql.query(`INSERT INTO ngn_agreement_operations(id,fingerprint,result)
      VALUES ($1,$2,'null'::jsonb) ON CONFLICT DO NOTHING RETURNING id`, [id, hash]);
    if (!inserted.rows.length) {
      const existing = (await sql.query('SELECT fingerprint,result FROM ngn_agreement_operations WHERE id=$1', [id])).rows[0];
      if (existing.fingerprint !== hash) fail('IDEMPOTENCY_CONFLICT');
      return existing.result as T;
    }
    const result = await run();
    await sql.query('UPDATE ngn_agreement_operations SET result=$2::jsonb WHERE id=$1', [id, JSON.stringify(result)]);
    await sql.query('INSERT INTO ngn_agreement_outbox(id,payload) VALUES ($1,$2::jsonb)', [id, JSON.stringify(result)]);
    return result;
  }

  private async post(sql: Sql, operationId: string, entries: Array<[string, bigint]>) {
    const combined = new Map<string, bigint>();
    for (const [id, delta] of entries) combined.set(id, (combined.get(id) ?? 0n) + delta);
    if ([...combined.values()].reduce((sum, n) => sum + n, 0n) !== 0n) fail('UNBALANCED_JOURNAL', 500);
    for (const [id, delta] of [...combined].sort(([a], [b]) => a.localeCompare(b))) {
      if (!delta) continue;
      const account = await this.account(sql, id);
      if (id !== 'provider:paystack:clearing' && BigInt(account.balance_kobo) + delta < 0n) fail('INSUFFICIENT_BALANCE');
      await sql.query('UPDATE ngn_agreement_accounts SET balance_kobo=balance_kobo+$2::bigint WHERE id=$1', [id, delta.toString()]);
      await sql.query('INSERT INTO ngn_agreement_postings(operation_id,account_id,delta_kobo) VALUES ($1,$2,$3)', [operationId, id, delta.toString()]);
    }
  }

  private async load(sql: Sql, id: string): Promise<Agreement> {
    const record = (await sql.query(`SELECT *,principal_kobo::text,fee_kobo::text
      FROM ngn_balance_agreements WHERE id=$1 FOR UPDATE`, [identifier(id)])).rows[0];
    return record ?? fail('AGREEMENT_NOT_FOUND', 404);
  }
  private async expired(sql: Sql, a: Agreement) {
    // now() is fixed at transaction start, even if a row lock waited past expiry.
    return (await sql.query('SELECT $1::timestamptz <= clock_timestamp() AS expired', [a.expires_at])).rows[0].expired;
  }
  private async authorize(a: Agreement, actorId: string, action: string, credential: string) {
    await this.policies.authorize({ actorId, action, agreementId: a.id,
      amountKobo: (BigInt(a.principal_kobo) + BigInt(a.fee_kobo)).toString(), credential });
  }

  /** Only a verified provider-deposit adapter may call this; never a client credit endpoint.
   * Provider verification must check signature/reference, successful status, currency,
   * trusted DVA ownership, and the server's inflow-fee policy before returning netKobo.
   */
  async creditVerifiedDeposit(reference: string) {
    if (!reference || reference.length > 200) fail('INVALID_REFERENCE', 400);
    const deposit = await this.policies.verifyDeposit(reference);
    if (deposit.reference !== reference || deposit.currency !== 'NGN') fail('DEPOSIT_MISMATCH');
    identifier(deposit.userId);
    const net = amount(deposit.netKobo);
    const op = `paystack:${reference}`;
    return this.transaction(sql => this.operation(sql, op, deposit, async () => {
      await this.post(sql, op, [['provider:paystack:clearing', -net], [userAccount(deposit.userId), net]]);
      return { type: 'ngn.deposit.credited', ...deposit };
    }));
  }

  async create(input: { id: string; buyerId: string; sellerId: string; title: string; principalKobo: string; credential: string }) {
    const { id, buyerId, sellerId, title, principalKobo } = input;
    [id, buyerId, sellerId].forEach(identifier);
    if (buyerId === sellerId || !title.trim() || title.length > 240) fail('INVALID_AGREEMENT', 400);
    const principal = amount(principalKobo);
    // 1%, rounded UP to a whole kobo. Frozen at creation, disclosed before authorization.
    const fee = (principal + 99n) / 100n;
    await this.policies.authorize({ actorId: buyerId, action: 'create', agreementId: id,
      amountKobo: (principal + fee).toString(), credential: input.credential });
    const eligible = await this.policies.sellerEligible(sellerId);
    return this.transaction(sql => this.operation(sql, `create:${id}`, { id, buyerId, sellerId, title, principalKobo }, async () => {
      // Per-buyer row lock makes the three-invite cap safe across channels/processes.
      await this.account(sql, userAccount(buyerId));
      const pending = (await sql.query(`SELECT count(*)::integer AS count FROM ngn_balance_agreements
        WHERE buyer_id=$1 AND accepted_at IS NULL AND status NOT IN ('CANCELLED','COMPLETED')`, [buyerId])).rows[0].count;
      if (pending >= 3) fail('PENDING_INVITE_LIMIT');
      await sql.query(`INSERT INTO ngn_balance_agreements
        (id,buyer_id,seller_id,title,principal_kobo,fee_kobo,fee_bps,policy_version,status,expires_at)
        VALUES ($1,$2,$3,$4,$5,$6,100,'ngn-balance-v1',$7,clock_timestamp()+interval '48 hours')`,
      [id,buyerId,sellerId,title,principal.toString(),fee.toString(),eligible ? 'PENDING_PAYMENT' : 'DRAFT_PENDING_SELLER_KYC']);
      return this.load(sql, id);
    }));
  }

  async fund(id: string, actorId: string, credential: string) {
    return this.transaction(async sql => {
      const a = await this.load(sql, id);
      if (a.buyer_id !== actorId) fail('BUYER_REQUIRED', 403);
      await this.authorize(a, actorId, 'fund', credential);
      return this.operation(sql, `fund:${id}`, { id, actorId }, async () => {
        if (!['DRAFT_PENDING_SELLER_KYC','PENDING_PAYMENT'].includes(a.status)) fail('NOT_FUNDABLE');
        if (!a.accepted_at && await this.expired(sql, a)) fail('INVITE_EXPIRED');
        const principal = BigInt(a.principal_kobo), fee = BigInt(a.fee_kobo);
        await this.post(sql, `fund:${id}`, [[userAccount(actorId), -principal-fee], [principalAccount(id), principal], [feeAccount(id), fee]]);
        await sql.query(`UPDATE ngn_balance_agreements SET status=$2,funded_at=clock_timestamp() WHERE id=$1`, [id, a.accepted_at ? 'FUNDED' : 'FUNDED_PENDING_ACCEPTANCE']);
        return this.load(sql, id);
      });
    });
  }

  async accept(id: string, actorId: string, credential: string) {
    return this.transaction(async sql => {
      const a = await this.load(sql, id);
      if (a.seller_id !== actorId) fail('SELLER_REQUIRED', 403);
      await this.authorize(a, actorId, 'accept', credential);
      return this.operation(sql, `accept:${id}`, { id, actorId }, async () => {
        if (terminal.has(a.status) || a.accepted_at || await this.expired(sql, a)) fail('INVITE_NOT_ACCEPTABLE');
        if (!await this.policies.sellerEligible(actorId)) fail('SELLER_SETUP_REQUIRED');
        // Eligibility may involve a slow external read; recheck expiry afterward.
        if (await this.expired(sql,a)) fail('INVITE_NOT_ACCEPTABLE');
        await sql.query('UPDATE ngn_balance_agreements SET accepted_at=clock_timestamp(),status=$2 WHERE id=$1', [id,a.funded_at ? 'FUNDED' : 'PENDING_PAYMENT']);
        return this.load(sql,id);
      });
    });
  }

  private async transition(id: string, actorId: string, credential: string, action: 'start' | 'deliver' | 'dispute') {
    return this.transaction(async sql => {
      const a = await this.load(sql, id);
      if (action === 'dispute' ? ![a.buyer_id,a.seller_id].includes(actorId) : a.seller_id !== actorId) fail('PARTICIPANT_REQUIRED',403);
      await this.authorize(a,actorId,action,credential);
      return this.operation(sql, `${action}:${id}`, { id, actorId }, async () => {
        const expected = { start: 'FUNDED', deliver: 'IN_DELIVERY', dispute: 'DELIVERED' };
        if (a.status !== expected[action]) fail('INVALID_TRANSITION');
        // A lone cancellation request must not freeze the other party forever.
        // Starting work invalidates outstanding pre-work cancellation consent.
        if (action === 'start') await sql.query('DELETE FROM ngn_agreement_cancellation_consents WHERE agreement_id=$1', [id]);
        const updates = { start: "status='IN_DELIVERY',started_at=clock_timestamp()", deliver: "status='DELIVERED',delivered_at=clock_timestamp()", dispute: "status='DISPUTED'" };
        await sql.query(`UPDATE ngn_balance_agreements SET ${updates[action]} WHERE id=$1`, [id]);
        return this.load(sql,id);
      });
    });
  }
  start(id: string, actorId: string, credential: string) { return this.transition(id, actorId, credential, 'start'); }
  deliver(id: string, actorId: string, credential: string) { return this.transition(id, actorId, credential, 'deliver'); }
  dispute(id: string, actorId: string, credential: string) { return this.transition(id, actorId, credential, 'dispute'); }

  private async refund(sql: Sql, a: Agreement, operationId: string) {
    if (a.funded_at) {
      const principal = BigInt(a.principal_kobo), fee = BigInt(a.fee_kobo);
      await this.post(sql, operationId, [[principalAccount(a.id),-principal],[feeAccount(a.id),-fee],[userAccount(a.buyer_id),principal+fee]]);
    }
    await sql.query("UPDATE ngn_balance_agreements SET status='CANCELLED' WHERE id=$1", [a.id]);
    return this.load(sql,a.id);
  }

  async expire(id: string) {
    return this.transaction(async sql => {
      const a = await this.load(sql,id);
      return this.operation(sql,`expire:${id}`,{id},async () => {
        if (a.accepted_at || terminal.has(a.status) || !await this.expired(sql,a)) fail('NOT_EXPIRED');
        return this.refund(sql,a,`expire:${id}`);
      });
    });
  }

  async consentCancellation(id: string, actorId: string, credential: string) {
    return this.transaction(async sql => {
      const a = await this.load(sql,id);
      if (![a.buyer_id,a.seller_id].includes(actorId)) fail('PARTICIPANT_REQUIRED',403);
      await this.authorize(a,actorId,'cancel',credential);
      return this.operation(sql,`cancel:${id}:${actorId}`,{id,actorId},async () => {
        if (a.started_at || terminal.has(a.status)) fail('NOT_CANCELLABLE');
        await sql.query('INSERT INTO ngn_agreement_cancellation_consents(agreement_id,actor_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',[id,actorId]);
        const consents = await sql.query('SELECT actor_id FROM ngn_agreement_cancellation_consents WHERE agreement_id=$1',[id]);
        return consents.rows.length === 2 ? this.refund(sql,a,`cancel:${id}:${actorId}`) : a;
      });
    });
  }

  private async settle(sql: Sql, a: Agreement, operationId: string, buyerKobo: bigint) {
    const principal = BigInt(a.principal_kobo), fee = BigInt(a.fee_kobo);
    if (buyerKobo > principal) fail('INVALID_SPLIT',400);
    await this.post(sql,operationId,[[principalAccount(a.id),-principal],[feeAccount(a.id),-fee],
      [userAccount(a.buyer_id),buyerKobo],[userAccount(a.seller_id),principal-buyerKobo],['protocol:earned_fees',fee]]);
    await sql.query("UPDATE ngn_balance_agreements SET status='COMPLETED' WHERE id=$1",[a.id]);
    return this.load(sql,a.id);
  }

  async release(id: string, actorId: string, credential: string) {
    return this.transaction(async sql => {
      const a = await this.load(sql,id);
      if (a.buyer_id !== actorId) fail('BUYER_REQUIRED',403);
      await this.authorize(a,actorId,'release',credential);
      return this.operation(sql,`release:${id}`,{id,actorId},async () => {
        if (a.status !== 'DELIVERED') fail('NOT_RELEASABLE');
        return this.settle(sql,a,`release:${id}`,0n);
      });
    });
  }

  async rule(id: string, reviewerId: string, buyerKobo: string, reason: string, credential: string) {
    const split = amount(buyerKobo,true);
    if (!reason.trim() || reason.length > 2000) fail('RULING_REASON_REQUIRED',400);
    return this.transaction(async sql => {
      const a = await this.load(sql,id);
      if ([a.buyer_id,a.seller_id].includes(reviewerId)) fail('REVIEWER_CONFLICT',403);
      await this.policies.authorizeRuling(reviewerId,id,buyerKobo,reason,credential);
      return this.operation(sql,`ruling:${id}`,{id,reviewerId,buyerKobo,reason},async () => {
        if (a.status !== 'DISPUTED' || !a.delivered_at) fail('NOT_DISPUTED');
        return this.settle(sql,a,`ruling:${id}`,split);
      });
    });
  }
}
