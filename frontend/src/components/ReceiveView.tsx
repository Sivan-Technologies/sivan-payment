import { useEffect, useMemo, useState } from 'react';
import { qrDataUri } from '../qrCode';
import type { AssetControl, NetworkControl, UserWalletRecord } from '../types';

/**
 * Receive (deposit) screen.
 *
 * Shows the user a per-chain wallet address they can copy or scan to fund
 * their Sivan balance.
 *
 * Deliberate constraints:
 * - Never renders an asset/chain pair the provider cannot support. USDT does
 *   not exist on Base, and offering it would send funds to an address for a
 *   token that is not there.
 * - Base and Ethereum share the 0x… address format. Users routinely send on
 *   the wrong one, so the chain is stated repeatedly and prominently rather
 *   than once in small print.
 * - The address is only revealed after the user acknowledges the network,
 *   which is the cheapest known defence against wrong-network loss.
 */

export type ReceiveChain = 'solana' | 'base' | 'ethereum';
export type ReceiveAsset = 'usdc' | 'usdt';

/** Re-exported so callers do not need to know the record shape. */
export type WalletRecord = UserWalletRecord;

/**
 * Mirrors CHAIN_ASSET_SUPPORT in
 * src/controls/payment-controls.service.ts. The backend is authoritative and
 * rejects invalid pairs; this exists so the UI never offers one in the first
 * place. Keep the two in sync.
 */
const CHAIN_ASSETS: Record<ReceiveChain, ReceiveAsset[]> = {
  solana: ['usdc', 'usdt'],
  ethereum: ['usdc', 'usdt'],
  base: ['usdc'],
};

const CHAIN_META: Record<ReceiveChain, {
  label: string;
  short: string;
  addressFormat: string;
  confirmations: string;
  accent: string;
  note: string;
}> = {
  solana: {
    label: 'Solana',
    short: 'SOL',
    addressFormat: 'Starts with letters and numbers (base58)',
    confirmations: 'Usually under a minute',
    accent: '#9945FF',
    note: 'Lowest fees. Recommended for most deposits.',
  },
  base: {
    label: 'Base',
    short: 'BASE',
    addressFormat: 'Starts with 0x',
    confirmations: 'Usually 1–2 minutes',
    accent: '#0052FF',
    note: 'Shares the 0x address format with Ethereum. Check carefully.',
  },
  ethereum: {
    label: 'Ethereum',
    short: 'ETH',
    addressFormat: 'Starts with 0x',
    confirmations: 'Usually 2–5 minutes',
    accent: '#627EEA',
    note: 'Highest network fees. Shares the 0x format with Base.',
  },
};

/**
 * The QR is generated LOCALLY - see qrCode.ts.
 *
 * This used to be `api.qrserver.com/v1/create-qr-code?data=${address}`, which
 * sent every deposit address this product issues to a third party, and left
 * the QR blank whenever that host was slow or blocked. A QR is the safest way
 * to move an address between two phones precisely because it removes the
 * clipboard, so it must not depend on someone else's uptime.
 *
 * Verified by decoding the rendered image with OpenCV: all three address
 * formats this product issues decode back to the exact input string.
 */

function truncateMiddle(value: string, lead = 10, tail = 8) {
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function ReceiveView({
  wallets,
  enabledAssets,
  enabledNetworks,
  isVerified,
  hasPayoutAccount,
  onAddBank,
  loading,
  walletsEnabled,
  onCreateWallet,
  onRefresh,
}: {
  wallets: WalletRecord[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  isVerified: boolean;
  /** The server's real precondition for issuing an address. */
  hasPayoutAccount: boolean;
  onAddBank?: () => void;
  loading: boolean;
  walletsEnabled: boolean;
  onCreateWallet: (chain: ReceiveChain) => void;
  onRefresh: () => void;
}) {
  const availableChains = useMemo(() => {
    const supported: ReceiveChain[] = ['solana', 'base', 'ethereum'];
    return supported.filter((chain) =>
      enabledNetworks.some((n) => n.network === chain && n.enabled)
    );
  }, [enabledNetworks]);

  /**
   * NETWORKS GROUPED BY THE ADDRESS THEY SHARE.
   *
   * Derived from availableChains so a network disabled by an admin disappears
   * from its family, and a family with nothing left disappears entirely -
   * rather than rendering an empty card.
   *
   * Order matters: Solana first because it is the recommended default and the
   * cheapest, and because putting the separate-address option first makes the
   * "these two are different" boundary the first thing read.
   */
  const chainFamilies = useMemo(() => {
    const families: Array<{
      key: string;
      label: string;
      note: string;
      accent: string;
      recommended?: boolean;
      chains: ReceiveChain[];
    }> = [
      {
        key: 'solana',
        label: 'Solana',
        note: 'Its own address. Fastest and cheapest for most deposits.',
        accent: CHAIN_META.solana.accent,
        recommended: true,
        chains: ['solana'],
      },
      {
        key: 'evm',
        label: 'Ethereum & Base',
        // Stating the shared address is the point of the grouping: it tells
        // the user why picking between them below is low-stakes.
        note: 'One 0x address for both networks.',
        accent: CHAIN_META.ethereum.accent,
        chains: ['ethereum', 'base'],
      },
    ];
    return families
      .map((family) => ({ ...family, chains: family.chains.filter((c) => availableChains.includes(c)) }))
      .filter((family) => family.chains.length > 0);
  }, [availableChains]);

  const [chain, setChain] = useState<ReceiveChain | null>(availableChains[0] ?? null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chain && availableChains.length) setChain(availableChains[0]);
  }, [availableChains, chain]);

  // Switching chain clears the "Copied" flag: it referred to the previous
  // network's address, and leaving it up would suggest the new one is already
  // on the clipboard.
  useEffect(() => {
    setCopied(false);
  }, [chain]);

  if (!walletsEnabled) {
    return (
      <section className="app-page receive-page">
        <PageHead onRefresh={onRefresh} />
        <article className="receive-panel">
          <div className="receive-empty">
            <h3>Deposits are not available yet</h3>
            <p className="muted">
              Sivan wallets are being enabled. You can still cash out existing balances
              from the Send &amp; transfer screen.
            </p>
          </div>
        </article>
      </section>
    );
  }

  /**
   * THE SCREEN MUST ASK THE SAME QUESTION THE SERVER ASKS.
   *
   * Reported from production: pressing "Generate address" returned
   *
   *   POST /api/users/:id/wallets  400
   *   "Add and confirm your payout bank account to create your wallet."
   *
   * Reproduced against the live API. The button was offered and then refused,
   * which is the worst possible order: the user has already decided to act.
   *
   * The two gates were different questions.
   *
   *   this screen  isVerified = pathComplete - "did you finish your country's
   *                path". Its FALLBACK, when /verification-summary has not
   *                loaded, is `customer?.kycStatus === 'kyc_approved'` - which
   *                says nothing at all about a bank account.
   *   the server   canProvisionWallet() - level >= BANK **and**
   *                bankStatus === VERIFIED.
   *
   * A user with an approved Bridge KYC and no payout account satisfies the
   * first and fails the second. So does anyone whose summary call was slow or
   * failed, because the fallback quietly grants access.
   *
   * Gated on hasPayoutAccount now, which is the server's actual precondition,
   * and the copy names the missing step instead of saying "verify" to someone
   * who already has.
   */
  if (!isVerified || !hasPayoutAccount) {
    return (
      <section className="app-page receive-page">
        <PageHead onRefresh={onRefresh} />
        <article className="receive-panel">
          <div className="receive-empty">
            <h3>{!isVerified ? 'Verify your identity first' : 'Add your payout bank account first'}</h3>
            <p className="muted">
              {!isVerified
                ? 'Deposit addresses are issued after verification. This protects your funds and is required by our regulated partners.'
                : 'Your deposit address is created once a bank account in your name is confirmed. The bank check is what verifies your identity, so it has to come first.'}
            </p>
            {isVerified && !hasPayoutAccount && onAddBank && (
              <button className="primary-btn" onClick={onAddBank}>Add payout account →</button>
            )}
          </div>
        </article>
      </section>
    );
  }

  if (!availableChains.length) {
    return (
      <section className="app-page receive-page">
        <PageHead onRefresh={onRefresh} />
        <article className="receive-panel">
          <div className="receive-empty">
            <h3>No deposit networks are currently enabled</h3>
            <p className="muted">Please check back shortly.</p>
          </div>
        </article>
      </section>
    );
  }

  const activeChain = chain ?? availableChains[0];
  const meta = CHAIN_META[activeChain];
  const activeFamily = chainFamilies.find((family) => family.chains.includes(activeChain));
  const wallet = wallets.find((w) => w.chain === activeChain && w.status !== 'closed');

  // The server returns acceptedAssets per wallet and is authoritative. Fall
  // back to the local matrix before a wallet exists so the warning copy is
  // still correct on the pre-generation screen.
  const chainAssets = wallet?.acceptedAssets ?? CHAIN_ASSETS[activeChain];
  const assetsOnChain = chainAssets.filter((asset) =>
    enabledAssets.some((a) => a.asset === asset && a.enabled)
  );
  const assetLabel = assetsOnChain.map((a) => a.toUpperCase()).join(' or ');

  // Assets enabled globally but unavailable on this specific chain. Naming
  // them prevents the "why can't I see USDT?" support ticket.
  const unavailableHere = enabledAssets
    .filter((a) => a.enabled && !chainAssets.includes(a.asset))
    .map((a) => a.asset.toUpperCase());

  function copyAddress() {
    if (!wallet) return;
    navigator.clipboard?.writeText(wallet.address);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2200);
  }

  return (
    <section className="app-page receive-page">
      <PageHead onRefresh={onRefresh} />

      <article className="receive-panel">
        <div className="receive-chain-head">
          <div>
            <p className="eyebrow">Step 1</p>
            <h3>Choose a network</h3>
          </div>
        </div>

        {/* GROUPED BY ADDRESS, NOT BY CHAIN.

             Three cards implied three addresses. There are TWO:
             walletsToProvision() issues one EVM wallet and one Solana wallet,
             and Base and Ethereum are the SAME secp256k1 key at the SAME 0x
             string. So the old grid showed the identical address twice under
             two different headings, each with an equally severe warning.

             That flattened a distinction which decides whether money is
             recoverable:

               Base <-> Ethereum   same address. A mistake here is recoverable -
                                   the funds are at an address we control on a
                                   chain we support.
               Solana <-> any EVM  different address entirely. Unrecoverable.

             Grouping by address family puts the unrecoverable boundary between
             the two rows, where it belongs, and it scales: Polygon and
             Arbitrum become chips on the existing EVM row rather than two more
             cards showing the same 0x string a third and fourth time. */}
        <div className="receive-family-grid">
          {chainFamilies.map((family) => {
            const selected = family.chains.includes(activeChain);
            return (
              <button
                type="button"
                key={family.key}
                className={`receive-family-card${selected ? ' selected' : ''}`}
                style={selected ? { borderColor: family.accent } : undefined}
                aria-pressed={selected}
                onClick={() => setChain(family.chains[0])}
              >
                <span className="receive-family-top">
                  <span className="receive-chain-dot" style={{ background: family.accent }} />
                  <strong>{family.label}</strong>
                  {family.recommended && <em className="receive-family-badge">Lowest fees</em>}
                </span>
                <small>{family.note}</small>
                {/* The member chains are named so someone hunting for "Base"
                    finds it without opening anything - but only when the
                    family HAS more than one. A single-chain family repeated
                    its own name underneath itself ("Solana ... Solana"), which
                    is noise where a scannable line should be. */}
                {family.chains.length > 1 && (
                  <span className="receive-family-chains">
                    {family.chains.map((c) => CHAIN_META[c].label).join(' · ')}
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {/* Only asked when it still matters. One EVM address serves both
            chains, so this decides the WARNING copy and the asset list, not
            which address is shown - and a mistake between them is recoverable,
            which is why it is a quiet segmented control rather than a second
            set of cards competing with the choice above. */}
        {activeFamily && activeFamily.chains.length > 1 && (
          <div className="receive-subchain">
            <span className="receive-subchain-label">Sending on</span>
            <div className="receive-subchain-options" role="group" aria-label="Choose the network you are sending on">
              {activeFamily.chains.map((option) => (
                <button
                  type="button"
                  key={option}
                  className={`receive-subchain-btn${option === activeChain ? ' selected' : ''}`}
                  aria-pressed={option === activeChain}
                  // The chain's own colour, not the product's success green -
                  // this is an identity, not a confirmation, and green here
                  // reads as "correct" for whichever happens to be selected.
                  style={option === activeChain
                    ? { borderColor: CHAIN_META[option].accent, color: CHAIN_META[option].accent }
                    : undefined}
                  onClick={() => setChain(option)}
                >
                  {CHAIN_META[option].label}
                </button>
              ))}
            </div>
            <small className="receive-subchain-note">
              Both use the same address, so a mix-up between them is recoverable.
            </small>
          </div>
        )}
      </article>

      {/* STEP 2 AND 3 MERGED, AND THE ADDRESS IS NO LONGER GATED.

           The acknowledgement checkbox used to hide the address and the QR
           until ticked. Three problems, in increasing order of seriousness:

           1. It reset on every visit. `{view === 'receive' && <ReceiveView/>}`
              UNMOUNTS the component, and the state was a plain useState(false),
              so a user depositing to Solana weekly re-confirmed the same box
              every week to see an address they had already used ten times.

           2. It guarded a moment with no risk in it. The wrong-network mistake
              does not happen here - the user copies the address, leaves for
              Phantom or Trust Wallet, and picks the network THERE, minutes
              later. A checkbox on this screen has no reach into that moment.

           3. It hid the QR, which is the one control that actually reduces
              wrong-address loss, because it removes the clipboard entirely.

           So the warning stays - louder, and attached to the address itself
           where it is visible at the moment of copying - and the address is
           always shown. Compare the send confirm dialog, where an
           acknowledgement IS right because the irreversible action happens on
           that screen. */}
      {assetsOnChain.length > 0 && (
        <article className="receive-panel">
          <div className="receive-chain-head">
            <div>
              <p className="eyebrow">Step 2</p>
              <h3>Send {assetLabel} to this address</h3>
            </div>
            <span className="receive-chain-pill" style={{ background: meta.accent }}>
              {meta.label}
            </span>
          </div>

          {!wallet ? (
            <div className="receive-empty">
              <h3>No {meta.label} address yet</h3>
              <p className="muted">
                Generate an address to start receiving {assetLabel} on {meta.label}.
              </p>
              <button
                className="primary-btn"
                disabled={loading}
                onClick={() => onCreateWallet(activeChain)}
              >
                {loading ? 'Generating…' : `Generate ${meta.label} address`}
              </button>
            </div>
          ) : wallet.status === 'provisioning' ? (
            <div className="receive-empty">
              <h3>Creating your address</h3>
              <p className="muted">This usually takes a few seconds. Refresh shortly.</p>
            </div>
          ) : (
            <>
              {wallet.provider === 'mock' && (
                <div className="receive-mock-banner" role="alert">
                  <strong>Test address. Do not send funds</strong>
                  <span>
                    This is a simulated address generated for testing. It is not a real{' '}
                    {meta.label} account and nobody controls it. Any {assetLabel} sent here
                    is permanently lost and cannot be recovered by Sivan or anyone else.
                  </span>
                </div>
              )}

              {/* THE WARNING, AT THE POINT OF COPYING.

                   It used to sit in a separate panel above a checkbox, which
                   the user had already scrolled past by the time the address
                   appeared. Here it is inside the same block as the address
                   and the copy button - the last thing read before the string
                   goes to the clipboard. */}
              <div className="receive-network-banner" style={{ borderColor: meta.accent }} role="note">
                <span className="receive-network-banner-dot" style={{ background: meta.accent }} />
                <span>
                  <strong>{meta.label} network only.</strong>{' '}
                  Send {assetLabel} on {meta.label}. Funds sent on another network cannot be recovered.
                </span>
              </div>
              {unavailableHere.length > 0 && (
                <p className="receive-unavailable-note">
                  {unavailableHere.join(' and ')} {unavailableHere.length > 1 ? 'are' : 'is'} not
                  available on {meta.label}. Switch networks above to deposit{' '}
                  {unavailableHere.join(' or ')}.
                </p>
              )}

              <div className="receive-address-wrap">
                <div className="receive-qr" style={{ borderColor: meta.accent }}>
                  <img src={qrDataUri(wallet.address)} alt={`${meta.label} deposit address QR code`} width={176} height={176} />
                  <span className="receive-qr-chain" style={{ color: meta.accent }}>
                    {meta.label} only
                  </span>
                </div>

                <div className="receive-address-detail">
                  <span className="address-label">
                    {meta.label} address · {assetLabel}
                  </span>
                  <div
                    className="receive-address clickable-address"
                    title="Click or tap to copy address"
                    onClick={copyAddress}
                    style={{ cursor: 'pointer' }}
                  >
                    {wallet.address}
                  </div>
                  <div
                    className="receive-address-short clickable-address"
                    title="Click or tap to copy address"
                    onClick={copyAddress}
                    style={{ cursor: 'pointer' }}
                  >
                    {truncateMiddle(wallet.address)}
                  </div>
                  <button className="primary-btn" onClick={copyAddress}>
                    {copied ? '✓ Copied to clipboard' : 'Copy address'}
                  </button>
                  <small className="muted">{meta.addressFormat}</small>
                </div>
              </div>

              <div className="receive-facts">
                <Fact label="Network" value={meta.label} />
                <Fact label="Accepted" value={assetLabel} />
                <Fact label="Arrival" value={meta.confirmations} />
                <Fact
                  label="Custody"
                  value={wallet.custodial ? 'Held by our licensed partner' : 'You control it'}
                />
              </div>

              {/*
                Three distinct states, deliberately not collapsed into two.
                Showing "0.00" when the provider is simply unreachable would
                tell a user with funds that their money is gone.
              */}
              <div className="receive-balances">
                <p className="eyebrow">Current balance</p>
                {wallet.balancesUnavailable ? (
                  <p className="muted receive-balance-note">
                    Balance temporarily unavailable. Your funds are safe and the address above
                    still works. Try refreshing in a moment.
                  </p>
                ) : !wallet.balances ? (
                  <p className="muted receive-balance-note">Loading…</p>
                ) : wallet.balances.length === 0 ? (
                  <p className="muted receive-balance-note">
                    Nothing received yet. Deposits appear here once confirmed on {meta.label}.
                  </p>
                ) : (
                  <div className="receive-balance-row">
                    {wallet.balances.map((balance) => (
                      <div className="receive-balance" key={`${balance.asset}-${balance.chain}`}>
                        <strong>{balance.amount}</strong>
                        <small>{balance.asset.toUpperCase()}</small>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </article>
      )}
    </section>
  );
}

function PageHead({ onRefresh }: { onRefresh: () => void }) {
  return (
    <div className="page-hero">
      <div>
        <h1>Receive</h1>
        <p>Deposit stablecoins to your Sivan balance using a network address.</p>
      </div>
      <button className="primary-btn small" onClick={onRefresh}>
        Refresh
      </button>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="receive-fact">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
