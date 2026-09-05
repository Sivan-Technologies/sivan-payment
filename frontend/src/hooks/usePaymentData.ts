import { useCallback, useRef } from 'react';
import type { UnifiedBalance, BalanceSummary, BalanceTransferRecord, CustomerRecord, ExternalAccountRecord, IdentityStatus, OnrampOrderRecord, SupplierPaymentRecord, SupplierRecord, SupportTicketRecord, UserPreferencesRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, VerificationSummary, WithdrawalRecord, NgnTransferRecord, WalletDepositRecord, ServiceAgreementsSummary } from '../types';

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
  setUnifiedBalance: (value: UnifiedBalance | null) => void;
  setBalanceTransfers: (value: BalanceTransferRecord[]) => void;
  setSuppliers: (value: SupplierRecord[]) => void;
  setSupplierPayments: (value: SupplierPaymentRecord[]) => void;
  setSupportTickets: (value: SupportTicketRecord[]) => void;
  setUserPreferences: (value: UserPreferencesRecord | null) => void;
  setIdentityStatus: (value: IdentityStatus | null) => void;
  setServiceAgreements?: (value: ServiceAgreementsSummary) => void;
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
  /**
   * Naira on/off-ramps. Separate from withdrawals, which are Bridge-shaped
   * and can never hold an NGN transfer - which is why the Transactions page
   * showed "No transactions yet" to a user with a live sell.
   */
  setNgnTransfers: (value: NgnTransferRecord[]) => void;
  setWalletDeposits: (value: WalletDepositRecord[]) => void;
}) {
  const { userId, authToken, api, setCustomer, setAccounts, setWithdrawals, setOnrampOrders, setVirtualAccountRequests, setVirtualAccounts, setVirtualAccountTransactions, setBalance, setUnifiedBalance, setBalanceTransfers, setSuppliers, setSupplierPayments, setSupportTickets, setUserPreferences, setIdentityStatus, setServiceAgreements, setTwoFactorStatus, setVerificationSummary, setVerificationSummaryLoaded, setNgnTransfers, setWalletDeposits } = input;
  const inFlightPromiseRef = useRef<Promise<void> | null>(null);

  return useCallback(async () => {
    if (!userId || !authToken) return;
    if (inFlightPromiseRef.current) return inFlightPromiseRef.current;

    inFlightPromiseRef.current = (async () => {
      try {
        void (async () => {
          try {
            const summary = await api<VerificationSummary>(`/api/users/${userId}/verification-summary`);
            setVerificationSummary(summary);
          } catch {
            setVerificationSummary(null);
          } finally {
            setVerificationSummaryLoaded(true);
          }
        })();

        const [customerResult, accountsResult, withdrawalsResult, onrampOrdersResult, virtualAccountsResult, balanceResult, unifiedBalanceResult, balanceTransfersResult, suppliersResult, supplierPaymentsResult, supportTicketsResult, preferencesResult, identityResult, twoFactorResult, ngnTransfersResult, walletDepositsResult, serviceAgreementsResult] = await Promise.allSettled([
          api<CustomerRecord>(`/api/customers/${userId}`),
          api<ExternalAccountRecord[]>(`/api/users/${userId}/external-accounts`),
          api<WithdrawalRecord[]>(`/api/users/${userId}/withdrawals`),
          api<OnrampOrderRecord[]>(`/api/users/${userId}/onramp-orders`),
          api<{ requests: VirtualAccountRequestRecord[]; accounts: VirtualAccountRecord[]; transactions?: VirtualAccountTransactionRecord[]; events?: any[] }>(`/api/users/${userId}/virtual-accounts`),
          api<BalanceSummary>(`/api/users/${userId}/balance`),
          api<UnifiedBalance>(`/api/users/${userId}/balance/unified`),
          api<BalanceTransferRecord[]>(`/api/users/${userId}/balance/transfers`),
          api<SupplierRecord[]>(`/api/users/${userId}/suppliers`),
          api<SupplierPaymentRecord[]>(`/api/users/${userId}/supplier-payments`),
          api<SupportTicketRecord[]>(`/api/users/${userId}/support/tickets`),
          api<UserPreferencesRecord>(`/api/users/${userId}/preferences`),
          api<IdentityStatus>('/api/users/me/identity'),
          api<any>(`/api/users/${userId}/2fa`),
          api<NgnTransferRecord[]>(`/api/users/${userId}/ngn-transfers`),
          api<WalletDepositRecord[]>(`/api/users/${userId}/balance/deposits`),
          api<{ data: ServiceAgreementsSummary }>('/api/users/me/service-agreements')
        ]);
        if (customerResult.status === 'fulfilled') setCustomer(customerResult.value);
        if (accountsResult.status === 'fulfilled') setAccounts(accountsResult.value);
        if (withdrawalsResult.status === 'fulfilled') setWithdrawals(withdrawalsResult.value);
        if (onrampOrdersResult.status === 'fulfilled') setOnrampOrders(onrampOrdersResult.value);
        if (virtualAccountsResult.status === 'fulfilled') { setVirtualAccountRequests(virtualAccountsResult.value.requests ?? []); setVirtualAccounts(virtualAccountsResult.value.accounts ?? []); setVirtualAccountTransactions(virtualAccountsResult.value.transactions ?? []); }
        if (balanceResult.status === 'fulfilled') setBalance(balanceResult.value);
        if (unifiedBalanceResult.status === 'fulfilled') setUnifiedBalance(unifiedBalanceResult.value);
        if (balanceTransfersResult.status === 'fulfilled') setBalanceTransfers(balanceTransfersResult.value);
        if (suppliersResult.status === 'fulfilled') setSuppliers(suppliersResult.value);
        if (supplierPaymentsResult.status === 'fulfilled') setSupplierPayments(supplierPaymentsResult.value);
        if (supportTicketsResult.status === 'fulfilled') setSupportTickets(supportTicketsResult.value);
        if (preferencesResult.status === 'fulfilled') setUserPreferences(preferencesResult.value);
        if (identityResult.status === 'fulfilled') setIdentityStatus(identityResult.value);
        if (twoFactorResult.status === 'fulfilled') setTwoFactorStatus(twoFactorResult.value);
        if (ngnTransfersResult.status === 'fulfilled') setNgnTransfers(Array.isArray(ngnTransfersResult.value) ? ngnTransfersResult.value : []);
        if (walletDepositsResult.status === 'fulfilled') setWalletDeposits(Array.isArray(walletDepositsResult.value) ? walletDepositsResult.value : []);
        if (serviceAgreementsResult.status === 'fulfilled' && setServiceAgreements) {
          const resVal: any = serviceAgreementsResult.value;
          const dataVal = resVal?.data || resVal;
          setServiceAgreements(dataVal || { linked: false, deals: [] });
        }
      } finally {
        inFlightPromiseRef.current = null;
      }
    })();
    return inFlightPromiseRef.current;
  }, [userId, authToken, api, setCustomer, setAccounts, setWithdrawals, setOnrampOrders, setVirtualAccountRequests, setVirtualAccounts, setVirtualAccountTransactions, setBalance, setUnifiedBalance, setBalanceTransfers, setSuppliers, setSupplierPayments, setSupportTickets, setUserPreferences, setIdentityStatus, setServiceAgreements, setTwoFactorStatus, setVerificationSummary, setVerificationSummaryLoaded, setNgnTransfers, setWalletDeposits]);
}
