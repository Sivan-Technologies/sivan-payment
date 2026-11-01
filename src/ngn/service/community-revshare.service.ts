// Sivan Ai . Community Partner and Admin Revenue Share Service
// Handles community group registry, partner code linking, and double-entry revshare allocation.
// Uses getSystemSetting / setSystemSetting for dual compatibility across Postgres & JSON database engines.
// Follows strict financial ledger integrity rules: no float leakage, zero-balance rounding drift.

import { db } from '../../database/json-database.js';
import { createBalanceLedgerEntry } from '../../balances/balance.service.js';

export interface CommunityGroupRecord {
  id: string;
  groupJid: string;
  groupName: string;
  adminActorId: string;
  adminPhone: string;
  referralCode: string;
  revsharePercent: number;
  isEarningEnabled: boolean;
  status: 'ACTIVE' | 'PAUSED' | 'SUSPENDED';
  totalDealsCount: number;
  totalVolumeNgn: number;
  totalRevenueEarnedNgn: number;
  createdAt: string;
  updatedAt: string;
}

export interface CommunityRevshareLedgerRecord {
  id: string;
  groupId: string;
  agreementId: string;
  adminActorId: string;
  dealAmountNgn: number;
  platformFeeNgn: number;
  revsharePercentApplied: number;
  revshareAmountNgn: number;
  allocationStatus: 'CREDITED' | 'SKIPPED_DISABLED' | 'SKIPPED_NO_PARTNER' | 'ZERO_FEE';
  notes?: string;
  createdAt: string;
}

export interface RevshareAllocationResult {
  allocated: boolean;
  groupId?: string;
  adminActorId?: string;
  dealAmountNgn: number;
  platformFeeNgn: number;
  revsharePercentApplied: number;
  revshareAmountNgn: number;
  allocationStatus: 'CREDITED' | 'SKIPPED_DISABLED' | 'SKIPPED_NO_PARTNER' | 'ZERO_FEE';
  reason?: string;
}

export interface DeveloperApiControls {
  fixedAppFeeNgn: number;
  developerRevsharePercent: number;
  isDeveloperApiActive: boolean;
  supportedCorridors: {
    nigeria: boolean;
    ghana: boolean;
    kenya: boolean;
  };
  updatedAt?: string;
}

export class CommunityRevshareService {
  private readonly GROUPS_SETTING_KEY = 'community_partner_groups';
  private readonly LEDGERS_SETTING_KEY = 'community_partner_ledgers';

  private async loadGroups(): Promise<CommunityGroupRecord[]> {
    const list = await db.getSystemSetting<CommunityGroupRecord[]>(this.GROUPS_SETTING_KEY);
    return Array.isArray(list) ? list : [];
  }

  private async saveGroups(groups: CommunityGroupRecord[]): Promise<void> {
    await db.setSystemSetting(this.GROUPS_SETTING_KEY, groups);
  }

  private async loadLedgers(): Promise<CommunityRevshareLedgerRecord[]> {
    const list = await db.getSystemSetting<CommunityRevshareLedgerRecord[]>(this.LEDGERS_SETTING_KEY);
    return Array.isArray(list) ? list : [];
  }

  private async saveLedgers(ledgers: CommunityRevshareLedgerRecord[]): Promise<void> {
    await db.setSystemSetting(this.LEDGERS_SETTING_KEY, ledgers);
  }

  /**
   * Registers a new community partner group with default or custom revshare settings.
   */
  async registerGroup(params: {
    groupJid?: string;
    groupName: string;
    adminActorId: string;
    adminPhone: string;
    referralCode: string;
    revsharePercent?: number;
    isEarningEnabled?: boolean;
  }): Promise<CommunityGroupRecord> {
    const groups = await this.loadGroups();
    const code = params.referralCode.trim().toUpperCase();

    const existingIdx = groups.findIndex(
      (g) => g.referralCode === code || (params.groupJid && g.groupJid === params.groupJid)
    );

    const record: CommunityGroupRecord = {
      id: existingIdx >= 0 ? groups[existingIdx].id : `cgrp_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      groupJid: params.groupJid ?? (existingIdx >= 0 ? groups[existingIdx].groupJid : ''),
      groupName: params.groupName,
      adminActorId: params.adminActorId,
      adminPhone: params.adminPhone,
      referralCode: code,
      revsharePercent: params.revsharePercent !== undefined ? params.revsharePercent : 20.0,
      isEarningEnabled: params.isEarningEnabled !== undefined ? params.isEarningEnabled : true,
      status: 'ACTIVE',
      totalDealsCount: existingIdx >= 0 ? groups[existingIdx].totalDealsCount : 0,
      totalVolumeNgn: existingIdx >= 0 ? groups[existingIdx].totalVolumeNgn : 0,
      totalRevenueEarnedNgn: existingIdx >= 0 ? groups[existingIdx].totalRevenueEarnedNgn : 0,
      createdAt: existingIdx >= 0 ? groups[existingIdx].createdAt : new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    if (existingIdx >= 0) {
      groups[existingIdx] = record;
    } else {
      groups.push(record);
    }

    await this.saveGroups(groups);
    return record;
  }

  /**
   * Validates and links a WhatsApp community group to an authenticated partner code.
   */
  async linkGroup(params: {
    groupJid: string;
    groupName: string;
    partnerCode: string;
  }): Promise<{ success: boolean; group?: CommunityGroupRecord; error?: string }> {
    const code = params.partnerCode.trim().toUpperCase();
    const groups = await this.loadGroups();

    const group = groups.find((g) => g.referralCode === code);
    if (!group) {
      return { success: false, error: 'Invalid or unrecognised Partner Code' };
    }

    group.groupJid = params.groupJid;
    group.groupName = params.groupName || group.groupName;
    group.updatedAt = new Date().toISOString();

    await this.saveGroups(groups);
    return { success: true, group };
  }

  /**
   * Allocates revenue share to a group administrator upon terminal RELEASED status of a Service Agreement.
   * Admin earnings can be toggled on/off, and custom percentage is dynamically applied per group.
   */
  async allocateRevshare(params: {
    agreementId: string;
    originatingGroupId?: string;
    partnerCode?: string;
    dealAmountNgn: number;
    platformFeeNgn: number;
  }): Promise<RevshareAllocationResult> {
    const { agreementId, originatingGroupId, partnerCode, dealAmountNgn, platformFeeNgn } = params;

    if (platformFeeNgn <= 0) {
      return {
        allocated: false,
        dealAmountNgn,
        platformFeeNgn,
        revsharePercentApplied: 0,
        revshareAmountNgn: 0,
        allocationStatus: 'ZERO_FEE',
        reason: 'Platform fee is zero; no revenue share distributed.',
      };
    }

    const groups = await this.loadGroups();
    let group: CommunityGroupRecord | undefined;

    if (originatingGroupId) {
      group = groups.find((g) => g.groupJid === originatingGroupId && g.status === 'ACTIVE');
    }

    if (!group && partnerCode) {
      const code = partnerCode.trim().toUpperCase();
      group = groups.find((g) => g.referralCode === code && g.status === 'ACTIVE');
    }

    if (!group) {
      return {
        allocated: false,
        dealAmountNgn,
        platformFeeNgn,
        revsharePercentApplied: 0,
        revshareAmountNgn: 0,
        allocationStatus: 'SKIPPED_NO_PARTNER',
        reason: 'No active community partner found for this identifier.',
      };
    }

    // Check the administrative earnings toggle
    if (!group.isEarningEnabled) {
      const ledgers = await this.loadLedgers();
      ledgers.push({
        id: `rev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        groupId: group.id,
        agreementId,
        adminActorId: group.adminActorId,
        dealAmountNgn,
        platformFeeNgn,
        revsharePercentApplied: group.revsharePercent,
        revshareAmountNgn: 0,
        allocationStatus: 'SKIPPED_DISABLED',
        notes: 'Admin earnings toggle disabled by administrator.',
        createdAt: new Date().toISOString(),
      });
      await this.saveLedgers(ledgers);

      return {
        allocated: false,
        groupId: group.id,
        adminActorId: group.adminActorId,
        dealAmountNgn,
        platformFeeNgn,
        revsharePercentApplied: group.revsharePercent,
        revshareAmountNgn: 0,
        allocationStatus: 'SKIPPED_DISABLED',
        reason: 'Admin earnings toggle is disabled for this community group.',
      };
    }

    // Calculate revshare based on configured group percentage (e.g. 20%)
    const revsharePercent = Number(group.revsharePercent) || 20.0;
    const revshareAmount = Math.floor((platformFeeNgn * revsharePercent) / 100);

    if (revshareAmount <= 0) {
      return {
        allocated: false,
        groupId: group.id,
        adminActorId: group.adminActorId,
        dealAmountNgn,
        platformFeeNgn,
        revsharePercentApplied: revsharePercent,
        revshareAmountNgn: 0,
        allocationStatus: 'ZERO_FEE',
        reason: 'Calculated revshare amount is below minimum threshold.',
      };
    }

    // 1. Record in community revshare ledger
    const ledgers = await this.loadLedgers();
    ledgers.push({
      id: `rev_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      groupId: group.id,
      agreementId,
      adminActorId: group.adminActorId,
      dealAmountNgn,
      platformFeeNgn,
      revsharePercentApplied: revsharePercent,
      revshareAmountNgn: revshareAmount,
      allocationStatus: 'CREDITED',
      notes: `Automated ${revsharePercent}% fee share for agreement ${agreementId}`,
      createdAt: new Date().toISOString(),
    });
    await this.saveLedgers(ledgers);

    // 2. Atomically credit admin spendable balance
    await createBalanceLedgerEntry(
      {
        userId: group.adminActorId,
        asset: 'ngn',
        amount: revshareAmount.toFixed(2),
        kind: 'credit_available',
        status: 'available',
        sourceType: 'community_partner_revshare',
        sourceId: agreementId,
        description: `Community partner fee share from deal in ${group.groupName}`,
        transferId: `revshare_${agreementId}`,
      },
      { actorType: 'system', actorId: 'community_revshare_engine' }
    );

    // 3. Update aggregate metrics on community group
    group.totalDealsCount = (group.totalDealsCount || 0) + 1;
    group.totalVolumeNgn = (group.totalVolumeNgn || 0) + dealAmountNgn;
    group.totalRevenueEarnedNgn = (group.totalRevenueEarnedNgn || 0) + revshareAmount;
    group.updatedAt = new Date().toISOString();

    await this.saveGroups(groups);

    return {
      allocated: true,
      groupId: group.id,
      adminActorId: group.adminActorId,
      dealAmountNgn,
      platformFeeNgn,
      revsharePercentApplied: revsharePercent,
      revshareAmountNgn: revshareAmount,
      allocationStatus: 'CREDITED',
    };
  }

  /**
   * Updates admin controls: toggling earnings on/off, updating revshare percent, or pausing group.
   */
  async updateAdminControls(params: {
    groupId: string;
    isEarningEnabled?: boolean;
    revsharePercent?: number;
    status?: 'ACTIVE' | 'PAUSED' | 'SUSPENDED';
  }): Promise<CommunityGroupRecord | null> {
    const groups = await this.loadGroups();
    const group = groups.find((g) => g.id === params.groupId);
    if (!group) return null;

    if (params.isEarningEnabled !== undefined) {
      group.isEarningEnabled = params.isEarningEnabled;
    }

    if (params.revsharePercent !== undefined) {
      group.revsharePercent = params.revsharePercent;
    }

    if (params.status !== undefined) {
      group.status = params.status;
    }

    group.updatedAt = new Date().toISOString();
    await this.saveGroups(groups);
    return group;
  }

  /**
   * Retrieves partner stats for the admin reporting cards.
   */
  async getAdminStats(adminActorId: string): Promise<{
    groupsCount: number;
    totalDeals: number;
    totalVolumeNgn: number;
    totalRevenueNgn: number;
    groups: CommunityGroupRecord[];
  }> {
    const groups = await this.loadGroups();
    const adminGroups = groups.filter((g) => g.adminActorId === adminActorId);

    const totalDeals = adminGroups.reduce((acc, g) => acc + (g.totalDealsCount || 0), 0);
    const totalVolumeNgn = adminGroups.reduce((acc, g) => acc + (g.totalVolumeNgn || 0), 0);
    const totalRevenueNgn = adminGroups.reduce((acc, g) => acc + (g.totalRevenueEarnedNgn || 0), 0);

    return {
      groupsCount: adminGroups.length,
      totalDeals,
      totalVolumeNgn,
      totalRevenueNgn,
      groups: adminGroups,
    };
  }

  /**
   * Retrieves summary of all community partner groups for the Sivan Admin Hub.
   */
  async getAllGroupsSummary(): Promise<{
    totalGroups: number;
    activeGroups: number;
    totalDeals: number;
    totalVolumeNgn: number;
    totalRevsharePaidNgn: number;
    groups: CommunityGroupRecord[];
  }> {
    const groups = await this.loadGroups();

    const activeGroups = groups.filter((g) => g.status === 'ACTIVE' && g.isEarningEnabled).length;
    const totalDeals = groups.reduce((acc, g) => acc + (g.totalDealsCount || 0), 0);
    const totalVolumeNgn = groups.reduce((acc, g) => acc + (g.totalVolumeNgn || 0), 0);
    const totalRevsharePaidNgn = groups.reduce((acc, g) => acc + (g.totalRevenueEarnedNgn || 0), 0);

    return {
      totalGroups: groups.length,
      activeGroups,
      totalDeals,
      totalVolumeNgn,
      totalRevsharePaidNgn,
      groups,
    };
  }

  private readonly DEVELOPER_CONTROLS_KEY = 'developer_api_controls';

  async getDeveloperControls(): Promise<DeveloperApiControls> {
    const controls = await db.getSystemSetting<DeveloperApiControls>(this.DEVELOPER_CONTROLS_KEY);
    if (controls && typeof controls.fixedAppFeeNgn === 'number') {
      return controls;
    }
    return {
      fixedAppFeeNgn: 50,
      developerRevsharePercent: 15.0,
      isDeveloperApiActive: true,
      supportedCorridors: {
        nigeria: true,
        ghana: true,
        kenya: true,
      },
    };
  }

  async updateDeveloperControls(input: Partial<DeveloperApiControls>): Promise<DeveloperApiControls> {
    const current = await this.getDeveloperControls();
    const updated: DeveloperApiControls = {
      ...current,
      ...input,
      supportedCorridors: {
        ...current.supportedCorridors,
        ...(input.supportedCorridors || {}),
      },
      updatedAt: new Date().toISOString(),
    };
    await db.setSystemSetting(this.DEVELOPER_CONTROLS_KEY, updated);
    return updated;
  }
}

export const communityRevshareService = new CommunityRevshareService();
