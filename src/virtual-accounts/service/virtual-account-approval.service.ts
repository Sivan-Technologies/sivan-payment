import { approveVirtualAccountRequest, rejectVirtualAccountRequest } from './virtual-account.service.js';

export async function approveRequestWithAudit(requestId: string, reviewer: string) {
  return approveVirtualAccountRequest(requestId, reviewer);
}

export async function rejectRequestWithAudit(requestId: string, reviewer: string, reason: string) {
  return rejectVirtualAccountRequest(requestId, reviewer, reason);
}
