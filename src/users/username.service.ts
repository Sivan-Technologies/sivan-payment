import { z } from 'zod';
import { db } from '../database/json-database.js';
import type { UserRecord } from '../database/types.js';
import { createAuditLog } from '../audit/audit.service.js';
import { badRequest, conflict, forbidden, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';
import { getUser } from './users.service.js';

const reservedUsernames = new Set([
  'admin', 'administrator', 'root', 'system', 'support', 'help', 'sivan', 'sivantech', 'sivanpay', 'sivanpayment', 'sivanpayments',
  'payment', 'payments', 'wallet', 'bank', 'api', 'auth', 'security', 'compliance', 'legal', 'official', 'owner', 'null', 'undefined',
  'bridge', 'circle', 'nomba', 'eversend', 'linkio', 'moderator', 'staff', 'team', 'escrow', 'notify', 'ai', 'ace'
]);

export const usernameSchema = z.object({
  username: z.string().min(3).max(32).transform(normalizeUsername)
});

export function normalizeUsername(value: string) {
  return value.trim().replace(/^@+/, '').toLowerCase();
}

export function validateUsername(username: string) {
  const normalized = normalizeUsername(username);
  if (!/^[a-z][a-z0-9_]{2,29}$/.test(normalized)) {
    throw badRequest('Username must be 3–30 characters, start with a letter, and use only lowercase letters, numbers, or underscores.');
  }
  if (normalized.includes('__') || normalized.endsWith('_')) throw badRequest('Username cannot end with an underscore or contain consecutive underscores.');
  if (reservedUsernames.has(normalized)) throw badRequest('This username is reserved. Choose another username.');
  return normalized;
}

async function findUsernameOwner(username: string): Promise<UserRecord | undefined> {
  const finder = (db as any).findUserByUsername as undefined | ((name: string) => Promise<UserRecord | undefined>);
  if (finder) return finder.call(db, username);
  const data = await db.read();
  return data.users.find((user) => user.username?.toLowerCase() === username.toLowerCase());
}

async function usernameLocked(userId: string, user: UserRecord) {
  if (!user.username) return false;
  const data = await db.read();
  const customer = data.customers.find((item) => item.userId === userId);
  const activityCount = (data.withdrawals ?? []).filter((item) => item.userId === userId).length
    + (data.onrampOrders ?? []).filter((item) => item.userId === userId).length
    + (data.supplierPayments ?? []).filter((item) => item.userId === userId).length;
  return customer?.kycStatus === 'kyc_approved' || activityCount > 0;
}

async function enforceUsernameRateLimit(userId: string) {
  const data = await db.read();
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const changes = (data.auditLogs ?? []).filter((log) => log.actorId === userId && log.action === 'user.username_updated' && new Date(log.createdAt).getTime() >= since);
  if (changes.length >= 3) throw forbidden('Username can only be changed 3 times in 24 hours before verification/activity. Try again later.');
}

export async function checkUsernameAvailability(rawUsername: string, userId?: string) {
  const username = validateUsername(rawUsername);
  const owner = await findUsernameOwner(username);
  return {
    username,
    available: !owner || owner.id === userId,
    reserved: reservedUsernames.has(username),
    ownerIsCurrentUser: Boolean(owner && owner.id === userId)
  };
}

export async function updateUsername(userId: string, input: z.infer<typeof usernameSchema>, context: { ipAddress?: string; userAgent?: string } = {}) {
  const username = validateUsername(input.username);
  const user = await getUser(userId).catch(() => { throw notFound('User'); });
  if (user.username === username) return user;

  const owner = await findUsernameOwner(username);
  if (owner && owner.id !== userId) throw conflict('This username is already taken.');

  if (await usernameLocked(userId, user)) {
    throw forbidden('Your username is locked after verification or payment activity. Contact Sivan Support to request a change.');
  }
  await enforceUsernameRateLimit(userId);

  const now = nowIso();
  const updated: UserRecord = { ...user, username, usernameUpdatedAt: now, updatedAt: now };
  await db.updateUserRecord(updated);
  await createAuditLog({
    actorType: 'user',
    actorId: userId,
    action: 'user.username_updated',
    resourceType: 'user',
    resourceId: userId,
    severity: 'warning',
    ipAddress: context.ipAddress,
    userAgent: context.userAgent,
    metadata: { previousUsername: user.username, username }
  });
  return updated;
}
