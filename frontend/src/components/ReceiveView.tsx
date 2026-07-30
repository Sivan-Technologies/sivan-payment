import { useEffect, useMemo, useState } from 'react';
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

function qrUrl(value: string) {
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(value)}`;
}

function truncateMiddle(value: string, lead = 10, tail = 8) {
  if (value.length <= lead + tail + 3) return value;
  return `${value.slice(0, lead)}…${value.slice(-tail)}`;
}

export function ReceiveView({
  wallets,
  enabledAssets,
  enabledNetworks,
  isVerified,
  loading,
  walletsEnabled,
  onCreateWallet,
  onRefresh,
}: {
  wallets: WalletRecord[];
  enabledAssets: AssetControl[];
  enabledNetworks: NetworkControl[];
  isVerified: boolean;
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

  const [chain, setChain] = useState<ReceiveChain | null>(availableChains[0] ?? null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!chain && availableChains.length) setChain(availableChains[0]);
  }, [availableChains, chain]);

  // Changing chain must reset the acknowledgement. Otherwise a user who
  // confirmed "I am sending on Solana" could switch to Base and see an
  // address already unlocked under the wrong confirmation.
  useEffect(() => {
    setAcknowledged(false);
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

  if (!isVerified) {
    return (
      <section className="app-page receive-page">
        <PageHead onRefresh={onRefresh} />
        <article className="receive-panel">
          <div className="receive-empty">
            <h3>Verify your identity first</h3>
            <p className="muted">
              Deposit addresses are issued after verification. This protects your funds and
              is required by our regulated partners.
            </p>
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

        <div className="receive-chain-grid">
          {availableChains.map((option) => {
            const optionMeta = CHAIN_META[option];
            const selected = option === activeChain;
            return (
              <button
                type="button"
                key={option}
                className={`receive-chain-card${selected ? ' selected' : ''}`}
                style={selected ? { borderColor: optionMeta.accent } : undefined}
                aria-pressed={selected}
                onClick={() => setChain(option)}
              >
                <span className="receive-chain-dot" style={{ background: optionMeta.accent }} />
                <strong>{optionMeta.label}</strong>
                <small>{optionMeta.note}</small>
              </button>
            );
          })}
        </div>
      </article>

      <article className="receive-panel">
        <div className="receive-chain-head">
          <div>
            <p className="eyebrow">Step 2</p>
            <h3>Confirm what you are sending</h3>
          </div>
          <span className="receive-chain-pill" style={{ background: meta.accent }}>
            {meta.label}
          </span>
        </div>

        {!assetsOnChain.length ? (
          <div className="receive-empty">
            <h3>No assets are enabled on {meta.label}</h3>
            <p className="muted">Choose a different network above.</p>
          </div>
        ) : (
          <>
            <div className="receive-warning">
              <strong>Send only {assetLabel} on {meta.label}.</strong>
              <span>
                Sending a different token, or using a different network, will result in
                permanent loss. Sivan cannot recover funds sent to the wrong network.
              </span>
              {unavailableHere.length > 0 && (
                <span className="receive-warning-sub">
                  {unavailableHere.join(' and ')} {unavailableHere.length > 1 ? 'are' : 'is'} not
                  available on {meta.label}. Switch networks to deposit{' '}
                  {unavailableHere.join(' or ')}.
                </span>
              )}
            </div>

            <label className="receive-ack">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I understand I must send <strong>{assetLabel}</strong> on the{' '}
                <strong>{meta.label}</strong> network.
              </span>
            </label>
          </>
        )}
      </article>

      {acknowledged && assetsOnChain.length > 0 && (
        <article className="receive-panel">
          <div className="receive-chain-head">
            <div>
              <p className="eyebrow">Step 3</p>
              <h3>Your {meta.label} deposit address</h3>
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
                  <strong>Test address — do not send funds</strong>
                  <span>
                    This is a simulated address generated for testing. It is not a real{' '}
                    {meta.label} account and nobody controls it. Any {assetLabel} sent here
                    is permanently lost and cannot be recovered by Sivan or anyone else.
                  </span>
                </div>
              )}

              <div className="receive-address-wrap">
                <div className="receive-qr" style={{ borderColor: meta.accent }}>
                  <img src={qrUrl(wallet.address)} alt={`${meta.label} deposit address QR code`} />
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
                    still works — try refreshing in a moment.
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
