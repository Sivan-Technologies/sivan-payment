import { useEffect, useRef, useState } from 'react';
import { chunkAddress } from './chunkAddress';

/**
 * THE LAST SCREEN BEFORE MONEY LEAVES.
 *
 * Reported: "when i click on Review and create transfer there is no confirm
 * screen". Correct - the button said "Review and create transfer" and did no
 * reviewing. It submitted straight to the API and broadcast on chain. The
 * button was lying about what it did, which is the worst kind of copy on a
 * destructive action.
 *
 * WHY THIS IS WORTH THE EXTRA CLICK, and it is not a general rule.
 *
 * An extra step is usually friction to be removed. Here it is the opposite,
 * because an on-chain send is the rare action that is:
 *
 *   irreversible   there is no recall. A wrong address is money gone, and no
 *                  amount of support can undo it.
 *   silent         a wrong-but-valid address fails no validation whatsoever.
 *                  Both this address and someone else's are 44 base58
 *                  characters, and nothing distinguishes them.
 *   typed by hand  or worse, pasted from a chat app, where clipboard-hijacking
 *                  malware substitutes an attacker's address of the same shape.
 *
 * The single highest-value thing this screen does is show the address BIG,
 * broken into readable chunks, with the first and last characters emphasised -
 * because those are the only parts a human actually verifies against their
 * other device.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *   - it does not re-validate what the server validates. The server is the
 *     authority on address format and on balance, and a second implementation
 *     here would drift from it and start disagreeing.
 *   - it does not promise a fee or an arrival time. Sivan sponsors gas, and
 *     inventing a number we do not have is worse than saying nothing.
 */

export interface TransferConfirmDetails {
  asset: string;
  amount: string;
  network: string;
  destinationAddress: string;
  note?: string;
  /** Spendable balance before this send, so the user sees what is left. */
  available: number;
  /**
   * Sivan's fee and what the recipient actually receives.
   *
   * QUOTED BY THE SERVER, never computed here. Two implementations of a pricing
   * rule is how they come to disagree, and a dialog that shows a different fee
   * from the one charged reads to a user as theft. Optional so the dialog still
   * renders while the quote is in flight, or if the endpoint fails - in which
   * case no fee line is shown at all rather than a guessed one.
   */
  fee?: string;
  netAmount?: string;
  /** Effective rate, e.g. "0.50". Server-stated for the same reason. */
  feePercent?: string;
  /**
   * The one-time recipient-account portion of `fee`, when one applies.
   *
   * Its own field rather than folded into `fee`, so the dialog can explain the
   * difference. A user sending $10 sees $0.55 where they paid $0.25 last week;
   * without a reason on screen that reads as arbitrary, which is the most
   * common way a fee becomes a support ticket.
   */
  newRecipientFee?: string;
  /** Server-stated. Never inferred client-side from the address. */
  createsRecipientAccount?: boolean;
  /** Testnet warning, server-stated. Never guessed. */
  networkMode?: 'mainnet' | 'testnet';
}

export function TransferConfirm({
  details,
  submitting,
  onConfirm,
  onCancel,
}: {
  details: TransferConfirmDetails;
  submitting: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const [acknowledged, setAcknowledged] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  /**
   * Escape closes, and focus moves into the dialog on open.
   *
   * Without the focus move a keyboard or screen-reader user stays parked on
   * the button behind the backdrop, which is both an accessibility failure and
   * a way to confirm something you were never shown.
   */
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
  const groups = chunkAddress(details.destinationAddress);
  const asset = details.asset.toUpperCase();
  const network = details.network.replaceAll('_', ' ');

  return (
    <div
      className="sv-modal-backdrop"
      // Backdrop clicks must NOT close this mid-submit: the request is already
      // in flight and dismissing it would leave the user unsure what happened.
      onClick={() => { if (!submitting) onCancel(); }}
      role="presentation"
    >
      <div
        className="sv-modal transfer-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="transfer-confirm-title"
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sv-modal-head">
          <span className="sv-modal-eyebrow">Confirm transfer</span>
          {/* The amount IS the headline. A user should be able to answer "how
              much am I sending" without reading a single label. */}
          <h2 id="transfer-confirm-title">{details.amount} {asset}</h2>
          {/* capitalize via CSS, not by mangling the value: the raw network
              string is what gets submitted, and the row below shows the same
              word - two different casings for one chain reads as two chains. */}
          <p className="sv-modal-sub">
            Sending on <b className="confirm-network-name">{network}</b>. This cannot be undone once confirmed.
          </p>
        </div>

        <div className="sv-modal-body transfer-confirm-body">
          {/*
            THE ADDRESS, AS BIG AS IT NEEDS TO BE.
            First and last groups are emphasised because those are the parts a
            person actually checks against their wallet on another device.
          */}
          <div className="confirm-address-block">
            <span className="confirm-label">Destination wallet</span>
            <div className="confirm-address" aria-label={details.destinationAddress}>
              {groups.map((group, index) => (
                <span
                  key={`${group}-${index}`}
                  className={index === 0 || index === groups.length - 1 ? 'edge' : undefined}
                >
                  {group}
                </span>
              ))}
            </div>
            <small className="confirm-address-hint">
              Check the first and last characters against the wallet you are sending to.
            </small>
          </div>

          <div className="confirm-rows">
            <div className="confirm-row">
              <span>Network</span>
              <strong className="confirm-network">
                {network}
                {details.networkMode === 'testnet' && <em className="confirm-testnet">Testnet</em>}
              </strong>
            </div>
            <div className="confirm-row">
              <span>Amount</span>
              <strong>{details.amount} {asset}</strong>
            </div>
            {details.fee !== undefined && (
              <>
                <div className="confirm-row">
                  {/*
                    "Transfer fee", NOT "network fee" or "gas fee".
                    Sivan sponsors the gas - the user never pays it - so calling
                    this a network fee would be a claim a user can disprove in
                    thirty seconds on a block explorer, which is far worse than
                    charging them openly.

                    The effective rate is shown beside it because a fee a user
                    understands is one they accept; the same number unexplained
                    is the one that generates a support ticket.
                  */}
                  {/* NO PERCENTAGE. It was shown so a user could see the rate
                      they were paying, but on a floored fee it reads as alarm:
                      a $0.25 minimum on a $5 send prints "(5.00%)", which
                      looks like a rate rather than the flat floor it is. The
                      cash amount beside it is the number that actually
                      matters, and it is exact. */}
                  <span>Transfer fee</span>
                  <strong className="confirm-fee">−{details.fee} {asset}</strong>
                </div>
                <div className="confirm-row">
                  {/* The number the RECIPIENT sees. With a deducted fee this is
                      not the amount typed, and a user discovering that after the
                      fact is the complaint this line prevents. */}
                  <span>Recipient gets</span>
                  <strong>{details.netAmount} {asset}</strong>
                </div>
                {details.createsRecipientAccount && Number(details.newRecipientFee ?? 0) > 0 && (
                  <div className="confirm-row confirm-row-note">
                    {/*
                      WHY THIS COSTS MORE, in the same breath as the number.
                      Called a recipient account setup, NOT a network or gas
                      fee: Sivan sponsors the gas, so naming it after the chain
                      is a claim a user can disprove on an explorer in thirty
                      seconds. Creating the account genuinely IS a one-time
                      on-chain cost.

                      "first time only" is the load-bearing half. Without it a
                      user sending $10 sees $0.55 where they paid $0.25 last
                      week and reads it as a price rise; with it, they read it
                      as a one-off and know the next send is cheaper.
                    */}
                    <span>
                      Includes {details.newRecipientFee} {asset} to set up this recipient on chain
                      <em> — first time only. Future sends to this address cost less.</em>
                    </span>
                  </div>
                )}
              </>
            )}
            <div className="confirm-row">
              <span>Balance after</span>
              {/* Shown because "can I afford this" is the second question
                  everyone asks, and the answer is otherwise arithmetic. */}
              <strong>{remaining.toLocaleString(undefined, { maximumFractionDigits: 6 })} {asset}</strong>
            </div>
            {details.note && (
              <div className="confirm-row">
                <span>Note</span>
                <strong>{details.note}</strong>
              </div>
            )}
          </div>

          {/*
            THE ACKNOWLEDGEMENT IS ABOUT THE NETWORK, not a generic "I agree".
            Sending USDC on the wrong chain to a valid-looking address is the
            single most common way people lose crypto, and it passes every
            validation we have. A checkbox that names the actual chain makes
            the user read the one word that matters.
          */}
          <label className="confirm-ack">
            <input
              type="checkbox"
              checked={acknowledged}
              disabled={submitting}
              onChange={(event) => setAcknowledged(event.target.checked)}
            />
            <span>
              I confirm this address is correct and accepts {asset} on <b>{network}</b>.
              Funds sent to the wrong address or network cannot be recovered.
            </span>
          </label>
        </div>

        <div className="transfer-confirm-actions">
          <button
            type="button"
            className="ghost-btn"
            onClick={onCancel}
            disabled={submitting}
          >
            Back
          </button>
          <button
            type="button"
            className="primary-btn"
            // Gated on the acknowledgement, so the confirm cannot be reached by
            // muscle memory from the previous screen's button position.
            disabled={!acknowledged || submitting}
            onClick={onConfirm}
          >
            {submitting ? 'Sending…' : `Send ${details.amount} ${asset}`}
          </button>
        </div>
      </div>
    </div>
  );
}
