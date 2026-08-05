import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  filterBanks,
  isValidNuban,
  maskAccountNumber,
  quoteSecondsRemaining,
  shouldResolveAccount,
  type NgnBank,
  type NgnQuote,
  type ResolvedNgnBankAccount,
} from '../../ngnBank';
import { formatPayoutAmount } from '../../rails';
import { exceedsRemaining, offrampClears, typicalGasUsd } from '../../ngnMinimum';

/**
 * Where the naira goes, and what it is worth.
 *
 * The NGN off-ramp had neither of these. A Nigerian user could not say which
 * bank to pay - Bridge external accounts are routing numbers, sort codes and
 * IBANs, and a NUBAN is none of those - and nothing produced the quote that
 * POST /api/ngn/offramp/orders settles against.
 *
 * The order of the steps is the point: pick a bank, prove the account is real,
 * see the rate, then commit. Each step is blocked until the one before it
 * succeeds, because every one of them can fail for a reason the user can fix.
 */
/**
 * How many banks to show before the user types.
 *
 * Long enough to contain almost everyone's bank - the shortlist is ordered by
 * how commonly they are held - and short enough that BOTH the search box and
 * the "show all" escape hatch fit on a phone without scrolling.
 *
 * Eight was the first choice and the browser test caught it: at 420x900 the
 * eighth row pushed "Show all 169 banks" below the fold, so the shortlist
 * looked like the entire directory to anyone holding a microfinance account.
 * Six keeps the way out visible, and the six are OPay, PalmPay, Kuda,
 * Moniepoint, GTB and Access - which covers the overwhelming majority.
 */
const POPULAR_BANKS_SHOWN = 6;

/**
 * Drop the padding zeros an API amount arrives with.
 *
 * The quote returns fixed-scale decimal strings - "50.000000" - because that is
 * the right shape for money in transit, where the scale carries meaning. It is
 * the wrong shape to read: "You send 50.000000 USDC" makes a round number look
 * like a precise measurement. Trims the trailing zeros and any orphaned point,
 * so 50.000000 reads 50 and 50.500000 reads 50.5.
 *
 * Operates on the STRING rather than via Number(), so a value too large for a
 * double is shortened rather than quietly rounded.
 */
function trimTrailingZeros(amount: string | number): string {
  const text = String(amount);
  if (!text.includes('.')) return text;
  return text.replace(/\.?0+$/, '');
}

/**
 * Seconds as a countdown someone can read at a glance.
 *
 * "588s" requires the user to divide in their head to learn how long they have
 * to accept a quote. Minutes and seconds do not. Below a minute the bare second
 * count is clearer than "0m 12s", and negatives clamp to zero because an
 * expired quote is handled separately - it must never render "-3s".
 */
function formatCountdown(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}


/**
 * WHERE THE CRYPTO IS COMING FROM, ASKED UP FRONT.
 *
 * This used to be decided in silence, at the very END of the flow, by whether
 * sweepToRail() happened to find a funded wallet. A user with too small a
 * balance picked a bank, verified an account, spent a quote, accepted it - and
 * only then landed on a deposit address, with nothing explaining why. The
 * order looked identical to one placed by somebody who always intended to send
 * crypto from their own wallet.
 *
 * Asking first turns that dead end into a choice. 'balance' is validated
 * against what the user actually holds BEFORE a quote is spent; 'external'
 * skips the balance check entirely and treats the deposit address as the
 * destination the user asked for.
 */
export type NgnFundingSource = 'balance' | 'external';

export function NgnPayoutForm({
  userId,
  api,
  network,
  asset,
  breetMinimumUsd,
  remainingNgn,
  spendable,
  windowDays = 30,
  onReady,
  onCancel,
}: {
  userId: string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  network: string;
  asset: 'usdc' | 'usdt';
  breetMinimumUsd?: number;
  /**
   * What the user can actually sell from their Sivan balance.
   *
   * Same convention as remainingNgn, and for the same reason: `undefined`
   * means NOT LOADED and `null` means the balance could not be read. Neither
   * is zero, and showing "0.00 available" for a balance we simply failed to
   * fetch would talk a user out of a withdrawal they can afford.
   */
  spendable?: number | null;
  onReady: (payload: { quote: NgnQuote; account: ResolvedNgnBankAccount; fundingSource: NgnFundingSource }) => void;
  /**
   * The user's remaining NGN off-ramp headroom, from the server.
   *
   * Passed in rather than fetched here so there is ONE source of the number in
   * the app. null means genuinely uncapped; undefined means not loaded yet,
   * and in that case nothing is shown - an invented ceiling is worse than
   * none, because the user only discovers the truth when the quote fails.
   */
  remainingNgn?: number | null;
  windowDays?: number;
  onCancel: () => void;
}) {
  const [banks, setBanks] = useState<NgnBank[]>([]);
  const [bankQuery, setBankQuery] = useState('');
  /** Expands the shortlist to the full directory. Reset whenever a bank is cleared. */
  const [showAllBanks, setShowAllBanks] = useState(false);
  const [bankId, setBankId] = useState('');
  const [accountNumber, setAccountNumber] = useState('');
  const [resolved, setResolved] = useState<ResolvedNgnBankAccount | null>(null);
  const [resolving, setResolving] = useState(false);
  const [amount, setAmount] = useState('');
  const [quote, setQuote] = useState<NgnQuote | null>(null);
  const [quoting, setQuoting] = useState(false);
  const [error, setError] = useState('');
  const [now, setNow] = useState(Date.now());
  const [fundingSource, setFundingSource] = useState<NgnFundingSource>('balance');

  const estimatedGasUsd = typicalGasUsd(network);

  useEffect(() => {
    let cancelled = false;
    api<NgnBank[]>(`/api/ngn/banks?userId=${encodeURIComponent(userId)}`)
      .then((list) => { if (!cancelled) setBanks(list ?? []); })
      .catch(() => { if (!cancelled) setError('Could not load the bank list. Try again shortly.'); });
    return () => { cancelled = true; };
  }, [api, userId]);

  // Drives the quote countdown. A quote is priced against a moving rate, so a
  // stale one must visibly expire rather than silently settle at a number the
  // user was never shown.
  useEffect(() => {
    if (!quote?.expiresAt) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [quote?.expiresAt]);

  /**
   * NOT slice(0, 40) any more.
   *
   * When idle the list is capped SHORT, because the top of it is now the banks
   * most people actually hold - 169 alphabetical rows opened on Abbey Mortgage
   * Bank and buried OPay at #26. When searching, every match is shown: a user
   * who typed something specific wants all of it, and the result sets are
   * small (the widest real query, "bank", is 95 and the rest are single
   * digits).
   */
  const searching = bankQuery.trim().length > 0;
  const matches = useMemo(() => filterBanks(banks, bankQuery), [banks, bankQuery]);
  const visibleBanks = useMemo(
    () => (searching || showAllBanks ? matches : matches.slice(0, POPULAR_BANKS_SHOWN)),
    [matches, searching, showAllBanks]
  );
  const hiddenBankCount = searching || showAllBanks ? 0 : Math.max(matches.length - POPULAR_BANKS_SHOWN, 0);
  const secondsLeft = quoteSecondsRemaining(quote, now);
  const quoteExpired = Boolean(quote?.expiresAt) && secondsLeft <= 0;

  /**
   * Resolve the account to its registered name.
   *
   * Only fires on a complete 10-digit NUBAN with a bank chosen. Resolution is
   * a paid, rate-limited call at the provider; firing per keystroke spends a
   * request per digit and shows failures for a number still being typed.
   */
  const resolveAccount = useCallback(async () => {
    if (!shouldResolveAccount(bankId, accountNumber)) return;
    setResolving(true);
    setError('');
    setResolved(null);
    // A changed account invalidates any quote priced against the old one.
    setQuote(null);
    try {
      const result = await api<ResolvedNgnBankAccount>(
        `/api/ngn/bank-account/resolve?userId=${encodeURIComponent(userId)}&bankId=${encodeURIComponent(bankId)}&accountNumber=${encodeURIComponent(accountNumber)}`
      );
      setResolved(result);
    } catch (err) {
      setError((err as Error).message || 'That account could not be verified.');
    } finally {
      setResolving(false);
    }
  }, [api, userId, bankId, accountNumber]);

  useEffect(() => {
    if (shouldResolveAccount(bankId, accountNumber)) void resolveAccount();
    else setResolved(null);
  }, [bankId, accountNumber, resolveAccount]);

  const amountUsd = Number(amount || 0);

  /**
   * Would this amount breach the user's 30-day ceiling?
   *
   * The limit is denominated in NGN and the input is in USD, so the two cannot
   * be compared until there is a rate. Sivan holds no naira and the rate moves,
   * so the only honest conversion is the one the QUOTE returns - anything else
   * is a guess that would tell the user a different number from the one the
   * server enforces.
   *
   * Consequence, deliberately accepted: the breach is reported after the first
   * quote rather than while typing. A wrong answer shown earlier is worse than
   * a right one shown a second later, and the server rejects it either way.
   */
  const quotedNgn = quote ? Number(quote.destinationAmount || 0) : 0;
  const overLimit = exceedsRemaining(quotedNgn, remainingNgn);

  const naira = (value: number) => `₦${value.toLocaleString('en-NG')}`;
  const floorVerdict = breetMinimumUsd !== undefined && amountUsd > 0
    ? offrampClears({ amountUsd, breetMinimumUsd, estimatedGasUsd })
    : undefined;

  /**
   * Selling more than the balance holds, caught while typing.
   *
   * Only meaningful when selling FROM the balance, and only when the number is
   * actually known - an unread balance (null) or one still loading (undefined)
   * must not manufacture a shortfall, because the server is the authority and
   * a false block here stops a legitimate withdrawal.
   */
  const balanceKnown = fundingSource === 'balance' && typeof spendable === 'number';
  const shortfallUsd = balanceKnown && amountUsd > spendable! ? amountUsd - spendable! : 0;
  const overBalance = shortfallUsd > 0;

  const usd = (value: number) => value.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  async function getQuote() {
    setError('');
    if (!resolved) return setError('Verify your bank account first.');
    if (!(amountUsd > 0)) return setError('Enter an amount.');
    // Checked before spending a quote on an amount that cannot settle.
    if (floorVerdict && !floorVerdict.clears) return setError(floorVerdict.reason ?? 'Amount is below the minimum.');
    /**
     * Refused BEFORE the quote, not after acceptance.
     *
     * The server would eventually decline to sweep this, but only once the
     * quote had been priced and consumed - leaving the user on a deposit
     * address they did not ask for. Stopping here keeps the quote and gives
     * them a number they can act on.
     */
    if (overBalance) {
      return setError(
        `You have ${usd(spendable!)} ${asset.toUpperCase()} available to sell. ` +
        `Lower the amount, or choose "I'll send crypto myself" to send from another wallet.`
      );
    }

    setQuoting(true);
    try {
      const result = await api<NgnQuote>(
        `/api/ngn/quote?userId=${encodeURIComponent(userId)}&direction=offramp&sourceCurrency=${asset}&destinationCurrency=ngn&sourceAmount=${encodeURIComponent(amount)}`
      );
      setQuote(result);
    } catch (err) {
      setError((err as Error).message || 'Could not price that withdrawal.');
    } finally {
      setQuoting(false);
    }
  }

  const selectedBank = banks.find((bank) => bank.id === bankId);

  return (
    <article className="panel form-panel trade-card">
      <p className="eyebrow">Step 1</p>
      <h3>Where should the naira go?</h3>
      <p className="muted">Choose your bank and enter your account number. We confirm the account name before anything is sent.</p>

      <div className="form premium-form">
        {/* ASKED FIRST, because it changes what every later step means.
 
            Placed above the bank picker deliberately: choosing "I'll send
            crypto myself" turns off the balance check entirely, and a user who
            discovers that option AFTER being blocked on an amount has already
            been told they cannot do something they can. */}
        <div className="seg" role="group" aria-label="Where the crypto comes from">
          <button
            type="button"
            className={fundingSource === 'balance' ? 'active' : ''}
            onClick={() => { setFundingSource('balance'); setError(''); }}
          >
            From my Sivan balance
          </button>
          <button
            type="button"
            className={fundingSource === 'external' ? 'active' : ''}
            onClick={() => { setFundingSource('external'); setError(''); }}
          >
            I'll send crypto myself
          </button>
        </div>
        {fundingSource === 'external' && (
          <p className="field-hint">
            We'll show you an address to send {asset.toUpperCase()} to on {network}. The naira is paid out once it arrives.
          </p>
        )}

        <label>Bank
          <input
            placeholder="Search your bank, e.g. GTB or Access"
            value={bankQuery}
            onChange={(event) => setBankQuery(event.target.value)}
          />
        </label>

        {!bankId && (
          <div className="bank-list">
            {/* THE LIST HAS TO SAY WHICH STATE IT IS IN.
 
                Reported from a phone: the picker opens on a wall of 169
                alphabetical rows - Abbey Mortgage, ASO Savings, Bowen
                Microfinance - and nothing indicates that typing narrows it or
                that the common banks exist. Three states, each labelled:
                loading, a short common-bank list, or search results. */}
            {!banks.length && !error && (
              <div className="bank-list-status" aria-live="polite">
                <span className="sv-spinner" /> Loading banks…
              </div>
            )}
            {Boolean(banks.length) && !searching && (
              <p className="bank-list-label">Common banks</p>
            )}
            {searching && Boolean(visibleBanks.length) && (
              <p className="bank-list-label" aria-live="polite">
                {visibleBanks.length} {visibleBanks.length === 1 ? 'match' : 'matches'} for “{bankQuery.trim()}”
              </p>
            )}
            {visibleBanks.map((bank) => (
              <button
                type="button"
                key={bank.id}
                className="bank-option"
                onClick={() => { setBankId(bank.id); setBankQuery(bank.name); }}
              >
                {bank.logoUrl && <img src={bank.logoUrl} alt="" width={20} height={20} />}
                <span>{bank.name}</span>
              </button>
            ))}
            {Boolean(bankQuery) && !visibleBanks.length && (
              <p className="muted">No bank matches “{bankQuery}”. Check the spelling, or try the short name like GTB or UBA.</p>
            )}
          </div>
        )}

        {/* OUTSIDE the scrolling list, deliberately.
 
            Placed inside it first, and the browser screenshot showed why that
            was wrong: .bank-list scrolls, so "Show all 169 banks" sat below the
            fold under the eight shortlisted rows. It was in the DOM and
            invisible - which is the same as absent for anyone holding a
            microfinance account, and worse, because it looks like the
            shortlist is the whole directory.
 
            Nothing is hidden by the shortlist, only deferred; this is the way
            to the rest and it has to be seen without scrolling. */}
        {!bankId && hiddenBankCount > 0 && (
          <button type="button" className="bank-list-more" onClick={() => setShowAllBanks(true)}>
            Show all {matches.length} banks
          </button>
        )}

        {bankId && (
          <>
            <div className="details-box compact">
              <span>{selectedBank?.name}</span>
              <button type="button" className="ghost-btn small" onClick={() => { setBankId(''); setBankQuery(''); setResolved(null); setQuote(null); setShowAllBanks(false); }}>Change</button>
            </div>

            <label>Account number
              <input
                inputMode="numeric"
                maxLength={10}
                placeholder="10-digit NUBAN"
                value={accountNumber}
                onChange={(event) => setAccountNumber(event.target.value.replace(/\D/g, '').slice(0, 10))}
              />
              {Boolean(accountNumber) && !isValidNuban(accountNumber) && (
                <span className="field-hint">A Nigerian account number is exactly 10 digits.</span>
              )}
            </label>
          </>
        )}

        {resolving && <p className="muted">Checking that account…</p>}

        {resolved && (
          <div className="details-box">
            <strong>{resolved.accountName}</strong>
            <span className="muted">{resolved.bankName ?? selectedBank?.name} · {maskAccountNumber(resolved.accountNumber)}</span>
            {!resolved.trustworthy && (
              // Sandbox resolves ANY account number to a plausible name, so
              // presenting this as confirmation would be a lie.
              <span className="field-hint">Test environment. This name is simulated and does not confirm a real account.</span>
            )}
          </div>
        )}

        {resolved && (
          <label>Amount to withdraw ({asset.toUpperCase()})
            <div className="amount-with-max">
              <input
                inputMode="decimal"
                placeholder={breetMinimumUsd ? String(breetMinimumUsd) : '20'}
                value={amount}
                onChange={(event) => { setAmount(event.target.value.replace(/[^0-9.]/g, '')); setQuote(null); }}
              />
              {/* Only when selling from a balance we have actually read.
                  A Max button that fills in a number we are not sure of is
                  worse than no Max button. */}
              {balanceKnown && spendable! > 0 && (
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => { setAmount(String(spendable)); setQuote(null); setError(''); }}
                >
                  Max
                </button>
              )}
            </div>
            {/* The balance, where the amount is decided - which is the only
                place it changes what someone types. */}
            {fundingSource === 'balance' && (
              <span className="field-hint">
                {spendable === undefined
                  ? 'Checking your balance…'
                  : spendable === null
                    ? 'We could not read your balance right now. You can still continue.'
                    : `${usd(spendable)} ${asset.toUpperCase()} available to sell.`}
              </span>
            )}
            {overBalance && (
              <span className="field-hint danger">
                That is {usd(shortfallUsd)} {asset.toUpperCase()} more than you have available.
              </span>
            )}
            {floorVerdict && !floorVerdict.clears && (
              <span className="field-hint danger">{floorVerdict.reason}</span>
            )}
            {breetMinimumUsd !== undefined && !amount && (
              <span className="field-hint">Minimum about ${offrampClears({ amountUsd: 0, breetMinimumUsd, estimatedGasUsd }).minimumUsd.toFixed(2)} on {network}, network fee included.</span>
            )}
            {/* The ceiling, at the moment the amount is entered - which is
                where it actually changes what someone types. Rendered only
                when the server has told us the number. */}
            {remainingNgn !== undefined && remainingNgn !== null && (
              <span className="field-hint">You can withdraw up to {naira(remainingNgn)} in the next {windowDays} days.</span>
            )}
          </label>
        )}

        {error && <div className="warning-box compact">{error}</div>}

        {quote && !quoteExpired && (
          <div className="details-box">
            <div className="kv"><span>You send</span><strong>{trimTrailingZeros(quote.sourceAmount)} {asset.toUpperCase()}</strong></div>
            <div className="kv"><span>You receive</span><strong>{formatPayoutAmount(quote.destinationAmount, 'ngn')}</strong></div>
            <div className="kv"><span>Rate</span><strong>1 {asset.toUpperCase()} ≈ {formatPayoutAmount(quote.rate, 'ngn', 2)}</strong></div>
            <div className="kv"><span>Fee</span><strong>{formatPayoutAmount(quote.feeAmount, 'ngn')}</strong></div>
            {Boolean(quote.expiresAt) && <div className="kv"><span>Expires in</span><strong>{formatCountdown(secondsLeft)}</strong></div>}
          </div>

        )}

        {quoteExpired && (
          <div className="warning-box compact">That quote expired. Get a new one so you settle at the rate you were shown.</div>
        )}

        {/* The server will refuse this, so refusing it here first turns a
            failed submission into a number the user can adjust. */}
        {overLimit && remainingNgn !== null && remainingNgn !== undefined && (
          <div className="warning-box compact">
            That is {naira(quotedNgn)}, above the {naira(remainingNgn)} you have left for the next {windowDays} days.
            Withdraw less, or complete the next verification step to raise your limit.
          </div>
        )}

        <div className="split-actions">
          <button type="button" className="ghost-btn" onClick={onCancel}>Back</button>
          {!quote || quoteExpired ? (
            <button
              type="button"
              className="primary-btn"
              disabled={quoting || !resolved || !(amountUsd > 0) || overBalance || Boolean(floorVerdict && !floorVerdict.clears)}
              onClick={() => void getQuote()}
            >
              {quoting ? 'Pricing…' : quoteExpired ? 'Refresh quote' : 'Get quote →'}
            </button>
          ) : (
            <button
              type="button"
              className="primary-btn"
              // Blocked over the ceiling. The server refuses it anyway, and
              // letting the user reach the review screen only to be rejected
              // there wastes the quote they are racing the expiry on.
              disabled={overLimit}
              onClick={() => onReady({ quote, account: resolved!, fundingSource })}
            >
              Continue →
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
