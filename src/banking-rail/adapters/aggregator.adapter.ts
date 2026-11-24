/**
 * SIVAN AGGREGATOR & SMART ROUTING BANKING RAIL ADAPTER
 *
 * Implements IBankingRailAdapter by dynamically orchestrating:
 *   1. 9PSB (9 Payment Service Bank - Bank Code: 120001) for Dedicated Virtual Accounts (DVA)
 *      and primary outbound NIBSS payouts (natural float pool).
 *   2. Nomba for hosted checkout orders (Direct Bank Transfer + USSD) and secondary/failover
 *      outbound bank transfers.
 *
 * Capabilities & Smart Routing Logic:
 *   • createCheckoutOrder: Handled via Nomba (instant Transfer + USSD hosted checkout).
 *   • createCustomer / assignVirtualAccount: Handled via 9PSB (permanent dedicated NUBAN pool).
 *   • createTransfer (Outbound Payout Smart Router):
 *     - Primary Rail: 9PSB (direct bank-to-bank settlement on NIBSS).
 *     - Failover Rail: Nomba (if 9PSB credentials unconfigured, circuit broken, or pre-flight network error).
 *     - Financial Ledger Integrity Guard: Strict idempotency. If primary rail returned a pending
 *       or unknown dispatch status, it NEVER blindly retries on Nomba (prevents double transfer).
 *   • parseWebhookEvent: Dispatches by payload structure (9PSB vs Nomba).
 *   • verifyWebhookSignature: Verifies against 9PSB secret or Nomba secret.
 */

import type {
  IBankingRailAdapter,
  BankingRailEvent,
  BankingRailName,
  CreateCustomerInput,
  CustomerRecord,
  IdentityInput,
  VirtualAccountRecord,
  CreateTransferInput,
  TransferRecord,
  CreateCheckoutInput,
  CheckoutOrderRecord,
} from '../banking-rail.adapter.js';
import { NinePsbBankingRailAdapter } from './ninepsb.adapter.js';
import { NombaBankingRailAdapter } from './nomba.adapter.js';

export class AggregatorBankingRailAdapter implements IBankingRailAdapter {
  readonly name: BankingRailName = 'aggregator';

  private readonly ninePsb: NinePsbBankingRailAdapter;
  private readonly nomba: NombaBankingRailAdapter;

  constructor(deps?: { ninePsb?: NinePsbBankingRailAdapter; nomba?: NombaBankingRailAdapter }) {
    this.ninePsb = deps?.ninePsb ?? new NinePsbBankingRailAdapter();
    this.nomba = deps?.nomba ?? new NombaBankingRailAdapter();
  }

  /**
   * Generates a hosted checkout order link via Nomba (Transfer + USSD).
   */
  async createCheckoutOrder(input: CreateCheckoutInput): Promise<CheckoutOrderRecord> {
    if (this.nomba.createCheckoutOrder) {
      return this.nomba.createCheckoutOrder(input);
    }
    throw new Error('[AggregatorBankingRailAdapter] Nomba createCheckoutOrder is not available.');
  }

  /**
   * Primary: 9PSB creates customer / wallet for DVA issuance.
   * Fallback to Nomba if 9PSB is unconfigured.
   */
  async createCustomer(input: CreateCustomerInput): Promise<CustomerRecord> {
    try {
      return await this.ninePsb.createCustomer(input);
    } catch (err: any) {
      if (err?.message?.includes('not configured')) {
        return await this.nomba.createCustomer(input);
      }
      throw err;
    }
  }

  /**
   * Submit identity document for verification.
   */
  async verifyIdentity(
    providerCustomerId: string,
    input: IdentityInput
  ): Promise<{ accepted: true; message: string }> {
    try {
      return await this.ninePsb.verifyIdentity(providerCustomerId, input);
    } catch (err: any) {
      if (err?.message?.includes('not configured')) {
        return await this.nomba.verifyIdentity(providerCustomerId, input);
      }
      throw err;
    }
  }

  /**
   * Assign a dedicated virtual account number (NUBAN 120001) to a verified customer.
   */
  async assignVirtualAccount(providerCustomerId: string): Promise<VirtualAccountRecord> {
    try {
      return await this.ninePsb.assignVirtualAccount(providerCustomerId);
    } catch (err: any) {
      if (err?.message?.includes('not configured')) {
        return await this.nomba.assignVirtualAccount(providerCustomerId);
      }
      throw err;
    }
  }

  /**
   * Look up all virtual accounts linked to a Sivan userId across rails.
   */
  async listVirtualAccounts(userId: string): Promise<VirtualAccountRecord[]> {
    const [ninePsbAccounts, nombaAccounts] = await Promise.all([
      this.ninePsb.listVirtualAccounts(userId).catch(() => []),
      this.nomba.listVirtualAccounts(userId).catch(() => []),
    ]);
    return [...ninePsbAccounts, ...nombaAccounts];
  }

  /**
   * Verify HMAC or signature across both 9PSB and Nomba.
   */
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean {
    if (this.ninePsb.verifyWebhookSignature(rawBody, headers)) {
      return true;
    }
    return this.nomba.verifyWebhookSignature(rawBody, headers);
  }

  /**
   * Parse a verified webhook payload into a typed BankingRailEvent.
   */
  parseWebhookEvent(rawBody: Buffer): BankingRailEvent {
    try {
      const parsed = JSON.parse(rawBody.toString('utf8'));
      // Check 9PSB structure
      if (
        parsed.sessionId ||
        parsed.transactionRef ||
        parsed.sourceBankCode ||
        (parsed.accountNumber && String(parsed.accountNumber).length === 10 && !parsed.event)
      ) {
        return this.ninePsb.parseWebhookEvent(rawBody);
      }
      // Otherwise delegate to Nomba
      return this.nomba.parseWebhookEvent(rawBody);
    } catch {
      return { type: 'ignored', originalType: 'parse_error' };
    }
  }

  /**
   * Outbound bank transfer payout smart router.
   *
   * Strategy:
   * 1. 9PSB holds natural float pool from user deposits. If configured, attempt 9PSB first.
   * 2. If 9PSB is unconfigured or experiences pre-flight connection failure, failover to Nomba.
   * 3. Financial Ledger Integrity: If 9PSB accepted the transfer into pending/sent, NEVER double-dispatch to Nomba!
   */
  async createTransfer(input: CreateTransferInput): Promise<TransferRecord> {
    const is9PsbConfigured = Boolean(
      (process.env.NINEPSB_CLIENT_ID || process.env.NINEPSB_MERCHANT_ID || process.env.NINEPSB_TEST_CLIENT_ID) &&
      (process.env.NINEPSB_CLIENT_SECRET || process.env.NINEPSB_TEST_CLIENT_SECRET)
    );

    if (is9PsbConfigured) {
      try {
        const record = await this.ninePsb.createTransfer(input);
        return record;
      } catch (err: any) {
        const errMsg = err?.message || String(err);
        const isPreflightFailure =
          errMsg.includes('not configured') ||
          errMsg.includes('ECONNREFUSED') ||
          errMsg.includes('ETIMEDOUT') ||
          errMsg.includes('Connection refused');

        if (!isPreflightFailure) {
          // The transfer was submitted to 9PSB or status is uncertain.
          // Do NOT failover blindly to avoid double disbursement.
          console.error(
            `[AggregatorBankingRailAdapter] 9PSB transfer error is not a confirmed pre-flight failure: "${errMsg}". Preserving single-dispatch integrity.`
          );
          throw err;
        }

        console.warn(
          `[AggregatorBankingRailAdapter] 9PSB primary transfer pre-flight failure: "${errMsg}". Routing failover to Nomba for ref: ${input.providerRef}`
        );

        try {
          return await this.nomba.createTransfer(input);
        } catch (nombaErr: any) {
          throw new Error(
            `[AggregatorBankingRailAdapter] Both 9PSB and Nomba transfers failed. 9PSB: ${errMsg}; Nomba: ${nombaErr?.message || nombaErr}`
          );
        }
      }
    }

    // If 9PSB is not yet configured with production keys, route directly via Nomba
    return this.nomba.createTransfer(input);
  }

  /**
   * Authoritative query for transfer status.
   */
  async getTransfer(providerRef: string): Promise<TransferRecord> {
    try {
      const rec = await this.ninePsb.getTransfer(providerRef);
      if (rec && rec.status !== 'failed') {
        return rec;
      }
    } catch {
      // Fall through to Nomba
    }

    return this.nomba.getTransfer(providerRef);
  }

  /**
   * Composite health check reporting both 9PSB and Nomba status.
   */
  async health(): Promise<{ status: 'ok' | 'degraded'; latencyMs: number; detail?: string }> {
    const t0 = Date.now();
    const [ninePsbHealth, nombaHealth] = await Promise.allSettled([
      this.ninePsb.health(),
      this.nomba.health(),
    ]);

    const latencyMs = Date.now() - t0;
    const ninePsbOk = ninePsbHealth.status === 'fulfilled' && ninePsbHealth.value.status === 'ok';
    const nombaOk = nombaHealth.status === 'fulfilled' && nombaHealth.value.status === 'ok';

    const detail = `9PSB: ${ninePsbHealth.status === 'fulfilled' ? ninePsbHealth.value.status : 'error'}; Nomba: ${nombaHealth.status === 'fulfilled' ? nombaHealth.value.status : 'error'}`;

    return {
      status: ninePsbOk || nombaOk ? 'ok' : 'degraded',
      latencyMs,
      detail,
    };
  }
}
