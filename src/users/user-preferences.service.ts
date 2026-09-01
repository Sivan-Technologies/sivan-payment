import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { UserPreferencesRecord } from '../database/types.js';
import { notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { getUser } from './users.service.js';
import { createAuditLog } from '../audit/audit.service.js';

// No `network` key. The chain is fixed per deployment, so there is no request
// a client could send here that would be honoured - and an accepted-then-
// ignored field is worse than an absent one. Zod strips unknown keys, so a
// stale client still sending `network` is silently ignored rather than
// erroring, which is the right behaviour during a rollout.
export const updateUserPreferencesSchema = z.object({
  defaultFiatCurrency: z.enum(['usd', 'gbp', 'eur', 'ngn']).optional(),
  language: z.enum(['en-US', 'en-GB', 'fr-FR', 'de-DE', 'es-ES', 'it-IT', 'nl-NL', 'pt-PT']).optional(),
  transactionUpdates: z.boolean().optional(),
  marketingEmails: z.boolean().optional(),
  securityAlerts: z.boolean().optional(),
  emailConfirmationsForHighValue: z.boolean().optional(),
  telegramNotificationsEnabled: z.boolean().optional(),
  whatsappNotificationsEnabled: z.boolean().optional(),
  multiChainAlertsEnabled: z.boolean().optional()
});

export function defaultUserPreferences(userId: string): UserPreferencesRecord {
  return {
    userId,
    defaultFiatCurrency: 'usd',
    language: 'en-US',
    transactionUpdates: true,
    marketingEmails: false,
    securityAlerts: true,
    emailConfirmationsForHighValue: false,
    telegramNotificationsEnabled: true, // Free and instant channel default
    whatsappNotificationsEnabled: false, // Default OFF to optimize Meta/Twilio business messaging costs
    multiChainAlertsEnabled: true,
    updatedAt: nowIso()
  };
}


export async function getUserPreferences(userId: string) {
  await getUser(userId).catch(() => { throw notFound('User'); });
  const stored = await db.getUserPreferencesRecord(userId);
  if (!stored) {
    return defaultUserPreferences(userId);
  }
  return {
    ...defaultUserPreferences(userId),
    ...stored,
    telegramNotificationsEnabled: stored.telegramNotificationsEnabled ?? true,
    whatsappNotificationsEnabled: stored.whatsappNotificationsEnabled ?? false,
    multiChainAlertsEnabled: stored.multiChainAlertsEnabled ?? true
  };
}

export async function updateUserPreferences(userId: string, input: z.infer<typeof updateUserPreferencesSchema>) {
  const current = await getUserPreferences(userId);
  const next: UserPreferencesRecord = {
    ...current,
    ...input,
    updatedAt: nowIso()
  };

  await db.upsertUserPreferencesRecord(next);
  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'user.preferences_updated',
    resourceType: 'payments_user_preferences',
    resourceId: userId,
    severity: 'info',
    metadata: { changed: Object.keys(input) }
  });
  return next;
}
