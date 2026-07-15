import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import type { LegalAcceptanceRecord } from '../database/types.js';
import { createAuditLog } from '../audit/audit.service.js';
import { id, nowIso } from '../shared/id.js';

export const currentLegalVersions = {
  termsVersion: env.LEGAL_TERMS_VERSION,
  privacyVersion: env.LEGAL_PRIVACY_VERSION,
  riskDisclosureVersion: env.LEGAL_RISK_DISCLOSURE_VERSION
};

export const legalAcceptancePayloadSchema = z.object({
  accepted: z.literal(true),
  termsVersion: z.string().min(1).optional(),
  privacyVersion: z.string().min(1).optional(),
  riskDisclosureVersion: z.string().min(1).optional()
});

export type LegalAcceptancePayload = z.infer<typeof legalAcceptancePayloadSchema>;

export function normalizeLegalAcceptancePayload(value: unknown): LegalAcceptancePayload | undefined {
  if (!value) return undefined;
  return legalAcceptancePayloadSchema.parse(value);
}

export function buildChallengeLegalAcceptance(input: {
  legalAcceptance?: LegalAcceptancePayload;
  ipAddress?: string;
  userAgent?: string;
  acceptedAt?: string;
}) {
  if (!input.legalAcceptance) return {};
  return {
    legalTermsVersion: input.legalAcceptance.termsVersion ?? currentLegalVersions.termsVersion,
    legalPrivacyVersion: input.legalAcceptance.privacyVersion ?? currentLegalVersions.privacyVersion,
    legalRiskDisclosureVersion: input.legalAcceptance.riskDisclosureVersion ?? currentLegalVersions.riskDisclosureVersion,
    legalAcceptedAt: input.acceptedAt ?? nowIso(),
    legalAcceptanceIpAddress: input.ipAddress,
    legalAcceptanceUserAgent: input.userAgent
  };
}

export async function recordSignupLegalAcceptance(input: {
  userId: string;
  email: string;
  termsVersion?: string;
  privacyVersion?: string;
  riskDisclosureVersion?: string;
  acceptedAt?: string;
  ipAddress?: string;
  userAgent?: string;
}) {
  const acceptedAt = input.acceptedAt ?? nowIso();
  const record: LegalAcceptanceRecord = {
    id: id('leg'),
    userId: input.userId,
    email: input.email.toLowerCase(),
    termsVersion: input.termsVersion ?? currentLegalVersions.termsVersion,
    privacyVersion: input.privacyVersion ?? currentLegalVersions.privacyVersion,
    riskDisclosureVersion: input.riskDisclosureVersion ?? currentLegalVersions.riskDisclosureVersion,
    acceptedAt,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    source: 'signup',
    createdAt: nowIso()
  };

  const saved = await db.insertLegalAcceptanceRecord(record);
  await createAuditLog({
    actorType: 'user',
    actorId: input.userId,
    action: 'legal.acceptance_recorded',
    resourceType: 'legal_acceptance',
    resourceId: saved.id,
    ipAddress: input.ipAddress,
    userAgent: input.userAgent,
    metadata: {
      email: saved.email,
      termsVersion: saved.termsVersion,
      privacyVersion: saved.privacyVersion,
      riskDisclosureVersion: saved.riskDisclosureVersion,
      source: saved.source
    }
  });
  return saved;
}

export async function listUserLegalAcceptances(userId: string) {
  return db.listLegalAcceptancesForUser(userId);
}
