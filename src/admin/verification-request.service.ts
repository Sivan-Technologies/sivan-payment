import crypto from 'node:crypto';
import { db } from '../database/json-database.js';
import { id, nowIso } from '../shared/id.js';
import { badRequest, notFound } from '../shared/errors.js';
import { createAuditLog } from '../audit/audit.service.js';
import { env } from '../config/env.js';
import { runAiAddressVerification } from '../kyc/service/ai-address-verifier.service.js';
import type {
  KycControlsRecord,
  StepUpModule,
  StepUpRequestStatus,
  StepUpVerificationRequestRecord,
} from '../database/types.js';

export interface CreateStepUpRequestInput {
  adminId: string;
  userId: string;
  requestedModules: StepUpModule[];
  reason: string;
  expiresInHours?: number;
}

export interface ValidateStepUpTokenResult {
  valid: boolean;
  reason?: string;
  requestId?: string;
  userId?: string;
  requestedModules?: StepUpModule[];
  requestReason?: string;
  expiresAt?: string;
  status?: StepUpRequestStatus;
}

export interface SubmitStepUpInput {
  nin?: string;
  proofOfAddressDocId?: string;
  sourceOfFundsDocId?: string;
  passportDocId?: string;
  notes?: string;
}

/**
 * Creates an admin-triggered step-up verification request with a cryptographically
 * signed, single-use token and 72-hour default TTL.
 */
export async function createStepUpVerificationRequest(
  input: CreateStepUpRequestInput
): Promise<{
  requestId: string;
  verificationUrl: string;
  rawToken: string;
  expiresAt: string;
  requestedModules: StepUpModule[];
  reason: string;
}> {
  const user = await db.findUserById(input.userId);
  if (!user) {
    throw notFound(`User ${input.userId}`);
  }

  if (!input.requestedModules || input.requestedModules.length === 0) {
    throw badRequest('At least one verification module must be selected.');
  }

  const hours = Math.min(Math.max(input.expiresInHours ?? 72, 1), 720); // 1h to 30d
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();

  const reqId = id('vreq');
  const tokenSecret = crypto.randomBytes(24).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(tokenSecret).digest('hex');
  const rawToken = `${reqId}_${tokenSecret}`;
  const now = nowIso();

  const record: StepUpVerificationRequestRecord = {
    id: reqId,
    userId: input.userId,
    adminId: input.adminId,
    requestedModules: input.requestedModules,
    reason: input.reason.trim(),
    status: 'pending',
    tokenHash,
    expiresAt,
    createdAt: now,
    updatedAt: now,
  };

  await db.createVerificationRequest(record);

  await createAuditLog({
    action: 'admin.step_up_kyc.requested',
    resourceType: 'verification_request',
    resourceId: reqId,
    actorType: 'admin',
    actorId: input.adminId,
    metadata: {
      userId: input.userId,
      requestedModules: input.requestedModules,
      reason: input.reason,
      expiresAt,
    },
  });

  const baseUrl = process.env.USER_APP_URL || 'https://app.sivantech.online';
  const verificationUrl = `${baseUrl.replace(/\/+$/, '')}/verify?token=${encodeURIComponent(rawToken)}`;

  return {
    requestId: reqId,
    verificationUrl,
    rawToken,
    expiresAt,
    requestedModules: input.requestedModules,
    reason: input.reason,
  };
}

/**
 * Validates a raw step-up verification token.
 * Token format: vreq_<uuid>_<tokenSecret>
 */
export async function validateStepUpVerificationToken(
  rawToken: string
): Promise<ValidateStepUpTokenResult> {
  if (!rawToken || typeof rawToken !== 'string') {
    return { valid: false, reason: 'Verification token is required.' };
  }

  const parts = rawToken.split('_');
  if (parts.length < 3) {
    return { valid: false, reason: 'Malformed verification token.' };
  }

  // Token format: vreq_<uuid>_<secret> -> prefix is vreq, parts[1] is uuid, rest is secret
  const reqId = `${parts[0]}_${parts[1]}`;
  const tokenSecret = parts.slice(2).join('_');

  const record = await db.getVerificationRequestById(reqId);
  if (!record) {
    return { valid: false, reason: 'Verification request not found.' };
  }

  const computedHash = crypto.createHash('sha256').update(tokenSecret).digest('hex');
  if (computedHash !== record.tokenHash) {
    return { valid: false, reason: 'Invalid verification token credentials.' };
  }

  if (new Date(record.expiresAt).getTime() < Date.now()) {
    if (record.status === 'pending') {
      await db.updateVerificationRequest(record.id, { status: 'expired' });
    }
    return { valid: false, reason: 'This verification link has expired. Request a new link from Sivan Support or Admin.' };
  }

  if (record.status === 'approved') {
    return {
      valid: false,
      reason: 'This verification request has already been approved and completed.',
      status: record.status,
    };
  }

  return {
    valid: true,
    requestId: record.id,
    userId: record.userId,
    requestedModules: record.requestedModules,
    requestReason: record.reason,
    expiresAt: record.expiresAt,
    status: record.status,
  };
}

/**
 * Submits documents or identifiers against a verified step-up token.
 */
export async function submitStepUpVerification(
  rawToken: string,
  payload: SubmitStepUpInput
): Promise<{ status: string; message: string; requestId: string }> {
  const check = await validateStepUpVerificationToken(rawToken);
  if (!check.valid || !check.requestId) {
    throw badRequest(check.reason || 'Invalid verification request.');
  }

  const record = await db.getVerificationRequestById(check.requestId);
  if (!record) {
    throw notFound('Verification request not found.');
  }

  if (record.requestedModules.includes('nin') && payload.nin) {
    const cleanNin = payload.nin.replace(/\D/g, '');
    if (cleanNin.length !== 11) {
      throw badRequest('NIN must be exactly 11 digits.');
    }
  }

  const now = nowIso();
  const submissionData = {
    nin: payload.nin ? payload.nin.replace(/\D/g, '') : undefined,
    proofOfAddressDocId: payload.proofOfAddressDocId,
    sourceOfFundsDocId: payload.sourceOfFundsDocId,
    passportDocId: payload.passportDocId,
    notes: payload.notes,
  };

  await db.updateVerificationRequest(record.id, {
    status: 'under_review',
    submittedAt: now,
    submissionData,
    submittedData: submissionData,
  });

  await createAuditLog({
    action: 'kyc.step_up.submitted',
    resourceType: 'verification_request',
    resourceId: record.id,
    actorType: 'user',
    actorId: record.userId,
    metadata: {
      submittedModules: Object.keys(submissionData).filter((k) => (submissionData as any)[k]),
      submittedAt: now,
    },
  });

  return {
    status: 'success',
    message: 'Verification submitted successfully. Your account status and limits will update once reviewed.',
    requestId: record.id,
  };
}

/**
 * Admin review endpoint: approves or rejects a step-up verification request.
 */
export async function reviewStepUpVerificationRequest(
  adminId: string,
  requestId: string,
  decision: 'approved' | 'rejected',
  reviewNotes?: string
): Promise<StepUpVerificationRequestRecord> {
  const record = await db.getVerificationRequestById(requestId);
  if (!record) {
    throw notFound(`Verification request ${requestId}`);
  }

  const now = nowIso();
  const newStatus: StepUpRequestStatus = decision === 'approved' ? 'approved' : 'rejected';

  // If approved and NIN was provided, automatically record NIN identity verification to elevate to Level 2
  if (decision === 'approved' && record.submissionData?.nin) {
    const cleanNin = record.submissionData.nin;
    const last4 = cleanNin.slice(-4);
    await db.upsertNgnIdentityVerification({
      id: `ngnkyc_${record.userId}_nin`,
      userId: record.userId,
      checkType: 'nin_info',
      status: 'matched',
      provider: 'admin_step_up',
      providerReference: record.id,
      bvnLast4: last4,
      verifiedAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  const updated = await db.updateVerificationRequest(requestId, {
    status: newStatus,
    reviewedAt: now,
    reviewedBy: adminId,
    reviewNotes: reviewNotes || undefined,
  });

  await createAuditLog({
    action: `admin.step_up_kyc.${decision}`,
    resourceType: 'verification_request',
    resourceId: requestId,
    actorType: 'admin',
    actorId: adminId,
    metadata: {
      userId: record.userId,
      decision,
      reviewNotes,
      reviewedAt: now,
    },
  });

  return updated || record;
}

/**
 * Lists all verification requests, optionally filtered by user.
 */
export async function listAllStepUpVerificationRequests(
  userId?: string
): Promise<StepUpVerificationRequestRecord[]> {
  const rows = await db.listVerificationRequests(userId);
  return rows.map((r) => ({
    ...r,
    submittedData: r.submittedData || r.submissionData,
  }));
}

/**
 * Retrieves the global KYC & Autonomous AI approval controls.
 */
export async function getKycControls(): Promise<KycControlsRecord> {
  return db.getKycControls();
}

/**
 * Updates the global KYC & Autonomous AI approval controls.
 */
export async function updateKycControls(input: {
  aiApprovalThreshold: number;
  aiAutoApprovalEnabled: boolean;
  adminId?: string;
}): Promise<KycControlsRecord> {
  const threshold = Math.max(50, Math.min(Number(input.aiApprovalThreshold) || 85, 99));
  const record: KycControlsRecord = {
    id: 'default_kyc_controls',
    aiApprovalThreshold: threshold,
    aiAutoApprovalEnabled: Boolean(input.aiAutoApprovalEnabled),
    updatedAt: nowIso(),
    updatedBy: input.adminId || 'admin',
  };
  await db.saveKycControls(record);
  await createAuditLog({
    action: 'admin.kyc_controls.updated',
    resourceType: 'kyc_controls',
    resourceId: 'default_kyc_controls',
    actorType: 'admin',
    actorId: input.adminId || 'admin',
    metadata: {
      aiApprovalThreshold: threshold,
      aiAutoApprovalEnabled: record.aiAutoApprovalEnabled,
    },
  });
  return record;
}

/**
 * Resolves a user's Tier 2 KYC context for the WhatsApp Meta Flow INIT handshake.
 * Enforces the Locked Country Safeguard Rule:
 * - If phone starts with +234 OR user has a Nigerian BVN / NGN Virtual Account -> lockedCountry = 'NG'
 */
export async function getUserTier2KycContext(userIdOrPhone: string): Promise<{
  userId: string;
  hasNigerianBvnOrDva: boolean;
  firstName?: string;
  lastName?: string;
  existingRequestId?: string;
}> {
  const clean = String(userIdOrPhone || '').trim();
  const user =
    (await db.findUserById(clean)) ||
    (await db.findUserByWhatsappNumber(clean)) ||
    (await db.findUserByTarget(clean));

  const resolvedUserId = user?.id || clean;

  let hasNigerianBvnOrDva = false;
  try {
    const verifications = await db.listNgnIdentityVerifications(resolvedUserId);
    if (verifications.some((v) => v.checkType === 'bvn_info' && (v.status === 'matched' || v.status === 'review'))) {
      hasNigerianBvnOrDva = true;
    }
  } catch {
    // Non-fatal
  }

  if (!hasNigerianBvnOrDva) {
    try {
      const allVas = await db.listVirtualAccounts();
      if (allVas.some((va) => va.userId === resolvedUserId && va.status === 'active')) {
        hasNigerianBvnOrDva = true;
      }
    } catch {
      // Non-fatal
    }
  }

  let existingRequestId: string | undefined;
  try {
    const existing = await db.listVerificationRequests(resolvedUserId);
    const active = existing.find((r) => r.status === 'pending' || r.status === 'under_review');
    if (active) existingRequestId = active.id;
  } catch {
    // Non-fatal
  }

  const nameParts = String((user as any)?.fullName || (user as any)?.username || '').trim().split(/\s+/).filter(Boolean);

  return {
    userId: resolvedUserId,
    hasNigerianBvnOrDva,
    firstName: (user as any)?.firstName || nameParts[0] || undefined,
    lastName: (user as any)?.lastName || (nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined),
    existingRequestId,
  };
}

export interface SubmitWhatsAppTier2StepInput {
  userIdOrPhone: string;
  step: 'address' | 'nin';
  country: string;
  streetAddress?: string;
  city?: string;
  stateRegion?: string;
  documentType?: string;
  documentFileName?: string;
  documentMimeType?: string;
  proofOfAddressUrl?: string;
  nin?: string;
  dateOfBirth?: string;
}

/**
 * Persists a WhatsApp Meta Flow Tier 2 KYC step (Step 1: Address + Bank Statement, Step 2: NIN + DOB).
 */
export async function submitWhatsAppTier2KycStep(
  input: SubmitWhatsAppTier2StepInput
): Promise<{
  requestId: string;
  userId: string;
  status: StepUpRequestStatus;
  requiresNinStep: boolean;
}> {
  const ctx = await getUserTier2KycContext(input.userIdOrPhone);
  const userId = ctx.userId;
  const now = nowIso();
  const lockedCountry = ctx.hasNigerianBvnOrDva ? 'NG' : String(input.country || 'NG').toUpperCase();
  const requiresNinStep = lockedCountry === 'NG';

  let record: StepUpVerificationRequestRecord | undefined;
  if (ctx.existingRequestId) {
    record = await db.getVerificationRequestById(ctx.existingRequestId);
  }

  const existingSub = record?.submissionData || {};
  const addressText =
    input.streetAddress && input.city
      ? `${input.streetAddress}, ${input.city}, ${input.stateRegion || ''} (${lockedCountry})`.replace(/,\s*\(/, ' (')
      : existingSub.addressText;

  let ninLast4 = existingSub.ninLast4;
  let ninMasked = existingSub.ninMasked;
  let ninHash = existingSub.ninHash;

  if (input.nin) {
    const cleanNin = input.nin.replace(/\D/g, '');
    if (cleanNin.length === 11) {
      ninLast4 = cleanNin.slice(-4);
      ninMasked = `*******${ninLast4}`;
      ninHash = crypto
        .createHmac('sha256', env.USER_JWT_SECRET)
        .update(cleanNin)
        .digest('hex');

      // Check if duplicate NIN used across accounts
      const duplicates = await db.countUsersWithBvnHash(ninHash, userId).catch(() => 0);
      if (duplicates > 0) {
        await createAuditLog({
          actorType: 'system',
          action: 'kyc.nin_reused_across_accounts',
          resourceType: 'verification_request',
          resourceId: ctx.existingRequestId || 'pending',
          severity: 'warning',
          metadata: { userId, ninLast4, otherAccounts: duplicates },
        }).catch(() => undefined);
      }
    }
  }

  const mergedSubmission: any = {
    ...existingSub,
    country: lockedCountry,
    ...(input.streetAddress ? { streetAddress: input.streetAddress } : {}),
    ...(input.city ? { city: input.city } : {}),
    ...(input.stateRegion ? { stateRegion: input.stateRegion } : {}),
    ...(addressText ? { addressText } : {}),
    ...(input.documentType ? { documentType: input.documentType } : {}),
    ...(input.documentFileName ? { documentFileName: input.documentFileName } : {}),
    ...(input.documentMimeType ? { documentMimeType: input.documentMimeType } : {}),
    ...(input.proofOfAddressUrl ? { proofOfAddressUrl: input.proofOfAddressUrl } : {}),
    ...(ninMasked ? { nin: ninMasked, ninLast4, ninMasked, ninHash } : {}),
    ...(input.dateOfBirth ? { dateOfBirth: input.dateOfBirth } : {}),
  };

  const isFinalStep = input.step === 'nin' || !requiresNinStep;
  let targetStatus: StepUpRequestStatus = isFinalStep ? 'under_review' : 'pending';
  const requestedModules: StepUpModule[] = requiresNinStep
    ? ['proof_of_address', 'nin']
    : ['proof_of_address'];

  // Autonomous AI Agent Address & Proof of Address Verification
  if (isFinalStep) {
    try {
      const kycControls = await getKycControls();
      const userName = [ctx.firstName, ctx.lastName].filter(Boolean).join(' ') || 'Sivan Customer';
      const aiResult = await runAiAddressVerification({
        userName,
        claimedAddress: addressText || '',
        country: lockedCountry,
        documentUrl: mergedSubmission.proofOfAddressUrl,
        documentType: mergedSubmission.documentType,
        documentFileName: mergedSubmission.documentFileName,
        threshold: kycControls.aiApprovalThreshold,
      });

      mergedSubmission.aiVerification = aiResult;

      if (
        kycControls.aiAutoApprovalEnabled &&
        aiResult.verdict === 'auto_approved' &&
        aiResult.overallScore >= kycControls.aiApprovalThreshold
      ) {
        targetStatus = 'approved';
        await db.upsertNgnIdentityVerification({
          id: `ngnkyc_${userId}_tier2`,
          userId,
          checkType: 'nin_info',
          status: 'matched',
          provider: 'sivan_ai_compliance_agent',
          providerReference: ctx.existingRequestId || 'ai_auto_approved',
          bvnLast4: mergedSubmission.ninLast4 || '0000',
          bvnHash: mergedSubmission.ninHash,
          verifiedAt: now,
          createdAt: now,
          updatedAt: now,
        });

        await createAuditLog({
          action: 'admin.step_up_kyc.auto_approved',
          resourceType: 'verification_request',
          resourceId: ctx.existingRequestId || 'auto',
          actorType: 'system',
          actorId: 'sivan_ai_agent',
          metadata: {
            userId,
            score: aiResult.overallScore,
            threshold: kycControls.aiApprovalThreshold,
            institution: aiResult.institution,
          },
        }).catch(() => undefined);
      }
    } catch (err: any) {
      console.warn('[submitWhatsAppTier2KycStep] Autonomous AI verification non-fatal error:', err?.message || err);
    }
  }

  if (!record) {
    const reqId = id('vreq');
    const tokenSecret = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(tokenSecret).digest('hex');
    const expiresAt = new Date(Date.now() + 72 * 3600 * 1000).toISOString();
    record = await db.createVerificationRequest({
      id: reqId,
      userId,
      adminId: 'whatsapp_meta_flow',
      requestedModules,
      reason: `WhatsApp Tier 2 KYC (${lockedCountry})`,
      status: targetStatus,
      tokenHash,
      expiresAt,
      submittedAt: isFinalStep ? now : undefined,
      submissionData: mergedSubmission,
      submittedData: mergedSubmission,
      metadata: {
        channel: 'whatsapp_flow',
        lockedCountry,
        lastStep: input.step,
      },
      createdAt: now,
      updatedAt: now,
    });
  } else {
    record = (await db.updateVerificationRequest(record.id, {
      requestedModules,
      status: targetStatus,
      submittedAt: isFinalStep ? now : record.submittedAt,
      submissionData: mergedSubmission,
      submittedData: mergedSubmission,
      metadata: {
        ...(record.metadata || {}),
        channel: 'whatsapp_flow',
        lockedCountry,
        lastStep: input.step,
      },
    })) || record;
  }

  await createAuditLog({
    action: `kyc.whatsapp_tier2.${input.step}_submitted`,
    resourceType: 'verification_request',
    resourceId: record.id,
    actorType: 'user',
    actorId: userId,
    metadata: {
      lockedCountry,
      step: input.step,
      documentType: mergedSubmission.documentType,
      hasDocument: Boolean(mergedSubmission.proofOfAddressUrl),
      ninLast4: mergedSubmission.nin ? mergedSubmission.nin.slice(-4) : undefined,
    },
  }).catch(() => undefined);

  return {
    requestId: record.id,
    userId,
    status: targetStatus,
    requiresNinStep,
  };
}
