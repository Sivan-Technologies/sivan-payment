import { Keypair } from '@solana/web3.js';
import crypto from 'node:crypto';
import type { NgnProviderAdapter } from './ngn-provider.js';
import type { NgnProviderHealth, NgnProviderName, NgnQuoteInput, NgnQuoteRecord } from '../types/ngn.types.js';

function money(value: number) { return value.toFixed(value >= 100 ? 2 : 6); }


/**
 * A Solana address is 32 BYTES, base58-encoded - not "44 base58 characters".
 *
 * The first version of this generated 44 random characters from the base58
 * alphabet. That is valid base58 and still rejected by `new PublicKey()` about
 * two thirds of the time, because a 44-character string usually decodes to 33
 * bytes, not 32 - so the suite failed intermittently with "Invalid public key
 * input". Caught by a flaky re-run, not by the first green.
 *
 * Encoding exactly 32 bytes is the only way to be right every time, which is
 * why this uses the same library the production path validates with rather
 * than hand-rolling the alphabet.
 */
function mockDepositAddress(network: string): string {
  if (network === 'solana') {
    return Keypair.generate().publicKey.toBase58();
  }
  return `0x${crypto.randomBytes(20).toString('hex')}`;
}

export class MockNgnProvider implements NgnProviderAdapter {
  name: NgnProviderName = 'mock';
  async createQuote(input: NgnQuoteInput) {
    const rate = 1500;
    const source = Number(input.sourceAmount);
    const fee = input.direction === 'onramp' ? source * 0.01 : source * 0.005;
    const destinationAmount = input.direction === 'onramp'
      ? (Math.max(source - fee, 0) / rate)
      : (source * rate) - (source * rate * 0.01);
    return {
      provider: this.name,
      providerQuoteId: `mock_quote_${crypto.randomUUID()}`,
      sourceAmount: money(source),
      destinationAmount: money(destinationAmount),
      rate: money(rate),
      feeAmount: money(fee),
      metadata: { mock: true, quoteModel: input.direction === 'onramp' ? 'NGN to stablecoin' : 'stablecoin to NGN' }
    } satisfies Partial<NgnQuoteRecord> as any;
  }
  async createOnrampTransfer(quote: NgnQuoteRecord) {
    return {
      providerTransferId: `mock_ngn_on_${crypto.randomUUID()}`,
      status: 'awaiting_deposit' as const,
      bankReference: `SVN-NGN-${quote.id.slice(-6).toUpperCase()}`,
      virtualAccount: { bankName: 'Sivan Mock Bank', accountName: 'Sivan NGN Collection', accountNumberMasked: '****0420', rail: 'bank_transfer' },
      metadata: { mock: true, instruction: 'Transfer exact NGN amount with reference.' }
    };
  }
  /**
   * A DEPOSIT ADDRESS THAT IS VALID ON THE NETWORK IT IS FOR.
   *
   * This returned `mock_avalanche_<uuid>` for EVERY off-ramp, whatever network
   * the quote asked for. Harmless while nothing sent to it - and fatal once
   * scheduleSweep() started funding off-ramps from the user's Sivan balance:
   *
   *     ngn.sweep_failed  reason: "Non-base58 character"
   *                       depositAddress: "mock_avalanche_ab4417f7..."
   *
   * The Solana SPL transfer decodes the destination as base58. The literal
   * string "mock_avalanche_..." contains 'l', '0' and '_', none of which are
   * in the base58 alphabet, so the sweep threw before broadcasting. The order
   * then sat at `awaiting_crypto_deposit` forever, telling the user to send
   * crypto that Sivan had promised to move for them - the whole point of the
   * "From my Sivan balance" path.
   *
   * Reproduced end to end against the deployed test API before changing
   * anything, and the audit log named it exactly.
   *
   * The address must therefore be SHAPED LIKE the chain it belongs to, because
   * the sweep is real code doing real address validation even when the rail is
   * mocked. A mock that returns an unusable address does not test the happy
   * path, it only tests the error path.
   */
  async createOfframpTransfer(quote: NgnQuoteRecord) {
    const network = String((quote.metadata as any)?.network ?? '').toLowerCase();
    return {
      providerTransferId: `mock_ngn_off_${crypto.randomUUID()}`,
      status: 'awaiting_crypto_deposit' as const,
      depositAddress: mockDepositAddress(network),
      metadata: { mock: true, network, instruction: 'Send supported stablecoin to generated deposit address.' }
    };
  }
  async getTransfer(providerTransferId: string) { return { providerTransferId, status: 'processing' as const }; }
  async verifyWebhook(payload: any, _headers?: unknown) { return { id: `ngnwh_${crypto.randomUUID()}`, provider: this.name, providerEventId: payload?.id || crypto.randomUUID(), eventType: payload?.eventType || 'mock.event', transferId: payload?.transferId, payload, createdAt: new Date().toISOString() }; }
  async health(): Promise<NgnProviderHealth> { return { provider: this.name, available: true, mode: 'mock' as const, message: 'Mock NGN provider ready.', checkedAt: new Date().toISOString() }; }
}
