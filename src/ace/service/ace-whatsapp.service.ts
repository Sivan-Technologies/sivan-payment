import { db } from '../../database/json-database.js';
import { normalizeWhatsappNumber } from '../../identity/identity.service.js';
import { forbidden, notFound } from '../../shared/errors.js';
import { answerAceSupport } from './ace-support.service.js';
import type { AceResourceType } from '../types/ace.types.js';

export async function answerWhatsappAceSupport(input: { whatsappNumber: string; message: string; resourceType?: AceResourceType; resourceId?: string }) {
  const normalizedWhatsapp = normalizeWhatsappNumber(input.whatsappNumber);
  const links = await db.listCustomerIdentityLinks();
  const link = links.find((item) => item.whatsappNumber === normalizedWhatsapp && item.status === 'linked');
  if (!link) throw notFound('Linked Sivan Payment account');

  const user = await db.findUserById(link.paymentUserId);
  if (!user) throw notFound('Payment user');
  if (!user.whatsappVerifiedAt && user.whatsappNumber !== normalizedWhatsapp) throw forbidden('WhatsApp identity is not verified for this payment account.');

  return answerAceSupport({
    userId: user.id,
    message: input.message,
    resourceType: input.resourceType,
    resourceId: input.resourceId,
    channel: 'whatsapp',
    admin: false
  });
}
