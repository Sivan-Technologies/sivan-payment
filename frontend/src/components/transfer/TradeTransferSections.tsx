import { FormEvent, useState } from 'react';
import type { AssetControl, BalanceSummary, UnifiedBalance, BalanceTransferRecord, NetworkControl, OnrampOrderRecord, PaymentControl, SupplierPaymentRecord, SupplierRecord } from '../../types';
import { InlineTransactionTimeline } from '../transactions/TransactionsSection';

function PageHero({ title, subtitle, action }: { title: string; subtitle: string; action?: React.ReactNode }) { return <div className="page-hero"><div><h1>{title}</h1><p>{subtitle}</p></div>{action}</div>; }
function StepDot({ active, done, label }: { active: boolean; done: boolean; label: string }) { return <span className={`step-node ${active ? 'active' : ''} ${done ? 'done' : ''}`}><span>{done ? '✓' : '•'}</span>{label}</span>; }
function statusClass(status?: string) { if (!status) return 'pending'; if (['completed','kyc_approved','verified','active'].includes(status)) return 'success'; if (['failed','cancelled','kyc_rejected'].includes(status)) return 'danger'; return 'pending'; }
function friendlyStatus(status?: string) { const map: Record<string,string> = { created:'Started', pending:'Pending', approved:'Approved', completed:'Completed', failed:'Failed', cancelled:'Cancelled', requires_action:'Action required', awaiting_payment:'Awaiting payment', processing:'Processing', active:'Active' }; return status ? map[status] || status.replaceAll('_',' ') : 'Not started'; }
function Badge({ children, status }: { children: string; status?: string }) { return <span className={`badge ${statusClass(status)}`}>{children}</span>; }
function Empty({ children }: { children: string }) { return <div className="empty-state">{children}</div>; }
function shortRef(value?: string) { if (!value) return '—'; if (value.length <= 14) return value; return `${value.slice(0,8)}…${value.slice(-6)}`; }
function CustomSelect({ name, options, value, defaultValue, onChange, disabled = false }: { name: string; options: Array<{ value: string; label: string; helper?: string; disabled?: boolean }>; value?: string; defaultValue?: string; onChange?: (value: string) => void; disabled?: boolean }) { const firstEnabled = options.find((option) => !option.disabled)?.value || options[0]?.value || ''; const [internalValue,setInternalValue]=useState(defaultValue || value || firstEnabled); const [open,setOpen]=useState(false); const selectedValue=value ?? internalValue; const selected=options.find((option)=>option.value===selectedValue)||options.find((option)=>!option.disabled)||options[0]; const choose=(next:string)=>{setInternalValue(next); onChange?.(next); setOpen(false);}; return <div className="custom-select-wrap app-select-wrap"><input type="hidden" name={name} value={selected?.value || ''} /><button type="button" disabled={disabled} className={`custom-select-trigger ${open ? 'open' : ''}`} onClick={() => !disabled && setOpen((state)=>!state)}><span><strong>{selected?.label || 'Select'}</strong>{selected?.helper && <small>{selected.helper}</small>}</span><em>⌄</em></button>{open && <div className="custom-select-menu app-select-menu">{options.map((option)=><button type="button" disabled={option.disabled} className={option.value===selected?.value ? 'selected' : ''} key={option.value} onClick={()=>!option.disabled && choose(option.value)}><span>{option.label}</span>{option.helper && <small>{option.helper}</small>}</button>)}</div>}</div>; }
function Kv({ label, value }: { label: string; value?: string | number | null }) { return <div className="kv"><span>{label}</span><strong>{value ?? '—'}</strong></div>; }

export function BuyCryptoView({ hasUser, isVerified, bridgeBlockedReason, onVerifyWithId, feePercent, enabledControls, enabledAssets, enabledNetworks, orders, loading, onSubmit, onSell, onContinue, onSupport, onRefreshOrders }: { hasUser: boolean; isVerified: boolean; /** Why Bridge refuses this user, or undefined when it will not. Buying runs on Bridge, so `isVerified` (the country path) is not the gate here. */ bridgeBlockedReason?: string; /** Opens the modal on the DOCUMENT path explicitly - a Nigerian needs Bridge, not the bank form they already finished. */ onVerifyWithId: () => void; feePercent: string; enabledControls: PaymentControl[]; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[]; orders: OnrampOrderRecord[]; loading: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onSell: () => void; onContinue: () => void; onSupport: () => void; onRefreshOrders: () => Promise<void> }) {
  const [amount, setAmount] = useState('1000');
  const fee = (Number(amount || 0) * Number(feePercent || 0)) / 100;
  const receive = Math.max(0, Number(amount || 0) - fee);
  const latestOrder = orders[0];
  const assetOptions = [
    { value: 'usdc', label: 'USDC (USD Coin)' },
    { value: 'usdt', label: 'USDT (Tether) (Coming soon)', disabled: true }
  ];
  return <section className="app-page trade-premium"><div className="trade-page-head"><div><h1>Buy stablecoins</h1><p>Send fiat, receive stablecoins in your wallet.</p></div><div className="wizard-stepper"><button type="button" className="secondary-btn small" onClick={() => void onRefreshOrders()}>Refresh orders</button><StepDot active done={false} label="Quote" /><StepDot active={false} done={Boolean(latestOrder)} label="Review" /><StepDot active={false} done={false} label="Payment" /><StepDot active={false} done={latestOrder?.status === 'completed'} label="Tracking" /></div></div><div className="trade-grid"><article className="panel trade-card"><div className="seg"><button type="button" onClick={onSell}>↗ Sell</button><button type="button" className="active">↙ Buy</button></div>{!hasUser || !isVerified || bridgeBlockedReason ? <div className="empty-state">{/* THREE DIFFERENT REASONS, THREE DIFFERENT ANSWERS. Before this the
              Bridge case was not checked at all: a Nigerian at Level 1 passed
              `isVerified`, got the full form, filled it in, and was refused by
              the server after an 18-second wait with a gateway timeout. */}
              <p>{!hasUser ? 'Create your account before buying stablecoins.' : bridgeBlockedReason ?? 'Complete verification before buying stablecoins.'}</p>
              <button className="primary-btn" onClick={!hasUser ? onContinue : bridgeBlockedReason ? onVerifyWithId : onContinue}>{!hasUser ? 'Get started →' : bridgeBlockedReason ? 'Verify with ID →' : 'Verify account →'}</button></div> : <form onSubmit={onSubmit} className="form premium-form"><div className="quote-box large"><div><small>You pay</small><input name="amount" className="quote-amount-input" value={amount} inputMode="decimal" onChange={(event) => setAmount(event.target.value.replace(/[^0-9.]/g, ''))} /><small>Min 20 · Max 50,000</small></div><div><CustomSelect name="sourceCurrency" defaultValue={enabledControls[0]?.currency || 'usd'} options={enabledControls.map((control) => ({ value: control.currency, label: control.currency.toUpperCase(), helper: control.currency === 'usd' ? 'Wire & ACH (Active)' : control.currency === 'eur' ? 'SEPA (Active)' : control.currency === 'gbp' ? 'Faster Payments (Active)' : 'Coming soon' }))} /></div></div><div className="quote-swap">↓</div><div className="quote-box large"><div><small>You get</small><strong>{receive.toFixed(4)}</strong></div><div><CustomSelect name="destinationCurrency" defaultValue="usdc" options={assetOptions} /></div></div><label>Destination network<CustomSelect name="destinationChain" defaultValue={enabledNetworks[0]?.network || 'base'} options={enabledNetworks.map((network) => ({ value: network.network, label: network.label }))} /></label><label>Receiving wallet address<input name="destinationAddress" placeholder="Wallet address you control" required /></label><div className="quote-fees"><div><span>Rate</span><strong>1 fiat ≈ 1 stablecoin</strong></div><div><span>Fee ({feePercent}%)</span><strong className="danger">−${fee.toFixed(2)}</strong></div><div><span>Arrival</span><strong>Minutes after payment clears</strong></div><div><span>Payment method</span><strong>Bank transfer</strong></div></div><div className="verification-note">Your payment instructions are generated after you create the order. Send the exact amount and reference.</div><button className="primary-btn" disabled={loading || !enabledControls.length || !enabledAssets.length || !enabledNetworks.length}>{loading ? 'Creating order...' : 'Create buy order →'}</button></form>}{latestOrder && <OnrampInstructions order={latestOrder} />}</article><aside className="side-info-stack"><article className="panel"><h3>How this works</h3><ol className="ordered-steps"><li className="active">We generate a unique payment reference for your order.</li><li>Send the exact fiat amount to our licensed partner.</li><li>We detect payment and send crypto to your wallet.</li></ol></article><article className="security-card"><div className="security-icon">◈</div><div><h3>Secure & non-custodial</h3><p>Payments are processed by licensed partners. Funds are only held briefly during settlement.</p></div></article><article className="panel"><h3>Need help?</h3><p className="muted">Issues with a transfer, wrong network, or delayed payout? Our support team is on hand.</p><button className="secondary-btn" onClick={onSupport}>Contact support ↗</button></article></aside></div></section>;
}

function OnrampInstructions({ order }: { order: OnrampOrderRecord }) {
  const instructions = order.sourceDepositInstructions || {};
  const bankName = instructions.bank_name || instructions.bankName || 'Provided by Sivan';
  const bankAddress = instructions.bank_address || instructions.bankAddress;
  const accountNumber = instructions.bank_account_number || instructions.account_number || instructions.iban;
  const routingNumber = instructions.bank_routing_number || instructions.routing_number;
  const beneficiaryName = instructions.bank_beneficiary_name || instructions.account_name || instructions.beneficiary_name;
  const beneficiaryAddress = instructions.bank_beneficiary_address || instructions.beneficiary_address;
  const depositMessage = instructions.deposit_message || instructions.reference || order.providerReference || order.id;
  const rails = Array.isArray(instructions.payment_rails) ? instructions.payment_rails.join(', ') : (instructions.payment_rail || order.sourcePaymentRail);
  const copyValue = async (label: string, value?: string) => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Clipboard can be blocked in some browsers; the value remains visible.
    }
  };
  const paymentMemo = [
    `Amount: ${order.amount} ${order.sourceCurrency.toUpperCase()}`,
    `Reference: ${depositMessage}`,
    `Bank: ${bankName}`,
    accountNumber ? `Account: ${accountNumber}` : undefined,
    routingNumber ? `Routing: ${routingNumber}` : undefined,
    beneficiaryName ? `Beneficiary: ${beneficiaryName}` : undefined,
  ].filter(Boolean).join('\n');
  return <div className="onramp-instructions premium-onramp-instructions">
    <div className="onramp-instruction-head"><div><p className="eyebrow">One-time payment instructions</p><h3>Send exactly {order.amount} {order.sourceCurrency.toUpperCase()}</h3><p>Use these bank details once for this buy order. Sivan will deliver {order.netAmount || '—'} {order.destinationCurrency.toUpperCase()} to your wallet after payment clears.</p></div><Badge status={order.status}>{friendlyStatus(order.status)}</Badge></div>
    <div className="payment-reference-callout"><span>Required payment reference / memo</span><strong>{depositMessage}</strong><button className="secondary-btn small" type="button" onClick={() => copyValue('reference', depositMessage)}>Copy reference</button></div>
    <div className="onramp-bank-grid">
      <Kv label="Bank" value={bankName} />
      <Kv label="Account number" value={accountNumber || 'See provider instructions'} />
      <Kv label="Routing number" value={routingNumber || '—'} />
      <Kv label="Beneficiary" value={beneficiaryName || '—'} />
      <Kv label="Account type" value={String(rails || '').includes('ach') ? 'Checking' : 'Bank account'} />
      <Kv label="Bank address" value={bankAddress || '—'} />
      <Kv label="Order ID" value={order.id} />
    </div>
    <div className="quote-fees instruction-totals"><div><span>You pay</span><strong>{order.amount} {order.sourceCurrency.toUpperCase()}</strong></div><div><span>Sivan fee</span><strong className="danger">−{order.feeAmount || '0'} {order.sourceCurrency.toUpperCase()}</strong></div><div><span>You receive</span><strong>{order.netAmount || '—'} {order.destinationCurrency.toUpperCase()}</strong></div><div><span>Destination</span><strong>{order.destinationChain.replaceAll('_', ' ')} · {shortRef(order.destinationAddress)}</strong></div></div>
    <div className="split-actions"><button className="secondary-btn" type="button" onClick={() => copyValue('payment instructions', paymentMemo)}>Copy all details</button></div>
    {order.transactionTimeline && <InlineTransactionTimeline timeline={order.transactionTimeline} />}
    <div className="warning-box compact">Send the exact amount and include the reference/memo. Missing or incorrect references can delay matching and settlement.</div>
  </div>;
}
export function TransferCryptoView({ hasUser, isVerified, balance, unifiedBalance, transfers, suppliers, supplierPayments, enabledNetworks, loading, onSubmit, onCreateSupplier, onSupplierPayment, onContinue, onRefresh }: { hasUser: boolean; isVerified: boolean; balance: BalanceSummary | null; /** chain + ledger credits - holds. Preferred over `balance`. */ unifiedBalance?: UnifiedBalance | null; transfers: BalanceTransferRecord[]; suppliers: SupplierRecord[]; supplierPayments: SupplierPaymentRecord[]; enabledNetworks: NetworkControl[]; loading: boolean; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onCreateSupplier: (event: FormEvent<HTMLFormElement>) => void; onSupplierPayment: (event: FormEvent<HTMLFormElement>) => void; onContinue: () => void; onRefresh: () => Promise<void> }) {
  const [activeRoute, setActiveRoute] = useState<'crypto' | 'supplier' | 'user'>('crypto');
  const [supplierCurrency, setSupplierCurrency] = useState<'gbp' | 'usd' | 'eur' | 'mxn' | 'brl'>('gbp');
  const [supplierCurrencyOpen, setSupplierCurrencyOpen] = useState(false);
  const supplierCurrencyOptions: Array<{ value: 'gbp' | 'usd' | 'eur' | 'mxn' | 'brl'; label: string; helper: string }> = [
    { value: 'gbp', label: 'GBP', helper: 'Faster Payments (Active)' },
    { value: 'usd', label: 'USD', helper: 'ACH / Wire (Active)' },
    { value: 'eur', label: 'EUR', helper: 'SEPA (Active)' },
    { value: 'mxn', label: 'MXN', helper: 'SPEI' },
    { value: 'brl', label: 'BRL', helper: 'PIX' }
  ];
  const selectedSupplierCurrency = supplierCurrencyOptions.find((option) => option.value === supplierCurrency) || supplierCurrencyOptions[0];
  /**
   * ONE BALANCE, PREFERRING THE UNIFIED ONE.
   *
   * `balance` is the ledger journal, and the ledger is only ever credited by
   * virtual-account settlements and admin adjustments - so a user who received
   * crypto into their own Privy wallet saw 0 here while the Receive screen
   * showed the real figure. `unifiedBalance` is chain + ledger credits - holds.
   *
   * The ledger is kept as a fallback rather than removed: if the unified call
   * fails, showing the ledger figure is closer to the truth than showing zero.
   */
  const unified = unifiedBalance?.balances.find((item) => item.asset === 'usdc');
  const usdc = balance?.balances.find((item) => item.asset === 'usdc');
  const available = unified ? Number(unified.spendable || 0) : Number(usdc?.available || 0);
  const pending = unified ? Number(unified.pending || 0) : Number(usdc?.pending || 0);
  const held = unified ? Number(unified.held || 0) : Number(usdc?.held || 0);
  /** True when the chain read failed - NOT the same as a zero balance. */
  const chainUnavailable = Boolean(unified?.chainUnavailable);
  const networks = enabledNetworks.filter((network) => ['base', 'solana', 'avalanche_c_chain', 'polygon', 'ethereum', 'arbitrum'].includes(network.network));
  const approvedSuppliers = suppliers.filter((supplier) => supplier.status === 'approved');
  const supplierCurrencyLabel = { gbp: 'GBP · Faster Payments', usd: 'USD · ACH/Wire', eur: 'EUR · SEPA', mxn: 'MXN · SPEI', brl: 'BRL · PIX' }[supplierCurrency];
  return <section className="app-page transfer-premium"><PageHero title="Send & transfer" subtitle="Send settled USDC to wallets or pay suppliers through Sivan’s provider routing. Sivan does not hold a live USD fiat balance for you." action={<button className="primary-btn small" onClick={() => void onRefresh()}>Refresh USDC balance</button>} />
    <div className="transfer-route-grid route-tabs">
      <button type="button" className={`transfer-route-card ${activeRoute === 'crypto' ? 'active' : ''}`} onClick={() => setActiveRoute('crypto')}><span>⇆</span><div><strong>Send crypto</strong><small>Transfer settled USDC to your own wallet on a supported network.</small></div><Badge status="active">Available</Badge></button>
      <button type="button" className={`transfer-route-card ${activeRoute === 'supplier' ? 'active' : ''}`} onClick={() => setActiveRoute('supplier')}><span>▭</span><div><strong>Pay supplier / cross-border</strong><small>Crypto-to-fiat payout to a saved supplier bank account after compliance checks.</small></div><Badge status="pending">Review</Badge></button>
      <button type="button" className={`transfer-route-card ${activeRoute === 'user' ? 'active' : ''}`} onClick={() => setActiveRoute('user')}><span>◇</span><div><strong>Transfer to @username</strong><small>Instant transfer to another verified Sivan user.</small></div><Badge status="pending">Coming soon</Badge></button>
    </div>
    <div className="transfer-grid">
      {/* ACTIONS FIRST, BALANCE SECOND.
          Reported from a phone: the settled-USDC card sat at the top of this
          column, so a user opening Send & transfer met three zero balances
          before anything they could actually do. The thing you came here to
          do now leads, the balance it spends from sits under it, and history
          - the least urgent - comes last. */}
      {activeRoute === 'crypto' && <article className="panel form-panel transfer-form-card"><p className="eyebrow">Send crypto from settled balance</p><h3>Transfer USDC to a wallet</h3>{!hasUser || !isVerified ? <div className="empty-state"><p>{hasUser ? 'Complete verification before transferring crypto.' : 'Create your account before transferring crypto.'}</p><button className="primary-btn" onClick={onContinue}>{hasUser ? 'Verify account →' : 'Get started →'}</button></div> : <form className="form premium-form" onSubmit={onSubmit}><label>Asset<CustomSelect name="asset" defaultValue="usdc" options={[{ value: 'usdc', label: 'USDC (USD Coin)' }, { value: 'usdt', label: 'USDT (Tether), coming soon', disabled: true }]} /></label><label>Amount<input name="amount" inputMode="decimal" placeholder="20" required /></label><label>Destination network<CustomSelect name="network" defaultValue={networks[0]?.network || 'base'} options={networks.map((network) => ({ value: network.network, label: network.label }))} /></label><label>Destination wallet<input name="destinationAddress" placeholder="Wallet address you control" required /></label><label>Note optional<input name="note" placeholder="Internal note" /></label><div className="warning-box compact">Only send to a wallet on the selected network. Supplier/cross-border payouts use the Pay supplier route with saved bank details, not a stored USD fiat balance.</div><button className="primary-btn" disabled={loading || available <= 0}>{loading ? 'Creating transfer…' : available <= 0 ? 'No settled USDC available' : 'Review and create transfer →'}</button></form>}</article>}
      {activeRoute === 'supplier' && <><article className="panel supplier-directory-card"><div className="panel-head"><div><p className="eyebrow">Supplier directory</p><h3>Saved suppliers</h3></div><Badge status={suppliers.length ? 'active' : 'pending'}>{suppliers.length ? `${suppliers.length} saved` : 'None yet'}</Badge></div>{!suppliers.length ? <Empty>No suppliers added yet.</Empty> : <div className="list supplier-list">{suppliers.map((supplier) => <div className="list-item" key={supplier.id}><strong>{supplier.supplierName}</strong><Badge status={supplier.status}>{friendlyStatus(supplier.status)}</Badge><small>{supplier.currency.toUpperCase()} · {supplier.supplierCountry} · {supplier.bankName} · ****{supplier.accountLast4 || '----'}</small><small>{supplier.status === 'approved' ? 'Ready for supplier payment requests.' : supplier.reviewReason || 'Waiting for compliance review.'}</small></div>)}</div>}<div className="warning-box compact">Sivan chooses the execution provider in the background. Customers see a single Send & Transfer experience; provider diagnostics stay with operations.</div></article>
      {/* remaining lines unchanged */}
      <article className="panel form-panel supplier-form-card"><p className="eyebrow">Pay supplier / cross-border</p><h3>Add supplier bank</h3>{!hasUser || !isVerified ? <Empty>Complete verification before adding suppliers.</Empty> : <form className="form premium-form" onSubmit={onCreateSupplier}><label>Supplier business name<input name="supplierName" placeholder="ABC Trading Ltd" required /></label><div className="split"><label>Currency<input type="hidden" name="currency" value={supplierCurrency} /><div className="custom-select-wrap"><button type="button" className={`custom-select-trigger ${supplierCurrencyOpen ? 'open' : ''}`} onClick={() => setSupplierCurrencyOpen((open) => !open)}><span><strong>{selectedSupplierCurrency.label}</strong><small>{selectedSupplierCurrency.helper}</small></span><em>⌄</em></button>{supplierCurrencyOpen && <div className="custom-select-menu">{supplierCurrencyOptions.map((option) => <button type="button" className={option.value === supplierCurrency ? 'selected' : ''} key={option.value} onClick={() => { setSupplierCurrency(option.value); setSupplierCurrencyOpen(false); }}><span>{option.label}</span><small>{option.helper}</small></button>)}</div>}</div></label><label>Supplier country<input name="supplierCountry" defaultValue={supplierCurrency === 'gbp' ? 'GB' : supplierCurrency === 'usd' ? 'US' : supplierCurrency === 'mxn' ? 'MX' : supplierCurrency === 'brl' ? 'BR' : 'FR'} /></label></div><label>Bank name<input name="bankName" placeholder={supplierCurrency === 'gbp' ? 'Barclays' : supplierCurrency === 'usd' ? 'Lead Bank' : 'Supplier bank'} required /></label><label>Account owner name<input name="accountOwnerName" placeholder="ABC Trading Ltd" required /></label>{supplierCurrency === 'gbp' && <div className="split"><label>GBP account number<input name="gbAccountNumber" placeholder="12345678" required /></label><label>GBP sort code<input name="sortCode" placeholder="123456" required /></label></div>}{supplierCurrency === 'usd' && <div className="split"><label>USD account number<input name="accountNumber" placeholder="215268129123" required /></label><label>USD routing<input name="routingNumber" placeholder="101019644" required /></label></div>}{supplierCurrency === 'eur' && <><label>EUR IBAN<input name="ibanAccountNumber" placeholder="IE04MODR99035512826162" required /></label><label>BIC optional<input name="bic" placeholder="MODRIE22XXX" /></label></>}{supplierCurrency === 'mxn' && <label>CLABE<input name="clabeNumber" placeholder="18-digit CLABE" required /></label>}{supplierCurrency === 'brl' && <label>PIX key<input name="pixKey" placeholder="Supplier PIX key" required /></label>}<label>Supplier address<input name="street" placeholder="Supplier business address" /></label><div className="warning-box compact">{supplierCurrencyLabel} details are saved for compliance review. New suppliers stay pending until admin approval; AI can recommend, but never releases funds.</div><button className="primary-btn" disabled={loading}>{loading ? 'Adding supplier…' : 'Add supplier for review →'}</button></form>}</article>
      <article className="panel form-panel supplier-form-card"><p className="eyebrow">Create supplier payment</p><h3>Pay from settled USDC</h3>{!approvedSuppliers.length ? <Empty>Add a supplier and wait for approval before creating a payment.</Empty> : <form className="form premium-form" onSubmit={onSupplierPayment}><label>Supplier<CustomSelect name="supplierId" options={approvedSuppliers.map((supplier) => ({ value: supplier.id, label: supplier.supplierName, helper: `${supplier.currency.toUpperCase()} · approved` }))} /></label><label>Amount USDC<input name="amount" inputMode="decimal" placeholder="300" required /></label><label>Payment purpose<textarea name="paymentPurpose" placeholder="Invoice INV-1001 for software services" required /></label><label>Invoice URL<input name="invoiceUrl" placeholder="https://... optional but recommended" /></label><div className="warning-box compact">Sivan places a hold on settled USDC. Admin/backend risk controls release or reject. AI never releases funds.</div><button className="primary-btn" disabled={loading || available <= 0}>{loading ? 'Creating payment…' : available <= 0 ? 'No settled USDC available' : 'Create supplier payment →'}</button></form>}</article></>}
      {activeRoute === 'user' && <article className="panel transfer-history-card"><div className="panel-head"><div><p className="eyebrow">Coming soon</p><h3>Send to a Sivan user</h3></div><Badge status="pending">Roadmap</Badge></div><p className="muted">This future route will let approved Sivan customers send settled stablecoin value to another approved Sivan account without exposing provider internals.</p><div className="warning-box compact">For now, use Send crypto for wallet transfers or Pay supplier for cross-border bank payouts.</div></article>}
      <article className="panel transfer-balance-card"><p className="eyebrow">USDC available to send</p><h2>{available.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</h2><div className="balance-mini-grid"><Kv label="In your wallet" value={`${(unified ? Number(unified.chain || 0) : 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /><Kv label="Pending settlement" value={`${pending.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /><Kv label="Held for review" value={`${held.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /><Kv label="Spent" value={`${Number(usdc?.spent || 0).toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC`} /></div>{/* THE COPY HAD TO CHANGE WITH THE NUMBER.
          It said "an internal mirror of settled stablecoin funds from
          virtual-account deposits or approved adjustments" - which described
          the LEDGER, the very thing that could not see a user's own on-chain
          deposit. Leaving it would explain the old, wrong figure underneath
          the new, right one. */}
      {chainUnavailable
        ? <p className="sv-warn">We could not reach the network to read your wallet just now, so this figure may be incomplete. Your funds are safe.</p>
        : <p className="muted">This is what you can send right now: the balance in your Sivan wallet, plus any settled virtual-account deposits, minus anything held for review.</p>}</article>
      {activeRoute === 'crypto' && <article className="panel transfer-history-card"><div className="panel-head"><div><p className="eyebrow">Transfer history</p><h3>Crypto sends</h3></div></div>{!transfers.length ? <Empty>No crypto transfers from settled balance yet.</Empty> : <div className="list">{transfers.map((transfer) => <div className="list-item" key={transfer.transferId}><strong>{transfer.amount} {transfer.asset.toUpperCase()} → {transfer.network.replaceAll('_', ' ')}</strong><Badge status={transfer.status}>{friendlyStatus(transfer.status)}</Badge>{/* TWO DIFFERENT THINGS WERE BOTH BEING CALLED "the address".

                  This row printed shortRef(destinationAddress) with no label,
                  next to a "Processing" badge. Reported as "the other part did
                  not get his payment" - the user read that truncated string as
                  a transaction reference, saw it repeated across two sends,
                  and concluded nothing had moved.

                  Both sends had in fact settled on chain. The string was the
                  RECIPIENT, which is identical for two sends to the same
                  person, so of course it repeated.

                  Labelled now, and the transaction identifier shown beside it
                  when one exists - that is the thing a user can actually look
                  up, and the thing that differs per send. */}<small>To {shortRef(transfer.destinationAddress)} · {new Date(transfer.createdAt).toLocaleString()}</small>{(transfer.txHash || transfer.userOperationHash) && <small className="mono-ref">Tx {shortRef(transfer.txHash || transfer.userOperationHash)}</small>}{transfer.status === 'processing' && <small>Submitted to the network. This usually confirms within a minute.</small>}{transfer.note && <small>{transfer.note}</small>}</div>)}</div>}</article>}
      {activeRoute === 'supplier' && <article className="panel transfer-history-card"><div className="panel-head"><div><p className="eyebrow">Supplier payment history</p><h3>Cross-border payouts</h3></div></div>{!supplierPayments.length ? <Empty>No supplier payments yet.</Empty> : <div className="list">{supplierPayments.map((payment) => <div className="list-item" key={payment.id}><strong>{payment.amount} USDC → {payment.destinationCurrency.toUpperCase()}</strong><Badge status={payment.status}>{friendlyStatus(payment.status)}</Badge><small>{payment.supplier?.supplierName || shortRef(payment.supplierId)} · Risk {payment.riskLevel} · {new Date(payment.createdAt).toLocaleString()}</small><small>{payment.reviewReason}</small></div>)}</div>}</article>}
    </div>
    <article className="panel"><div className="panel-head"><div><p className="eyebrow">Stablecoin ledger</p><h3>Deposit, hold and spend trail</h3></div></div>{!balance?.ledger?.length ? <Empty>No stablecoin ledger entries yet. Deposit to your virtual account; after provider settlement, USDC can become spendable.</Empty> : <div className="table-wrap"><table className="table"><thead><tr><th>Type</th><th>Amount</th><th>Status</th><th>Source</th><th>Date</th></tr></thead><tbody>{balance.ledger.slice(0, 20).map((entry) => <tr key={entry.entryId}><td>{entry.kind.replaceAll('_', ' ')}</td><td>{entry.amount} {entry.asset.toUpperCase()}</td><td><Badge status={entry.status}>{friendlyStatus(entry.status)}</Badge></td><td>{entry.sourceType} · {shortRef(entry.sourceId)}</td><td>{new Date(entry.createdAt).toLocaleString()}</td></tr>)}</tbody></table></div>}</article>
  </section>;
}


