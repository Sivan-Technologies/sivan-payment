/**
 * Read-side queries over service agreements.
 *
 * Extracted verbatim from agreement.service.ts as part of the god-service
 * split (FUTURE_BUILD_GOD_SERVICE_SPLIT.md Part 2). No logic changes.
 *
 * NOTE: the plan listed listAgreements and listForDeadlineSweep here; neither
 * exists anywhere in this repo. getAgreement and listAdminAgreements are the
 * actual read surface.
 */
import { db } from '../database/json-database.js';
import { nowIso } from '../shared/id.js';
import { notFound } from '../shared/errors.js';
import type { ServiceAgreementRecord } from '../database/types.js';

/**
 * Get a single agreement by id. Returns null if not found.
 */
export async function getAgreement(agreementId: string): Promise<ServiceAgreementRecord | null> {
  const record = await db.findServiceAgreementById(agreementId);
  if (record && record.fundingTxHash && (record.status === 'pending_payment' || (record.status as any) === 'pending_funding')) {
    record.status = 'funded';
    record.fundedAt = record.fundedAt || record.createdAt || nowIso();
    if (!record.deliveryDueAt && record.deadlineDays) {
      record.deliveryDueAt = new Date(new Date(record.fundedAt).getTime() + record.deadlineDays * 24 * 60 * 60 * 1000).toISOString();
    }
    record.updatedAt = nowIso();
    await db.updateServiceAgreement(record);
  }
  return record;
}

/**
 * List all service agreements for admin console with filtering and health summary.
 */
export async function listAdminAgreements(filters?: {
  status?: string;
  network?: string;
  search?: string;
  limit?: number;
  offset?: number;
}): Promise<{
  agreements: ServiceAgreementRecord[];
  total: number;
  summary: {
    total: number;
    funded: number;
    delivered: number;
    released: number;
    attentionRequired: number;
  };
}> {
  const all: ServiceAgreementRecord[] = await (db as any).listServiceAgreements();
  let filtered: ServiceAgreementRecord[] = [...all];

  if (filters?.status && filters.status !== 'all') {
    filtered = filtered.filter((a: ServiceAgreementRecord) => a.status === filters.status);
  }
  if (filters?.network && filters.network !== 'all') {
    filtered = filtered.filter((a: ServiceAgreementRecord) => (a.network || '').toLowerCase() === filters.network?.toLowerCase());
  }
  if (filters?.search) {
    const q = filters.search.toLowerCase();
    filtered = filtered.filter(
      (a: ServiceAgreementRecord) =>
        a.id.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.buyerUserId.toLowerCase().includes(q) ||
        a.sellerUserId.toLowerCase().includes(q) ||
        (a.releaseTxHash || '').toLowerCase().includes(q)
    );
  }

  // Sort newest first
  filtered.sort((a: ServiceAgreementRecord, b: ServiceAgreementRecord) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

  const summary = {
    total: all.length,
    funded: all.filter((a: ServiceAgreementRecord) => a.status === 'funded').length,
    delivered: all.filter((a: ServiceAgreementRecord) => a.status === 'delivered').length,
    released: all.filter((a: ServiceAgreementRecord) => a.status === 'released').length,
    attentionRequired: all.filter(
      (a: ServiceAgreementRecord) =>
        Boolean(a.lastError) ||
        (a.status === 'delivered' && !a.releasedAt) ||
        (a.status === 'released' && !a.releaseTxHash)
    ).length,
  };

  const limit = filters?.limit ?? 50;
  const offset = filters?.offset ?? 0;
  const paged = filtered.slice(offset, offset + limit);

  return {
    agreements: paged,
    total: filtered.length,
    summary,
  };
}
