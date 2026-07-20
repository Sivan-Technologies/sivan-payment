import { z } from 'zod';

export type AceSupportChannel = 'web_dashboard' | 'admin_hub' | 'whatsapp' | 'api';
export type AceResourceType = 'withdrawal' | 'onramp_order' | 'virtual_account_transaction' | 'general';
export type AceConfidence = 'high' | 'medium' | 'low';

export const aceSupportRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  resourceType: z.enum(['withdrawal', 'onramp_order', 'virtual_account_transaction', 'general']).optional().default('general'),
  resourceId: z.string().optional(),
  channel: z.enum(['web_dashboard', 'admin_hub', 'whatsapp', 'api']).optional().default('web_dashboard')
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
  transaction?: {
    id: string;
    type: 'withdrawal' | 'onramp_order' | 'virtual_account_transaction';
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
