import { useCallback } from 'react';
import type { BalanceSummary, BalanceTransferRecord, CustomerRecord, ExternalAccountRecord, IdentityStatus, OnrampOrderRecord, SupplierPaymentRecord, SupplierRecord, SupportTicketRecord, UserPreferencesRecord, VirtualAccountRecord, VirtualAccountRequestRecord, VirtualAccountTransactionRecord, WithdrawalRecord } from '../types';

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
}) {
  const { userId, authToken, api, setCustomer, setAccounts, setWithdrawals, setOnrampOrders, setVirtualAccountRequests, setVirtualAccounts, setVirtualAccountTransactions, setBalance, setBalanceTransfers, setSuppliers, setSupplierPayments, setSupportTickets, setUserPreferences, setIdentityStatus, setTwoFactorStatus } = input;
  return useCallback(async () => {
    if (!userId || !authToken) return;
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
  }, [userId, authToken, api, setCustomer, setAccounts, setWithdrawals, setOnrampOrders, setVirtualAccountRequests, setVirtualAccounts, setVirtualAccountTransactions, setBalance, setBalanceTransfers, setSuppliers, setSupplierPayments, setSupportTickets, setUserPreferences, setIdentityStatus, setTwoFactorStatus]);
}

