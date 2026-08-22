import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';
import { createAuditLog } from '../../audit/audit.service.js';
import { MonnifyKycLevelProvider } from './monnify-kyc-level.provider.js';
import { FlutterwaveKycLevelProvider } from './flutterwave-kyc-level.provider.js';
import { IdentifyOrgKycLevelProvider, isIdentifyOrgConfigured } from './identifyorg-kyc-level.provider.js';
import type {
  BvnAccountMatchInput,
  BvnInfoMatchInput,
  KycLevelMatchResult,
  KycLevelProvider,
  KycLevelProviderHealth,
} from './kyc-level-provider.js';

/**
 * TRY ONE BVN PROVIDER, FALL THROUGH TO THE NEXT WHEN IT CANNOT ANSWER.
 *
 * The immediate reason: Monnify has not approved the account for BVN
 * validation, so Level 2 cannot ship on Monnify today - but it should switch
 * to Monnify by itself the moment approval lands, without a code change or a
 * deploy timed to someone else's email.
 *
 * The standing reason: a single BVN vendor is a single point of failure on the
 * step that gates every Nigerian's limits. If it is down or rate-limited,
 * nobody reaches Level 2 and NGN 5,000,000 of headroom is unreachable until a
 * human notices.
 *
 * ─────────────────────────────────────────────────────────────────────
 * THE RULE THAT MATTERS: FALL OVER ON ERRORS, NEVER ON VERDICTS.
 *
 * This is the whole safety property of this file, and getting it wrong would
 * be far worse than having no failover at all.
 *
 *   AN ERROR is "this provider could not answer" - a revoked key, a 503, a
 *   timeout, an account not approved for the product. Another provider may
 *   legitimately answer the same question. FALL THROUGH.
 *
 *   A VERDICT is "this provider answered, and the answer is no" - `failed`
 *   because the name does not match, or `review` because something needs a
 *   human. That IS the answer. RETURN IT.
 *
 * Falling through on a `failed` verdict would mean asking every provider in
 * turn until one says `matched` - shopping for a yes. A user whose BVN
 * genuinely belongs to somebody else would be refused by Monnify and then
 * handed to Flutterwave for a second opinion on the same facts, and any
 * disagreement between vendors becomes a free pass to Level 2 and a
 * NGN 5,000,000 ceiling.
 *
 * So: only a thrown error advances to the next provider. A returned result -
 * whatever its status - is final.
 *
 * ─────────────────────────────────────────────────────────────────────
 * WHY NOT SILENT.
 *
 * Every fall-through is audited at `warning`. A chain that quietly works is a
 * chain nobody notices has been running on the backup for three weeks, and
 * "why are we paying Flutterwave N50 a call when Monnify is contracted" is a
 * question that should be answerable from the audit log rather than a bill.
 */

export const FAILOVER_PROVIDER_NAME = 'failover';

/**
 * Errors that mean "ask someone else", as opposed to "the answer is no".
 *
 * A 400 from a provider is usually OUR request being wrong - a malformed BVN,
 * a missing field - and re-sending the same bad request to a second provider
 * just spends money to be told the same thing. It is therefore NOT retried.
 *
 * 403 IS retried, deliberately: "your account is not approved for this
 * product" is exactly the situation this class exists for, and it arrives as a
 * 403 from both vendors.
 */
function isRetryableProviderFailure(error: unknown): boolean {
  if (error instanceof AppError) {
    // 403 - not provisioned / not approved / key rejected -> try the next one.
    // 503 - upstream down -> try the next one.
    if (error.statusCode === 403 || error.statusCode === 503) return true;
    // 400/404/409 are about THIS request, not about the provider. Sending the
    // same malformed input elsewhere cannot help and costs another N50.
    if (error.statusCode >= 400 && error.statusCode < 500) return false;
    return true;
  }
  // A bare Error is a fetch failure, a timeout, or a non-2xx the provider
  // client turned into `new Error(...)`. All of those are "could not answer".
  return true;
}

interface ChainEntry {
  name: string;
  provider: KycLevelProvider;
}

/**
 * The ordered chain, built from configuration.
 *
 * PREFERRED FIRST. KYC_LEVEL_PROVIDER still names the provider that should
 * answer when it can, so this is not a behaviour change for a deployment with
 * one working vendor - it is the same provider, with a net under it.
 *
 * A provider that is not configured is left OUT of the chain rather than
 * included and allowed to fail: attempting a vendor whose key is absent turns
 * one clean failure into two, and pollutes the audit trail with a fall-through
 * that was never a real attempt.
 */
export function buildKycProviderChain(preferred = env.KYC_LEVEL_PROVIDER): ChainEntry[] {
  const chain: ChainEntry[] = [];
  const seen = new Set<string>();

  const add = (name: string, make: () => KycLevelProvider, configured: boolean) => {
    if (!configured || seen.has(name)) return;
    seen.add(name);
    chain.push({ name, provider: make() });
  };

  const monnifyConfigured = Boolean(env.MONNIFY_API_KEY && env.MONNIFY_SECRET_KEY);
  const flutterwaveConfigured = Boolean(
    env.FLUTTERWAVE_SECRET_KEY &&
    (env.FLUTTERWAVE_BVN_ALLOW_V2_DIRECT || env.FLUTTERWAVE_BVN_REDIRECT_URL)
  );

  const makers: Record<string, { make: () => KycLevelProvider; configured: boolean }> = {
    monnify: { make: () => new MonnifyKycLevelProvider(), configured: monnifyConfigured },
    flutterwave: { make: () => new FlutterwaveKycLevelProvider(), configured: flutterwaveConfigured },
    identifyorg: { make: () => new IdentifyOrgKycLevelProvider(), configured: isIdentifyOrgConfigured() },
  };

  // The preferred provider goes first, when it is one of the real vendors.
  if (preferred in makers) {
    add(preferred, makers[preferred].make, makers[preferred].configured);
  }
  // Then everyone else, in a fixed order so the chain is predictable.
  /**
   * identifyorg is listed FIRST in the fallback order, not last.
   *
   * The order here is what a deployment falls back to when the preferred
   * vendor cannot answer, and today only one of the three actually can:
   * Monnify has no live key issued, and Flutterwave's compliant v3 path
   * cannot settle synchronously. Putting the working provider first means a
   * deployment that has not set KYC_LEVEL_PROVIDER still verifies people.
   */
  for (const name of ['identifyorg', 'monnify', 'flutterwave']) {
    add(name, makers[name].make, makers[name].configured);
  }

  return chain;
}

export class FailoverKycLevelProvider implements KycLevelProvider {
  name = FAILOVER_PROVIDER_NAME;

  constructor(private readonly chain: ChainEntry[]) {}

  /** The provider names in the order they will be tried. For health and tests. */
  order(): string[] {
    return this.chain.map((entry) => entry.name);
  }

  async verifyBvnIdentity(input: BvnInfoMatchInput): Promise<KycLevelMatchResult> {
    return this.run('verifyBvnIdentity', (provider) => provider.verifyBvnIdentity(input), input.bvn, 'bvnIdentity');
  }

  async verifyBvnBankAccount(input: BvnAccountMatchInput): Promise<KycLevelMatchResult> {
    return this.run('verifyBvnBankAccount', (provider) => provider.verifyBvnBankAccount(input), input.bvn, 'bvnBankAccount');
  }

  /**
   * CAN THIS VENDOR ANSWER THIS QUESTION AT ALL?
   *
   * Not every provider offers every check: neither IdentifyOrg nor Flutterwave
   * has a BVN-to-account endpoint, and both throw when asked. Without this,
   * that throw is indistinguishable from a real outage - the chain records a
   * fallthrough, audits an "error", and moves on as if the vendor had failed.
   *
   * A provider that does not implement capabilities() is assumed capable, so
   * existing providers behave exactly as before.
   */
  private supports(provider: KycLevelProvider, capability: 'bvnIdentity' | 'bvnBankAccount'): boolean {
    const caps = (provider as { capabilities?: () => Record<string, boolean> }).capabilities?.();
    if (!caps) return true;
    return caps[capability] !== false;
  }

  private async run(
    operation: string,
    call: (provider: KycLevelProvider) => Promise<KycLevelMatchResult>,
    bvn: string,
    capability?: 'bvnIdentity' | 'bvnBankAccount'
  ): Promise<KycLevelMatchResult> {
    if (!this.chain.length) {
      const { forbidden } = await import('../../shared/errors.js');
      throw forbidden('No BVN verification provider is configured.');
    }

    const attempted: string[] = [];
    let lastError: unknown;

    for (let index = 0; index < this.chain.length; index += 1) {
      const entry = this.chain[index];

      /**
       * Skip a vendor that structurally cannot perform this operation. Not
       * recorded as "attempted", because it was never asked - counting it
       * would make the audit trail claim a provider failed when it was simply
       * the wrong tool.
       */
      if (capability && !this.supports(entry.provider, capability)) continue;

      attempted.push(entry.name);

      try {
        const result = await call(entry.provider);

        /**
         * AN ANSWER, WHATEVER IT SAYS. Returned immediately - see the header
         * for why a `failed` must never advance to the next provider.
         *
         * The provider that actually answered is stamped on the result, so the
         * stored verification row records who verified it rather than the
         * word "failover".
         */
        if (index > 0) {
          await auditFallthrough({
            operation,
            answeredBy: entry.name,
            attempted,
            bvn,
            reason: lastError instanceof Error ? lastError.message : String(lastError ?? ''),
          });
        }
        return { ...result, provider: result.provider || entry.name };
      } catch (error) {
        lastError = error;

        /**
         * A non-retryable error is this REQUEST being wrong, not the provider
         * being unavailable. Rethrown rather than passed along: sending the
         * same malformed BVN to a second vendor cannot succeed and costs
         * another N50.
         */
        if (!isRetryableProviderFailure(error)) throw error;

        // Last provider in the chain - nobody left to ask.
        if (index === this.chain.length - 1) break;
      }
    }

    await auditExhausted({
      operation,
      attempted,
      bvn,
      reason: lastError instanceof Error ? lastError.message : String(lastError ?? ''),
    });

    const { serviceUnavailable } = await import('../../shared/errors.js');
    throw serviceUnavailable(
      'BVN verification is temporarily unavailable. Please try again shortly.',
      { attempted }
    );
  }

  /**
   * Health across the whole chain.
   *
   * `available` is true when ANY provider can answer - which is the question
   * the Level 2 button actually needs answered. The per-provider detail is
   * carried in the message so an operator can see that the primary is down
   * even while the feature still works.
   */
  async health(): Promise<KycLevelProviderHealth> {
    const results = await Promise.all(
      this.chain.map(async (entry) => {
        try {
          const health = await entry.provider.health();
          return { name: entry.name, available: health.available, message: health.message };
        } catch (error) {
          return {
            name: entry.name,
            available: false,
            message: error instanceof Error ? error.message : String(error),
          };
        }
      })
    );

    const usable = results.filter((row) => row.available);
    return {
      provider: this.name,
      available: usable.length > 0,
      mode: 'live',
      message:
        `chain: ${results.map((r) => `${r.name}=${r.available ? 'up' : 'down'}`).join(', ')}` +
        (usable.length && usable[0].name !== this.chain[0]?.name
          ? ` — PRIMARY ${this.chain[0]?.name} IS DOWN, serving from ${usable[0].name}`
          : ''),
      checkedAt: new Date().toISOString(),
    };
  }
}

async function auditFallthrough(input: {
  operation: string;
  answeredBy: string;
  attempted: string[];
  bvn: string;
  reason: string;
}) {
  await createAuditLog({
    actorType: 'system',
    actorId: 'kyc_failover',
    action: 'kyc.provider_failover',
    resourceType: 'kyc_level_provider',
    resourceId: input.answeredBy,
    // warning, not info: running on the backup is a state somebody should
    // notice and decide about, not routine traffic.
    severity: 'warning',
    metadata: {
      operation: input.operation,
      answeredBy: input.answeredBy,
      attempted: input.attempted,
      // Never the BVN itself - last 4 only, as everywhere else.
      bvnLast4: String(input.bvn || '').replace(/\D/g, '').slice(-4),
      primaryFailureReason: input.reason.slice(0, 300),
    },
  }).catch(() => undefined);
}

async function auditExhausted(input: {
  operation: string;
  attempted: string[];
  bvn: string;
  reason: string;
}) {
  await createAuditLog({
    actorType: 'system',
    actorId: 'kyc_failover',
    action: 'kyc.provider_chain_exhausted',
    resourceType: 'kyc_level_provider',
    resourceId: 'chain',
    severity: 'error',
    metadata: {
      operation: input.operation,
      attempted: input.attempted,
      bvnLast4: String(input.bvn || '').replace(/\D/g, '').slice(-4),
      lastFailureReason: input.reason.slice(0, 300),
    },
  }).catch(() => undefined);
}
