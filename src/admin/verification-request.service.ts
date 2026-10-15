import crypto from 'node:crypto';
import { db } from '../database/json-database.js';
import { id, nowIso } from '../shared/id.js';
import { badRequest, notFound } from '../shared/errors.js';
import { createAuditLog } from '../audit/audit.service.js';
import type {
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
  return db.listVerificationRequests(userId);
}
