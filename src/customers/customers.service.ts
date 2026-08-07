import { z } from 'zod';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import { getOfframpProvider } from '../providers/provider-registry.js';
import { BridgeClient } from '../providers/bridge/bridge.client.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { id, idempotencyKey, nowIso } from '../shared/id.js';
import { requireUser } from '../users/users.service.js';
import { mapBridgeKycStatus } from './customer-mapping.js';
import { bridgeCustomerTermsAccepted } from '../providers/bridge/bridge-terms.js';
import { requireCustomerTypeEnabled } from '../controls/payment-controls.service.js';
import { createAuditLog } from '../audit/audit.service.js';
import type { CustomerStatus } from '../database/types.js';

const optionalUrl = z.preprocess((val) => (typeof val === 'string' && val.trim() === '' ? undefined : val), z.string().url().optional());

export const startKycSchema = z.object({
  userId: z.string().min(1),
  type: z.enum(['individual', 'business']).default('individual'),
  redirectUri: optionalUrl,
  endorsements: z.array(z.string()).optional()
});


export const createBridgeCustomerSchema = z.object({
  userId: z.string().min(1),
  payload: z.record(z.string(), z.unknown())
});

export const importBridgeCustomerSchema = z.object({
  userId: z.string().min(1).optional(),
  email: z.string().email().optional(),
  providerCustomerId: z.string().min(1),
  customerType: z.enum(['individual', 'business']).optional(),
  replaceExisting: z.boolean().default(false),
  importedBy: z.string().min(2).default('admin_api_key'),
  reason: z.string().min(5).max(2000)
}).refine((value) => Boolean(value.userId || value.email), { message: 'userId or email is required' });

export async function startKyc(input: z.infer<typeof startKycSchema>) {
  await requireCustomerTypeEnabled(input.type);
  const user = await requireUser(input.userId);
  const provider = getOfframpProvider();
  const existing = await getCustomerByUserId(input.userId).catch(() => null);

  if (existing?.provider === 'mock' && provider.name === 'bridge') {
    throw badRequest('This account has a legacy mock verification record. Start a fresh Bridge sandbox KYC/TOS verification before enabling real payment or virtual-account features.');
  }

  if (existing?.providerCustomerId) {
    // If we already have a hosted KYC/TOS link, return it immediately. Bridge can
    // reject re-generating a hosted link for an existing sandbox customer with a
    // 400, which left users stuck at "Not started" after account creation.
    if (existing.kycLink) return { ...existing, hostedKycLink: existing.kycLink };
    try {
      const hosted = await provider.getHostedKycLink(existing.providerCustomerId, input.redirectUri);
      return { ...existing, hostedKycLink: hosted.url };
    } catch (error) {
      if (existing.kycLink) return { ...existing, hostedKycLink: existing.kycLink };
      throw error;
    }
  }

  const kyc = await provider.createKycLink({
    email: user.email,
    fullName: user.fullName,
    type: input.type,
    redirectUri: input.redirectUri,
    endorsements: input.endorsements,
    idempotencyKey: idempotencyKey('kyc')
  });

  /**
   * PUSH THE DATE OF BIRTH, because /kyc_links threw it away.
   *
   * Bridge blocks approval while the `base`/`sepa` endorsements are missing
   * `date_of_birth` and `min_age_18` - which is the "Verification needs one
   * more step" banner users were seeing with no way to act on it.
   *
   * It CANNOT be set on the create call. Measured against the real sandbox:
   * POST /v0/kyc_links with birth_date returned 201, and reading the customer
   * back showed `birth_date: null` with the requirement still missing. Accepted
   * and silently dropped. A follow-up PUT is the only thing that works, and one
   * PUT moved both requirements into `complete`.
   *
   * NON-FATAL. The KYC link is already valid and the customer already exists;
   * losing that over a patch failure would be a far worse outcome than a
   * customer who needs the date re-applied. The value is stored on the user, so
   * a retry has something to retry from - which is most of why it is stored at
   * all.
   */
  await pushDateOfBirthToProvider(provider, kyc.customerId, user);

  const now = nowIso();
  const customer = {
    id: id('cus'),
    userId: user.id,
    provider: provider.name,
    providerCustomerId: kyc.customerId,
    customerType: input.type,
    kycLinkId: kyc.id,
    kycLink: kyc.kycLink,
    tosLink: kyc.tosLink,
    kycStatus: mapBridgeKycStatus(kyc.kycStatus),
    tosStatus: kyc.tosStatus === 'approved' ? 'approved' as const : 'pending' as const,
    onboardingCostUsd: input.type === 'business' ? toMoney(env.BRIDGE_KYB_COST_USD) : toMoney(env.BRIDGE_KYC_COST_USD),
    onboardingCostType: input.type === 'business' ? 'kyb' as const : 'kyc' as const,
    onboardingCostRecordedAt: now,
    raw: kyc.raw,
    createdAt: now,
    updatedAt: now
  };
  return db.insertCustomerRecord(customer);
}


/**
 * Send a user's declared date of birth to the provider, if we have one.
 *
 * Silent when there is nothing to send: Nigerians verify by bank-name
 * resolution and may never have been asked, and a missing date is a normal
 * state rather than an error. Failures are audited, never thrown - see the
 * call site.
 */
async function pushDateOfBirthToProvider(
  provider: { name: string; updateCustomer?: (id: string, patch: Record<string, unknown>) => Promise<unknown> },
  providerCustomerId: string | undefined,
  user: { id: string; dateOfBirth?: string }
): Promise<void> {
  if (!providerCustomerId || !user.dateOfBirth) return;
  if (typeof provider.updateCustomer !== 'function') return;

  try {
    await provider.updateCustomer(providerCustomerId, { birth_date: user.dateOfBirth });
    await createAuditLog({
      actorType: 'system',
      actorId: 'kyc_dob_sync',
      action: 'customer.birth_date_pushed',
      resourceType: 'payments_customer',
      resourceId: providerCustomerId,
      severity: 'info',
      metadata: { userId: user.id, provider: provider.name }
    }).catch(() => undefined);
  } catch (error) {
    /**
     * Loud on the inside, invisible on the outside. The user's verification
     * link works; what is broken is a requirement they will hit LATER, and
     * there is nothing they can do about it in the moment.
     */
    await createAuditLog({
      actorType: 'system',
      actorId: 'kyc_dob_sync',
      action: 'customer.birth_date_push_failed',
      resourceType: 'payments_customer',
      resourceId: providerCustomerId,
      severity: 'error',
      metadata: {
        userId: user.id,
        provider: provider.name,
        reason: error instanceof Error ? error.message : String(error)
      }
    }).catch(() => undefined);
  }
}

/**
 * Re-apply a stored date of birth to an EXISTING provider customer.
 *
 * The backfill path: every customer created before this existed is sitting on
 * Bridge missing `date_of_birth`, and asking those users to start verification
 * again would create a second customer and spend $2 twice.
 */
export async function syncCustomerDateOfBirth(userId: string) {
  const user = await requireUser(userId);
  if (!user.dateOfBirth) throw badRequest('Add your date of birth first.');

  const customer = await getCustomerByUserId(userId);
  if (!customer.providerCustomerId) throw badRequest('This account has no provider customer yet.');

  const provider: any = getOfframpProvider(customer.provider);
  if (typeof provider.updateCustomer !== 'function') {
    throw badRequest(`The ${customer.provider} provider cannot update a customer record.`);
  }

  await provider.updateCustomer(customer.providerCustomerId, { birth_date: user.dateOfBirth });
  await createAuditLog({
    actorType: 'system',
    actorId: 'kyc_dob_sync',
    action: 'customer.birth_date_pushed',
    resourceType: 'payments_customer',
    resourceId: customer.providerCustomerId,
    severity: 'info',
    metadata: { userId, provider: customer.provider, backfill: true }
  }).catch(() => undefined);

  return { userId, providerCustomerId: customer.providerCustomerId, dateOfBirth: user.dateOfBirth };
}

export async function createBridgeCustomer(input: z.infer<typeof createBridgeCustomerSchema>) {
  const requestedType = input.payload.type === 'business' ? 'business' : 'individual';
  await requireCustomerTypeEnabled(requestedType);
  const user = await requireUser(input.userId);
  const provider = getOfframpProvider();
  const existing = await getCustomerByUserId(input.userId).catch(() => null);
  if (existing) throw badRequest('User already has a provider customer');

  const payload = { client_reference_id: user.id, email: user.email, ...input.payload };
  const providerCustomer = await provider.createCustomer({ payload, idempotencyKey: idempotencyKey('customer') });
  const now = nowIso();
  const customer = {
    id: id('cus'),
    userId: user.id,
    provider: provider.name,
    providerCustomerId: providerCustomer.id,
    customerType: input.payload.type === 'business' ? 'business' as const : 'individual' as const,
    kycStatus: mapBridgeKycStatus(providerCustomer.status),
    onboardingCostUsd: input.payload.type === 'business' ? toMoney(env.BRIDGE_KYB_COST_USD) : toMoney(env.BRIDGE_KYC_COST_USD),
    onboardingCostType: input.payload.type === 'business' ? 'kyb' as const : 'kyc' as const,
    onboardingCostRecordedAt: now,
    raw: providerCustomer.raw,
    createdAt: now,
    updatedAt: now
  };
  return db.insertCustomerRecord(customer);
}


export async function importExistingBridgeCustomer(input: z.infer<typeof importBridgeCustomerSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const data = await db.read();
  const user = input.userId
    ? data.users.find((item) => item.id === input.userId)
    : data.users.find((item) => item.email.toLowerCase() === input.email!.toLowerCase());
  if (!user) throw notFound('User');

  const existing = data.customers.find((item) => item.userId === user.id);
  const sameBridgeCustomer = existing?.provider === 'bridge' && existing.providerCustomerId === input.providerCustomerId;
  if (existing && !sameBridgeCustomer && !input.replaceExisting) {
    throw badRequest('User already has a customer record. Set replaceExisting=true to replace a legacy/mock or different Bridge customer record.');
  }

  const bridgeCustomer: any = await new BridgeClient().request(`/customers/${input.providerCustomerId}`);
  const customerType = input.customerType || (bridgeCustomer?.type === 'business' ? 'business' : 'individual');
  const now = nowIso();
  const kycStatus = mapImportedBridgeCustomerStatus(bridgeCustomer);
  const tosStatus = bridgeTermsApproved(bridgeCustomer) ? 'approved' as const : 'pending' as const;
  const record = {
    id: existing?.id || id('cus'),
    userId: user.id,
    provider: 'bridge',
    providerCustomerId: input.providerCustomerId,
    customerType,
    kycLinkId: existing?.kycLinkId,
    kycLink: existing?.kycLink,
    tosLink: existing?.tosLink,
    kycStatus,
    tosStatus,
    onboardingCostUsd: existing?.onboardingCostUsd || (customerType === 'business' ? toMoney(env.BRIDGE_KYB_COST_USD) : toMoney(env.BRIDGE_KYC_COST_USD)),
    onboardingCostType: customerType === 'business' ? 'kyb' as const : 'kyc' as const,
    onboardingCostRecordedAt: existing?.onboardingCostRecordedAt || now,
    raw: {
      bridgeCustomer,
      importedFromBridge: {
        importedAt: now,
        importedBy: input.importedBy,
        reason: input.reason,
        replacedExisting: Boolean(existing && !sameBridgeCustomer),
        previousCustomer: existing ? {
          id: existing.id,
          provider: existing.provider,
          providerCustomerId: existing.providerCustomerId,
          kycStatus: existing.kycStatus,
          tosStatus: existing.tosStatus
        } : null
      }
    },
    createdAt: existing?.createdAt || now,
    updatedAt: now
  };

  const saved = existing ? await db.updateCustomerRecord(record) : await db.insertCustomerRecord(record);
  await createAuditLog({
    actorType: 'admin',
    actorId: input.importedBy,
    action: 'customer.bridge_customer_imported',
    resourceType: 'customer',
    resourceId: saved.id,
    severity: existing && !sameBridgeCustomer ? 'warning' : 'info',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: {
      userId: user.id,
      userEmail: user.email,
      providerCustomerId: input.providerCustomerId,
      customerType,
      kycStatus,
      tosStatus,
      replaceExisting: input.replaceExisting,
      replacedExisting: Boolean(existing && !sameBridgeCustomer),
      reason: input.reason
    }
  });

  const enriched = await enrichCustomerKycAction(saved);
  return {
    customer: enriched,
    bridgeCustomer: summarizeImportedBridgeCustomer(bridgeCustomer),
    virtualAccountEligible: enriched.kycStatus === 'kyc_approved' && enriched.provider === 'bridge',
    replacedExisting: Boolean(existing && !sameBridgeCustomer)
  };
}

export async function getCustomerByUserId(userId: string) {
  const data = await db.read();
  const customer = data.customers.find((c) => c.userId === userId);
  if (!customer) throw notFound('Customer');
  return customer;
}

/**
 * Pull the provider's current view of this customer into our record.
 *
 * TWO SOURCES, BECAUSE NEITHER ONE IS ALWAYS PRESENT.
 *
 * `tos_status` lives on the KYC LINK. `has_accepted_terms_of_service` lives on
 * the CUSTOMER. This function used to read only the first and, worse, to
 * `return` early when there was no kycLinkId - so for any customer without one
 * (every admin-imported customer, and anyone whose hosted link we never
 * stored) it fetched nothing at all and `tosStatus` stayed at whatever it was
 * created with: 'pending', permanently.
 *
 * That was survivable while terms were only a label on a card. It is NOT
 * survivable now that terms gate transacting - it would refuse withdrawals to
 * users who accepted Bridge's terms months ago. The gate and this sync ship
 * together for that reason.
 */
export async function refreshKycStatus(userId: string) {
  const customer = await getCustomerByUserId(userId);
  const provider = getOfframpProvider(customer.provider);

  let next = { ...customer };
  let changed = false;

  if (customer.kycLinkId) {
    const kyc = await provider.getKycLink(customer.kycLinkId);
    next = {
      ...next,
      kycStatus: mapBridgeKycStatus(kyc.kycStatus),
      // ONLY EVER UPGRADES. The kyc_link keeps reporting 'pending' for a user
      // who accepted terms through some other route, and overwriting a real
      // 'approved' with that would un-accept them on every page refresh.
      tosStatus: kyc.tosStatus === 'approved' ? 'approved' as const : next.tosStatus,
      raw: kyc.raw
    };
    changed = true;
  }

  /**
   * THE CUSTOMER OBJECT IS THE AUTHORITY ON TERMS, so ask it whenever the
   * link has not already given us an 'approved'.
   *
   * Failure here is swallowed deliberately. This runs on the page-load
   * refresh path; a Bridge blip must not turn a status card into an error
   * screen, and the stored value remains whatever it already was.
   */
  if (next.tosStatus !== 'approved' && customer.providerCustomerId && provider.getCustomer) {
    try {
      const snapshot = await provider.getCustomer(customer.providerCustomerId);
      // Tri-state: `undefined` means Bridge said nothing usable. Only an
      // explicit `true` moves the stored value, and nothing here can move it
      // backwards to 'pending'.
      if (snapshot.tosAccepted === true) {
        next = { ...next, tosStatus: 'approved' as const };
        changed = true;
      }
    } catch {
      // Keep the record as it stands.
    }
  }

  if (!changed) return enrichCustomerKycAction(customer);

  const saved = await db.updateCustomerRecord({ ...next, updatedAt: nowIso() });
  return enrichCustomerKycAction(saved);
}

function toMoney(value: number): string {
  return value.toFixed(2);
}


async function enrichCustomerKycAction<T extends { provider: string; providerCustomerId?: string; kycStatus?: string; tosStatus?: string }>(customer: T): Promise<T & { customerAction: ReturnType<typeof buildCustomerKycAction> }> {
  if (customer.provider !== 'bridge' || !customer.providerCustomerId || customer.kycStatus === 'kyc_approved') {
    return { ...customer, customerAction: buildCustomerKycAction(customer.kycStatus, customer.tosStatus) };
  }
  try {
    const bridgeCustomer: any = await new BridgeClient().request(`/customers/${customer.providerCustomerId}`);
    const missingRequirements = unique((bridgeCustomer.endorsements || []).flatMap((endorsement: any) => flattenRequirements(endorsement?.requirements?.missing)));
    const pendingRequirements = unique((bridgeCustomer.endorsements || []).flatMap((endorsement: any) => flattenRequirements(endorsement?.requirements?.pending)));
    const issueRequirements = unique((bridgeCustomer.endorsements || []).flatMap((endorsement: any) => flattenRequirements(endorsement?.requirements?.issues)));
    return { ...customer, customerAction: buildCustomerKycAction(customer.kycStatus, customer.tosStatus, { missingRequirements, pendingRequirements, issueRequirements }) };
  } catch {
    return { ...customer, customerAction: buildCustomerKycAction(customer.kycStatus, customer.tosStatus) };
  }
}

function buildCustomerKycAction(status?: string, tosStatus?: string, diagnostics: { missingRequirements?: string[]; pendingRequirements?: string[]; issueRequirements?: string[] } = {}) {
  const missing = unique(diagnostics.missingRequirements || []);
  const pending = unique(diagnostics.pendingRequirements || []);
  const issues = unique(diagnostics.issueRequirements || []);
  const actionable = missing.filter((item) => !providerOnlyRequirement(item));
  const providerOnly = missing.filter(providerOnlyRequirement);
  const friendly = actionable.map(humanRequirement);

  if (status === 'kyc_approved') {
    return { level: 'success', title: 'Verification successful', message: 'Your identity has been verified. You can now use Sivan Payment features that require KYC.', requirements: [], canContinue: false };
  }
  if (status === 'kyc_under_review') {
    return { level: 'review', title: 'Verification under review', message: 'Your verification has been submitted and is being reviewed by our provider. This page will update automatically.', requirements: [], canContinue: false };
  }
  if (['kyc_rejected', 'failed', 'cancelled'].includes(status || '')) {
    return { level: 'failed', title: 'Verification could not be completed', message: 'Your secure verification was not approved. Please retry verification or contact support if you need help.', requirements: friendly, canContinue: true };
  }
  if (status === 'kyc_incomplete') {
    if (friendly.length) {
      const list = formatHumanList(friendly);
      const processing = providerOnly.length ? ' If you already submitted this, our provider may still be processing your verification.' : '';
      return { level: 'action_required', title: 'Verification needs one more step', message: `Please complete your ${list} in the secure verification page.${processing}`, requirements: friendly, canContinue: true };
    }
    if (providerOnly.length || pending.length) {
      return { level: 'processing', title: 'Verification is still processing', message: 'Your verification is still being processed by our provider. Please refresh again in a few minutes.', requirements: providerOnly.map(humanRequirement), canContinue: false };
    }
    if (issues.length) {
      return { level: 'action_required', title: 'Verification needs attention', message: `Please review ${formatHumanList(issues.map(humanRequirement))} in the secure verification page.`, requirements: issues.map(humanRequirement), canContinue: true };
    }
    return { level: 'action_required', title: 'Verification needs one more step', message: 'Please continue the secure verification flow to finish your identity check.', requirements: [], canContinue: true };
  }
  if (tosStatus !== 'approved') {
    return { level: 'action_required', title: 'Provider terms required', message: 'Please accept the provider terms in the secure verification page.', requirements: ['provider terms'], canContinue: true };
  }
  return { level: 'neutral', title: 'Verification not started', message: 'Complete identity verification to unlock payments, higher limits, and account features.', requirements: [], canContinue: true };
}

function flattenRequirements(value: unknown): string[] {
  if (!value) return [];
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenRequirements);
  if (typeof value === 'object') return Object.values(value as Record<string, unknown>).flatMap(flattenRequirements);
  return [String(value)];
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(Boolean)));
}

function providerOnlyRequirement(value: string) {
  return ['post_processing', 'kyc_approval', 'kyc_with_proof_of_address'].includes(value);
}

function humanRequirement(value: string) {
  const labels: Record<string, string> = {
    date_of_birth: 'date of birth',
    min_age_18: 'age confirmation',
    proof_of_address: 'proof of address',
    address_of_residence: 'residential address',
    selfie_verification: 'selfie verification',
    source_of_funds_questionnaire: 'source-of-funds questions',
    tax_identification_number: 'required identity details',
    terms_of_service_v1: 'provider terms',
    terms_of_service_v2: 'provider terms',
    post_processing: 'provider processing',
    kyc_approval: 'provider approval',
    kyc_with_proof_of_address: 'proof-of-address review'
  };
  return labels[value] || value.replaceAll('_', ' ');
}

function formatHumanList(values: string[]) {
  const uniqueValues = unique(values);
  if (uniqueValues.length <= 1) return uniqueValues[0] || 'remaining verification steps';
  if (uniqueValues.length === 2) return `${uniqueValues[0]} and ${uniqueValues[1]}`;
  return `${uniqueValues.slice(0, -1).join(', ')}, and ${uniqueValues[uniqueValues.length - 1]}`;
}


function mapImportedBridgeCustomerStatus(bridgeCustomer: any): CustomerStatus {
  const status = String(bridgeCustomer?.status || '').toLowerCase();
  if (status === 'approved' || status === 'active') return 'kyc_approved';
  if (status === 'under_review' || status === 'reviewing') return 'kyc_under_review';
  if (status === 'rejected') return 'kyc_rejected';
  if (status === 'not_started') return 'kyc_not_started';
  if (status === 'paused') return 'paused';
  if (status === 'offboarded') return 'offboarded';
  return mapBridgeKycStatus(status || undefined);
}

/**
 * Now delegates to the shared rule in bridge-terms.ts.
 *
 * The old body here stringified the WHOLE endorsements array and asked
 * `/terms_of_service/i.test(x) && /complete/i.test(x)` - two independent
 * substring tests over one blob, so an endorsement with terms in `missing`
 * and anything at all in `complete` read as accepted. That is a false
 * positive on a compliance field.
 *
 * `?? false` because this caller writes a two-state DB column at import time
 * and has no third value to store. The GATE does not go through here - it
 * reads the tri-state directly, so "unknown" can never be mistaken for a
 * refusal on the path that blocks a user.
 */
function bridgeTermsApproved(bridgeCustomer: any): boolean {
  return bridgeCustomerTermsAccepted(bridgeCustomer) ?? false;
}

function summarizeImportedBridgeCustomer(bridgeCustomer: any) {
  return {
    id: bridgeCustomer?.id,
    status: bridgeCustomer?.status,
    type: bridgeCustomer?.type,
    email: bridgeCustomer?.email,
    firstName: bridgeCustomer?.first_name,
    lastName: bridgeCustomer?.last_name,
    createdAt: bridgeCustomer?.created_at,
    updatedAt: bridgeCustomer?.updated_at,
    endorsements: (bridgeCustomer?.endorsements || []).map((endorsement: any) => ({
      name: endorsement?.name,
      status: endorsement?.status,
      missingRequirements: flattenRequirements(endorsement?.requirements?.missing),
      pendingRequirements: flattenRequirements(endorsement?.requirements?.pending),
      completedRequirements: flattenRequirements(endorsement?.requirements?.complete),
      additionalRequirements: flattenRequirements(endorsement?.additional_requirements)
    }))
  };
}

export async function simulateSandboxKycApproval(userId: string) {
  const customer = await getCustomerByUserId(userId);
  const provider = getOfframpProvider(customer.provider);
  if (!provider.simulateSandboxKycApproval) {
    throw badRequest('Current provider does not support sandbox KYC simulation');
  }
  const result: any = await provider.simulateSandboxKycApproval(customer.providerCustomerId, idempotencyKey('simulate-kyc'));
  const record = { ...customer, kycStatus: mapBridgeKycStatus(result?.kyc_status ?? 'approved'), raw: { previous: customer.raw, sandboxSimulation: result }, updatedAt: nowIso() };
  return db.updateCustomerRecord(record);
}

export async function forceSandboxKycApproval(userId: string, actorId = 'admin_api_key') {
  if (env.APP_ENV === 'production' || !env.BRIDGE_MOCK_MODE) {
    throw forbidden('Manual sandbox KYC force approval is disabled for Bridge verification. Use the Bridge sandbox hosted KYC/TOS flow for new users.');
  }
  const customer = await getCustomerByUserId(userId);
  if (customer.provider !== 'mock') {
    throw forbidden('Manual sandbox KYC force approval is only available for explicitly mock-mode customers. Bridge customers must be verified by Bridge sandbox.');
  }
  const now = nowIso();
  const record = {
    ...customer,
    kycStatus: 'kyc_approved' as const,
    tosStatus: 'approved' as const,
    raw: { previous: customer.raw, sandboxForceApproval: { actorId, approvedAt: now } },
    updatedAt: now
  };
  return db.updateCustomerRecord(record);
}
