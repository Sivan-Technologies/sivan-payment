import { useCallback } from 'react';
import type { BalanceSummary, BalanceTransferRecord, CustomerRecord, ExternalAccountRecord, IdentityStatus, OnrampOrderRecord, SupplierPaymentRecord, SupplierRecord, SupportTicketRecord, UserPreferencesRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, VerificationSummary, WithdrawalRecord } from '../types';

export function usePaymentDataLoader(input: {
  userId?: string;
  authToken: string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  setCustomer: (value: CustomerRecord | null) => void;
  setAccounts: (value: ExternalAccountRecord[]) => void;
  setWithdrawals: (value: WithdrawalRecord[]) => void;
  setOnrampOrders: (value: OnrampOrderRecord[]) => void;
  setVirtualAccountRequests: (value: VirtualAccountRequestRecord[]) => void;
  setVirtualAccounts: (value: VirtualAccountRecord[]) => void;
  setVirtualAccountTransactions: (value: VirtualAccountTransactionRecord[]) => void;
  setBalance: (value: BalanceSummary | null) => void;
  setBalanceTransfers: (value: BalanceTransferRecord[]) => void;
  setSuppliers: (value: SupplierRecord[]) => void;
  setSupplierPayments: (value: SupplierPaymentRecord[]) => void;
  setSupportTickets: (value: SupportTicketRecord[]) => void;
  setUserPreferences: (value: UserPreferencesRecord | null) => void;
  setIdentityStatus: (value: IdentityStatus | null) => void;
  setTwoFactorStatus: (value: { userId: string; enabled: boolean; enabledAt?: string; lastVerifiedAt?: string; recoveryCodesRemaining?: number } | null) => void;
  /** Level, checks and CURRENT ceilings. The UI derives none of this itself. */
  setVerificationSummary: (value: VerificationSummary | null) => void;
  /**
   * Whether the question has been ANSWERED, separate from the answer.
   *
   * Set on settle, not on success: a rejection is an answer too. If it were
   * only set on success, a user whose summary call failed would sit on a
   * skeleton forever, which is a worse outcome than the degraded fallback.
   */
  setVerificationSummaryLoaded: (value: boolean) => void;
}) {
  const { userId, authToken, api, setCustomer, setAccounts, setWithdrawals, setOnrampOrders, setVirtualAccountRequests, setVirtualAccounts, setVirtualAccountTransactions, setBalance, setBalanceTransfers, setSuppliers, setSupplierPayments, setSupportTickets, setUserPreferences, setIdentityStatus, setTwoFactorStatus, setVerificationSummary, setVerificationSummaryLoaded } = input;
  return useCallback(async () => {
    if (!userId || !authToken) return;

    /**
     * THE SUMMARY IS AWAITED SEPARATELY, ON PURPOSE.
     *
     * It used to be the 14th entry in the Promise.allSettled below, and the
     * "have we got an answer yet" flag was set only after ALL FOURTEEN had
     * settled. So the verification page waited on /suppliers, /withdrawals
     * and /virtual-accounts - none of which it renders.
     *
     * Measured in a browser against the deployed test API: the summary's own
     * response landed at 10.1s and the skeleton was still up at 30.1s. Twenty
     * seconds of a user staring at a placeholder for data that had already
     * arrived.
     *
     * Caught by the race test, which requires the pending card within 12s.
     * Blocking a page on data it does not render is the same mistake as
     * rendering data that has not arrived, in the other direction.
     *
     * So it is issued FIRST and gated on ITSELF. The remaining calls proceed
     * concurrently and the verification page never waits for any of them.
     */
    const summaryPromise = api<VerificationSummary>(`/api/users/${userId}/verification-summary`)
      .then((value) => { setVerificationSummary(value); })
      // Settled, not fulfilled: a rejection is an answer too. Gating on
      // success alone would leave a user whose call failed on a skeleton
      // forever, which is worse than the degraded fallback view.
      .catch(() => undefined)
      .finally(() => setVerificationSummaryLoaded(true));

    const [customerResult, accountsResult, withdrawalsResult, onrampOrdersResult, virtualAccountsResult, balanceResult, balanceTransfersResult, suppliersResult, supplierPaymentsResult, supportTicketsResult, preferencesResult, identityResult, twoFactorResult] = await Promise.allSettled([
      api<CustomerRecord>(`/api/customers/${userId}`),
      api<ExternalAccountRecord[]>(`/api/users/${userId}/external-accounts`),
      api<WithdrawalRecord[]>(`/api/users/${userId}/withdrawals`),
      api<OnrampOrderRecord[]>(`/api/users/${userId}/onramp-orders`),
      api<{ requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; transactions?: VirtualAccountTransactionRecord[]; events?: any[] }>(`/api/users/${userId}/virtual-accounts`),
      api<BalanceSummary>(`/api/users/${userId}/balance`),
      api<BalanceTransferRecord[]>(`/api/users/${userId}/balance/transfers`),
      api<SupplierRecord[]>(`/api/users/${userId}/suppliers`),
      api<SupplierPaymentRecord[]>(`/api/users/${userId}/supplier-payments`),
      api<SupportTicketRecord[]>(`/api/users/${userId}/support/tickets`),
      api<UserPreferencesRecord>(`/api/users/${userId}/preferences`),
      api<IdentityStatus>('/api/users/me/identity'),
      api<any>(`/api/users/${userId}/2fa`)
    ]);
    if (customerResult.status === 'fulfilled') setCustomer(customerResult.value);
    if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
    if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
    if (onrampOrdersResult.status === 'fulfilled') setOnrampOrders(onrampOrdersResult.value);
    if (virtualAccountsResult.status === 'fulfilled') { setVirtualAccountRequests(virtualAccountsResult.value.requests ?? []); setVirtualAccounts(virtualAccountsResult.value.accounts ?? []); setVirtualAccountTransactions(virtualAccountsResult.value.transactions ?? []); }
    if (balanceResult.status === 'fulfilled') setBalance(balanceResult.value);
    if (balanceTransfersResult.status === 'fulfilled') setBalanceTransfers(balanceTransfersResult.value);
    if (suppliersResult.status === 'fulfilled') setSuppliers(suppliersResult.value);
    if (supplierPaymentsResult.status === 'fulfilled') setSupplierPayments(supplierPaymentsResult.value);
    if (supportTicketsResult.status === 'fulfilled') setSupportTickets(supportTicketsResult.value);
    if (preferencesResult.status === 'fulfilled') setUserPreferences(preferencesResult.value);
    if (identityResult.status === 'fulfilled') setIdentityStatus(identityResult.value);
    if (twoFactorResult.status === 'fulfilled') setTwoFactorStatus(twoFactorResult.value);
    // Awaited last so that callers which `await loadUserData()` - the
    // post-verification refresh does - still observe the applied summary,
    // without the PAGE having waited on the other thirteen calls.
    await summaryPromise;
  }, [userId, authToken, api, setCustomer, setAccounts, setWithdrawals, setOnrampOrders, setVirtualAccountRequests, setVirtualAccounts, setVirtualAccountTransactions, setBalance, setBalanceTransfers, setSuppliers, setSupplierPayments, setSupportTickets, setUserPreferences, setIdentityStatus, setTwoFactorStatus, setVerificationSummary, setVerificationSummaryLoaded]);
}

