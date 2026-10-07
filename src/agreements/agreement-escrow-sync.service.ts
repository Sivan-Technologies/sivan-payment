/**
 * Mirrors agreement acceptance and funding across to sivan-escrow-agent.
 *
 * Extracted verbatim from agreement.service.ts as part of the god-service
 * split. NOTE: the plan's responsibility map omitted these two entirely; they
 * are an integration concern, not lifecycle. No logic changes.
 */
import type { ServiceAgreementRecord } from '../database/types.js';

/**
 * Forward acceptance to external escrow agent so Telegram & WhatsApp channels
 * immediately transition to PENDING_PAYMENT and display the Pay now button.
 */
export async function syncEscrowAgentAcceptance(
  agreement: ServiceAgreementRecord,
  sellerUserId?: string
): Promise<void> {
  try {
    const configuredUrl = process.env.CORE_API_BASE_URL || process.env.ESCROW_AGENT_URL;
    const coreSecret = process.env.CORE_API_SECRET;
    if (!configuredUrl || !coreSecret) return;

    const sellerPhone = agreement.sellerUserId || sellerUserId || '';
    const cleanPhone = sellerPhone.replace(/^whatsapp:/i, '').trim();
    const isDigitsOnly = /^\+?[0-9]{7,15}$/.test(cleanPhone);
    const wireIdentity = isDigitsOnly
      ? (cleanPhone.startsWith('+') ? `whatsapp:${cleanPhone}` : `whatsapp:+${cleanPhone}`)
      : cleanPhone;

    const url = `${configuredUrl.replace(/\/$/, '')}/api/escrows/${encodeURIComponent(agreement.id)}/accept`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-core-api-key': coreSecret,
      },
      body: JSON.stringify({ actorWhatsapp: wireIdentity, actorUserId: cleanPhone }),
      signal: AbortSignal.timeout(3500),
    });
  } catch (err: any) {
    console.warn('[agreement.service] syncEscrowAgentAcceptance note:', err?.message || err);
  }
}

/**
 * Forward funding to external escrow agent so all channels reflect payment confirmation.
 */
export async function syncEscrowAgentFunding(
  agreement: ServiceAgreementRecord
): Promise<void> {
  try {
    const configuredUrl = process.env.CORE_API_BASE_URL || process.env.ESCROW_AGENT_URL;
    const coreSecret = process.env.CORE_API_SECRET;
    if (!configuredUrl || !coreSecret) return;

    const buyerPhone = agreement.buyerUserId || '';
    const wireIdentity = buyerPhone.startsWith('+')
      ? `whatsapp:${buyerPhone}`
      : buyerPhone.startsWith('whatsapp:')
      ? buyerPhone
      : `whatsapp:+${buyerPhone}`;

    const url = `${configuredUrl.replace(/\/$/, '')}/api/escrows/${encodeURIComponent(agreement.id)}/pay-from-balance`;
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-core-api-key': coreSecret,
      },
      body: JSON.stringify({ actorWhatsapp: wireIdentity }),
      signal: AbortSignal.timeout(3500),
    });
  } catch (err: any) {
    console.warn('[agreement.service] syncEscrowAgentFunding note:', err?.message || err);
  }
}
