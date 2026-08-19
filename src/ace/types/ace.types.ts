import { z } from 'zod';

export type AceSupportChannel = 'web_dashboard' | 'admin_hub' | 'whatsapp' | 'api' | 'telegram';
/**
 * ngn_transfer was MISSING, and naira payouts are the busiest rail Sivan runs.
 *
 * A user pasting `ngnt_f17c5017-...` could never be answered: the id matched no
 * declared type, fell to 'general', and 'general' attached whatever transaction
 * was newest. The reference the user typed was discarded and a different
 * transaction was reported back to them at confidence: high.
 *
 * 'transaction_lookup' is a REQUEST, not a stored kind - it means "the user is
 * asking about a transaction but has not said which one". It is what lets the
 * evidence builder distinguish "find their latest" from "do not attach
 * anything", which plain 'general' could not express.
 */
export type AceResourceType =
  | 'withdrawal'
  | 'onramp_order'
  | 'ngn_transfer'
  | 'virtual_account_transaction'
  | 'transaction_lookup'
  | 'general';

/**
 * WHAT IS BEING ASKED, as distinct from WHICH RECORD it concerns.
 *
 * These were conflated before: the only way to say "this is about
 * verification" was resourceType 'general', which downstream read as "attach a
 * transaction". Two different questions now have two different fields.
 */
export type AceIntent =
  | 'verification'
  | 'transaction'
  | 'deposit'
  | 'account_recovery'
  | 'unknown';
export type AceConfidence = 'high' | 'medium' | 'low';

export const aceSupportRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  resourceType: z.enum(['withdrawal', 'onramp_order', 'ngn_transfer', 'virtual_account_transaction', 'transaction_lookup', 'general']).optional().default('general'),
  resourceId: z.string().optional(),
  channel: z.enum(['web_dashboard', 'admin_hub', 'whatsapp', 'api', 'telegram']).optional().default('web_dashboard')
});

export interface AceEvidenceItem {
  source: string;
  label: string;
  value?: string | number | boolean | null;
  customerSafe: boolean;
  metadata?: Record<string, unknown>;
}

export interface AceEvidenceBundle {
  user?: { id: string; email?: string; kycStatus?: string };
  /**
   * What the user was asking about, carried so the responder can answer the
   * QUESTION rather than describe whatever record was found.
   */
  intent?: AceIntent;
  /**
   * Set when the user named a reference we could not find.
   *
   * Distinct from "no reference given": one deserves "I could not find
   * ngnt_123", the other deserves "which transaction do you mean?". Collapsing
   * them is how a wrong-but-confident answer gets produced.
   */
  unresolvedReference?: string;
  /**
   * The user's real verification state, when that is what they asked about.
   *
   * getVerificationSummary() has carried level, path, per-check status and the
   * next step all along; none of it ever reached the assistant, which is why
   * "I need help with verification" could only be answered with a generic
   * sentence about identity checks.
   */
  verification?: {
    level: number;
    levelLabel: string;
    path: string;
    identityComplete: boolean;
    pathComplete: boolean;
    checks: Record<string, string>;
    termsRequired: boolean;
    termsAccepted: boolean;
    hasPayoutAccount: boolean;
    hasPendingPayoutReview: boolean;
    nextStep?: { label: string; description: string; available: boolean };
  };
  transaction?: {
    id: string;
    type: 'withdrawal' | 'onramp_order' | 'ngn_transfer' | 'virtual_account_transaction';
    status: string;
    explanation?: string;
    amount?: string;
    currency?: string;
    provider?: string;
    providerReference?: string;
  };
  timeline: any[];
  trace: any[];
  incidents: any[];
  webhooks: any[];
  queue: Array<{ name: string; status: string; detail?: string }>;
  providerHealth: { provider?: string; status: string; detail?: string };
  reconciliationFindings: any[];
  supportTickets: any[];
  evidenceItems: AceEvidenceItem[];
}

export interface AceSupportAnswer {
  answer: string;
  confidence: AceConfidence;
  needsHuman: boolean;
  currentStage?: string;
  estimatedCompletion?: string;
  evidence: Record<string, unknown>;
  evidenceChecked: string[];
  suggestedActions: Array<{ label: string; actionType: 'none' | 'open_ticket' | 'human_review'; priority: 'low' | 'normal' | 'high' | 'urgent'; reason: string }>;
  sessionId: string;
}
