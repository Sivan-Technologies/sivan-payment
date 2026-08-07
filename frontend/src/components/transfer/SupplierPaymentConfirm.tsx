import { useEffect, useRef, useState } from 'react';

/**
 * CONFIRM A CROSS-BORDER PAYOUT BEFORE IT IS CREATED.
 *
 * The Send-crypto route got a review step; this one did not. Pressing "Create
 * supplier payment" submitted immediately - to a THIRD PARTY'S BANK ACCOUNT,
 * in a different currency, through a compliance path the user cannot reverse.
 * That is the higher-stakes of the two routes and it was the one without a
 * check.
 *
 * WHY THIS IS ITS OWN DIALOG rather than a variant of TransferConfirm.
 *
 * The two flows share a shape and almost nothing else. A crypto send has a
 * destination ADDRESS, a chain, a deducted fee and an irreversible broadcast.
 * A supplier payment has a NAMED BUSINESS, a bank in a country, a currency
 * conversion, and - crucially - it does not execute on confirm at all: it
 * places a hold and enters a review queue. Folding both into one component
 * would mean a pile of conditionals and a real risk of showing a user the
 * wrong promise about what happens next.
 *
 * WHAT THIS DIALOG MUST NOT DO: imply the money is gone. It is not. Sivan
 * holds the USDC and an admin releases or rejects it. Saying "this cannot be
 * undone", as the crypto dialog correctly does, would be false here.
 */
export interface SupplierPaymentConfirmDetails {
  /** The business being paid, as saved and approved. */
  supplierName: string;
  /** Their bank, for the "am I paying the right company" check. */
  bankName?: string;
  /** Last 4 of the destination account. Never the full number. */
  accountLast4?: string;
  supplierCountry?: string;
  /** What LEAVES the balance, always USDC. */
  amount: string;
  /** What the supplier is paid IN. Different from the amount's unit. */
  destinationCurrency: string;
  paymentPurpose: string;
  invoiceUrl?: string;
  /** Settled USDC available before this payment. */
  available: number;
}

export function SupplierPaymentConfirm({
  details,
  submitting,
  onConfirm,
  onCancel,
}: {
  details: SupplierPaymentConfirmDetails;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes and focus moves in, matching TransferConfirm. Without the
  // focus move a keyboard user stays parked behind the backdrop and can
  // confirm something they were never shown.
  useEffect(() => {
    panelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel, submitting]);

  const amount = Number(details.amount || 0);
  const remaining = Math.max(details.available - amount, 0);
  const currency = details.destinationCurrency.toUpperCase();

  return (
    <div
      className="sv-modal-backdrop"
      onClick={() => { if (!submitting) onCancel(); }}
      role="presentation"
    >
      <div
        className="sv-modal transfer-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="supplier-confirm-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sv-modal-head">
          <span className="sv-modal-eyebrow">Confirm supplier payment</span>
          <h2 id="supplier-confirm-title">{details.amount} USDC</h2>
          {/*
            NOT "this cannot be undone". It genuinely can - the money is held,
            not sent, until a human releases it. Promising irreversibility
            here would be a lie in the user's favour, which is still a lie and
            makes the eventual "pending review" screen look like a failure.
          */}
          <p className="sv-modal-sub">
            Paying <b className="confirm-network-name">{details.supplierName}</b> in {currency}.
            Sivan holds your USDC until this payment is reviewed.
          </p>
        </div>

        <div className="sv-modal-body transfer-confirm-body">
          {/*
            THE BENEFICIARY, PROMINENT - the equivalent of the wallet address
            on the crypto dialog. On this route the thing a user can get
            catastrophically wrong is paying the wrong company, so the name and
            the account they are about to be paid at lead the dialog.
          */}
          <div className="confirm-address-block">
            <span className="confirm-label">Paying</span>
            <div className="confirm-address" aria-label={details.supplierName}>
              <span className="edge">{details.supplierName}</span>
            </div>
            <small className="confirm-address-hint">
              {details.bankName ? `${details.bankName} · ` : ''}
              {details.accountLast4 ? `account ending ${details.accountLast4}` : 'Saved bank account'}
              {details.supplierCountry ? ` · ${details.supplierCountry}` : ''}
              . Check this is the supplier you mean to pay.
            </small>
          </div>

          <div className="confirm-rows">
            <div className="confirm-row">
              <span>Amount</span>
              <strong>{details.amount} USDC</strong>
            </div>
            <div className="confirm-row">
              {/*
                The two currencies are stated separately on purpose. USDC
                leaves the balance; the supplier receives GBP/EUR/USD. A single
                figure would leave the user guessing which one they are
                agreeing to.
              */}
              <span>Supplier receives</span>
              <strong>{currency}</strong>
            </div>
            <div className="confirm-row">
              <span>Balance after</span>
              <strong>{remaining.toLocaleString(undefined, { maximumFractionDigits: 6 })} USDC</strong>
            </div>
            <div className="confirm-row">
              <span>Purpose</span>
              <strong>{details.paymentPurpose}</strong>
            </div>
            {details.invoiceUrl && (
              <div className="confirm-row">
                <span>Invoice</span>
                <strong>Attached</strong>
              </div>
            )}
          </div>

          {/*
            WHAT HAPPENS NEXT, said before they commit.
            A user who confirms and lands on "pending review" without warning
            reads it as the payment having failed. Stating it here turns the
            same outcome into the expected one.
          */}
          <div className="details-box compact">
            <span>
              We place a hold on {details.amount} USDC. A Sivan reviewer releases or rejects the
              payout — this is not sent immediately, and the hold is returned if it is rejected.
            </span>
          </div>

          <label className="confirm-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={submitting}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            {/*
              The acknowledgement names the SUPPLIER, not a generic agreement.
              Paying the right amount to the wrong approved supplier passes
              every validation Sivan has, and it is the mistake this dialog
              exists to catch.
            */}
            <span>
              I confirm <b>{details.supplierName}</b> is the correct supplier and these payment
              details are accurate.
            </span>
          </label>
        </div>

        <div className="transfer-confirm-actions">
          <button type="button" className="ghost-btn" onClick={onCancel} disabled={submitting}>
            Back
          </button>
          <button
            type="button"
            className="primary-btn"
            disabled={!acknowledged || submitting}
            onClick={onConfirm}
          >
            {submitting ? 'Submitting…' : `Pay ${details.amount} USDC`}
          </button>
        </div>
      </div>
    </div>
  );
}
