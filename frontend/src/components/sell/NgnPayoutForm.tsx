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
  type SavedNgnPayoutAccount,
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
 * A chain's name as its own users write it.
 *
 * The API's identifiers are lowercase slugs - 'bsc', 'polygon'. Printed raw
 * next to a deposit address they read as debug output, and 'bsc' in particular
 * is not what the network calls itself anywhere the user will have seen it.
 *
 * Unknown slugs are capitalised rather than dropped: a chain this map has not
 * caught up with must still be NAMED, because the name is what stops someone
 * sending on the wrong one.
 */
function networkLabel(network: string): string {
  const labels: Record<string, string> = {
    solana: 'Solana',
    base: 'Base',
    ethereum: 'Ethereum',
    polygon: 'Polygon',
    arbitrum: 'Arbitrum',
    optimism: 'Optimism',
    avalanche: 'Avalanche',
    bsc: 'BNB Smart Chain',
    tron: 'Tron',
  };
  return labels[network] ?? (network ? network.charAt(0).toUpperCase() + network.slice(1) : '');
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
type NgnWithdrawAssetOption = {
  asset: 'usdc' | 'usdt';
  label: string;
  spendable?: number | null;
  chainUnavailable?: boolean;
};

export function NgnPayoutForm({
  userId,
  api,
  network,
  networkOptions,
  onNetworkChange,
  asset,
  assetOptions = [],
  onAssetChange,
  breetMinimumUsd,
  remainingNgn,
  spendable,
  windowDays = 30,
  externalFundingEnabled,
  thirdPartyPayoutsEnabled,
  onReady,
  onCancel,
}: {
  userId: string;
  api: <T>(path: string, options?: RequestInit) => Promise<T>;
  /**
   * The chain the user is selling on. May be '' before the server's network
   * list arrives - see the guard at the top of the render.
   */
  network: string;
  /**
   * Every chain this user may sell on, from the server.
   *
   * This component used to receive a single `network` with a hardcoded
   * 'solana' default one level up, and no way to change it. A user holding
   * USDC on Base was quoted, shown a minimum, and handed a Solana deposit
   * address - the wrong chain, silently, with funds sent to it unrecoverable.
   */
  networkOptions: Array<{ network: string; minimumDepositUsd?: number; gasEstimateUsd?: number; label?: string }>;

  onNetworkChange?: (network: string) => void;
  asset: 'usdc' | 'usdt';
  assetOptions?: NgnWithdrawAssetOption[];
  onAssetChange?: (asset: 'usdc' | 'usdt') => void;

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
  /**
   * Admin toggle for the manual-funding path. See migration 045.
   *
   * `=== true` at the use site, never truthiness: an older API build omits the
   * field, and `undefined` must read as OFF. Defaulting an absent flag to ON
   * would surface the withdrawn flow on exactly the deployments least likely
   * to be watched.
   */
  externalFundingEnabled?: boolean;
  /**
   * Whether the "Pay someone else" choice is offered at all.
   *
   * `=== true` below, not truthiness: an older API build omits the field and
   * `undefined` must read as OFF. This only governs what is SHOWN - the server
   * refuses a third-party destination in createNgnQuote() regardless, so a
   * stale bundle cannot open the path.
   */
  thirdPartyPayoutsEnabled?: boolean;
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

  /**
   * THE ACCOUNTS THIS USER HAS ALREADY PROVED ARE THEIRS.
   *
   * A naira withdrawal used to mean retyping a 10-digit NUBAN and waiting on a
   * bank lookup every single time, even though the account had been saved and
   * name-matched on a previous withdrawal. Worse, the account typed here never
   * reached the server at all: the quote picked the first verified row on file.
   *
   * `null` means "not loaded yet" and is deliberately distinct from `[]`,
   * which means "loaded, and this user has none". Rendering the manual form
   * during the fetch would make the saved list appear a moment later and move
   * everything under the user's thumb.
   */
  const [savedAccounts, setSavedAccounts] = useState<SavedNgnPayoutAccount[] | null>(null);
  const [payoutAccountId, setPayoutAccountId] = useState('');
  /** Set when the user explicitly asks to pay an account that is not on file. */
  const [addingNewAccount, setAddingNewAccount] = useState(false);
  /** Shown after a manual account is saved, so the user knows it is now reusable. */
  const [justSaved, setJustSaved] = useState('');
  /**
   * Paying a third party rather than yourself.
   *
   * Only reachable when the admin toggle is on; the tab that sets it is not
   * rendered otherwise, and the server refuses regardless.
   */
  const [payingSomeoneElse, setPayingSomeoneElse] = useState(false);

  /**
   * MAY THE USER FUND THIS BY SENDING CRYPTO THEMSELVES?
   *
   * `=== true`, not truthiness: an older API build omits the field entirely,
   * and `undefined` has to read as OFF. The server also defaults it to false
   * and fails closed if its own controls read throws, so there are two
   * independent reasons this lands on "hidden" rather than one.
   *
   * fundingSource is left at its 'balance' initial value and never moves while
   * this is false - the only setter is the button being removed below - so no
   * effect is needed to force it back, and there is no window where a stale
   * 'external' selection could survive the flag being turned off mid-session.
   */
  const canFundExternally = externalFundingEnabled === true;
  const canPayThirdParty = thirdPartyPayoutsEnabled === true;
  const selectableAssets = assetOptions.length ? assetOptions : [{ asset, label: asset.toUpperCase(), spendable }];

  useEffect(() => {
    // A quote is denominated in one source asset. If the user switches from
    // USDC to USDT, the old quote is no longer the thing they are accepting.
    setQuote(null);
    setError('');
  }, [asset]);

  /**
   * The network fee, taken from the SERVER's own table.
   *
   * The client used to keep a private copy with a `?? 0.5` fallback for any
   * chain it did not recognise, while the server computed the withdrawal floor
   * from its own. Two hand-maintained tables on either side of the wire: the
   * hint below could advertise one minimum while the quote enforced another,
   * and on a chain dearer than the guess the difference lands as a deposit
   * held under Breet's minimum.
   *
   * `undefined` is now a real state - "we do not know this chain's fee" - and
   * every consumer below is required to handle it rather than print a number
   * that is not real. The local lookup remains only for the window before the
   * network list arrives.
   */
  const estimatedGasUsd = useMemo(() => {
    const fromServer = (networkOptions ?? []).find((option) => option?.network === network)?.gasEstimateUsd;
    return fromServer ?? typicalGasUsd(network);
  }, [networkOptions, network]);

  /**
   * The chains offered, de-duplicated and stably ordered.

   *
   * The server composes this list from two sources (admin's enabled networks
   * and what the provider settles), so a repeat is possible; a duplicate key
   * would break React's reconciliation of the buttons below.
   */
  const options = useMemo(() => {
    const seen = new Set<string>();
    return (networkOptions ?? []).filter((option) => {
      if (!option?.network || seen.has(option.network)) return false;
      seen.add(option.network);
      return true;
    });
  }, [networkOptions]);


  useEffect(() => {
    let cancelled = false;
    api<NgnBank[]>(`/api/ngn/banks?userId=${encodeURIComponent(userId)}`)
      .then((list) => { if (!cancelled) setBanks(list ?? []); })
      .catch(() => { if (!cancelled) setError('Could not load the bank list. Try again shortly.'); });
    return () => { cancelled = true; };
  }, [api, userId]);

  /**
   * Load the accounts already on file, and preselect one if that is unambiguous.
   *
   * ONLY `verified` ROWS ARE SELECTABLE. `pending_review` is an account a human
   * was asked to look at, and the server refuses to pay it - offering it here
   * would produce a withdrawal that fails at the quote for a reason the screen
   * had just implied was fine.
   *
   * Preselected ONLY when there is exactly one. With several, the server now
   * refuses an unspecified destination rather than guessing, and the UI must
   * not paper over that by choosing for the user: picking the wrong bank by
   * default is the failure this whole change exists to remove.
   *
   * A failure here is not surfaced as an error. The manual form below is a
   * complete way to withdraw, so a user whose saved list would not load is
   * inconvenienced, not blocked.
   */
  useEffect(() => {
    let cancelled = false;
    api<SavedNgnPayoutAccount[]>(`/api/ngn/payout-accounts?userId=${encodeURIComponent(userId)}`)
      .then((list) => {
        if (cancelled) return;
        const usable = (list ?? []).filter((account) => account.status === 'verified');
        setSavedAccounts(usable);
        if (usable.length === 1) setPayoutAccountId(usable[0].id);
      })
      .catch(() => { if (!cancelled) setSavedAccounts([]); });
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
   * THE FEE ROWS, in the order a user reads them.
   *
   * NAIRA FIRST. Every other figure on this card is naira - the amount they
   * receive, the rate, the limit - so a fee quoted only in USDC forces a
   * mental multiplication at exactly the moment they are deciding whether the
   * deal is fair. The asset amount follows in the same cell because that is
   * the unit actually deducted.
   *
   * ITEMISED WHEN THE SERVER SENDS THE BREAKDOWN. "Sivan fee" and "Provider
   * fee" as separate lines is the difference between a number a user accepts
   * and a number they can check. Falls back to one "Fee" row when `fees` is
   * absent, so an older server response still renders correctly rather than
   * showing nothing.
   */
  const feeRows = (() => {
    if (!quote) return [];
    const rate = Number(quote.rate) || 0;
    const assetUnit = asset.toUpperCase();
    // A fee in the source asset, shown as naira with the asset beside it.
    const both = (sourceAmount: string | number) => {
      const amount = Number(sourceAmount) || 0;
      /**
       * ROUNDED TO WHOLE NAIRA.
       *
       * Caught in a render, not in the code: a 0.5% provider fee on 51 USDC
       * came out as "₦382.5" and the payout as "₦75,352.5". Naira subdivides
       * into kobo, but a bank transfer settles in whole naira - a half-kobo is
       * a quantity that cannot exist, and seeing one makes every other figure
       * on the card look approximate.
       *
       * Math.round, not floor: the fee row must still reconcile against the
       * amount received, and consistently rounding one direction would make
       * gross minus fee disagree with the receive line by a naira.
       */
      const naira = rate > 0 ? formatPayoutAmount(String(Math.round(amount * rate)), 'ngn') : null;
      const inAsset = `${trimTrailingZeros(String(amount))} ${assetUnit}`;
      return naira ? `${naira} · ${inAsset}` : inAsset;
    };

    const explicitBoth = (ngnAmount: string | number | undefined, assetAmount: string | number | undefined) => {
      const assetValue = Number(assetAmount ?? 0) || 0;
      const ngnValue = Number(ngnAmount ?? 0) || 0;
      if (ngnValue > 0 && assetValue > 0) {
        return `${formatPayoutAmount(String(Math.round(ngnValue)), 'ngn')} · ${trimTrailingZeros(String(assetAmount))} ${assetUnit}`;
      }
      if (assetValue > 0) return both(assetValue);
      if (ngnValue > 0 && rate > 0) return `${formatPayoutAmount(String(Math.round(ngnValue)), 'ngn')} · ${trimTrailingZeros(String(ngnValue / rate))} ${assetUnit}`;
      return `${formatPayoutAmount('0', 'ngn')} · 0 ${assetUnit}`;
    };

    const fees = quote.fees;
    if (!fees) return [{ label: 'Fee', value: both(quote.feeAmount ?? '0') }];

    /**
     * ONE FEE ROW, NOT THREE.
     *
     * This briefly showed "Sivan fee", "Provider fee" and "Total fee" as
     * separate lines. That is the right breakdown for an ACCOUNTS screen and
     * the wrong one for a user: the split between Sivan's 1% and Breet's 0.5%
     * is Sivan's internal cost structure, and the person withdrawing has no
     * decision to make about it. Three numbers to reconcile, where one answers
     * the only question they have - what does this cost me.
     *
     * The provider fee is not hidden, it is INCLUDED: the total is Sivan's
     * margin plus the provider's cut, so the single figure is the whole
     * charge. The split is still returned by the API and still shown to
     * admins, where the distinction between cost and revenue matters.
     */
    /**
     * NO PERCENTAGE IN THE LABEL.
     *
     * The rate is a derived figure the user cannot act on - they are sending a
     * fixed amount, so the cash is the whole answer. "Sivan fee (1.50%)"
     * beside "₦1,148 · 0.765 USDC" is three representations of one charge, and
     * the percentage is the one nobody checks. It also invites arithmetic
     * against the rate line, which is how a rounded display starts looking
     * like a discrepancy.
     *
     * Same reasoning that removed the network-fee row and collapsed the
     * three-row breakdown: one number, the one they are paying.
     */
    return [{ label: 'Sivan fee', value: explicitBoth(fees.totalFeeNgn, fees.totalFeeAsset ?? fees.totalFee) }];
  })();

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
  /**
   * Needs BOTH the provider minimum and the network fee to mean anything.
   *
   * Computing it with a missing gas figure defaulted to zero would understate
   * the floor by exactly the fee, which is the direction that lets an amount
   * through and gets it flagged on arrival. With either input unknown there is
   * no verdict, the hint below says nothing, and getQuote refuses.
   */
  const floorVerdict = breetMinimumUsd !== undefined && estimatedGasUsd !== undefined && amountUsd > 0
    ? offrampClears({ amountUsd, breetMinimumUsd, estimatedGasUsd })
    : undefined;


  /**
   * Withdrawing more than the balance holds, caught while typing.
   *
   * Only meaningful when withdrawing FROM the balance, and only when the number is
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
    if (!destinationAccount) return setError('Choose or add the bank account to withdraw to.');
    if (!(amountUsd > 0)) return setError('Enter an amount.');
    /**
     * No chain, no quote.
     *
     * Omitting the network lets the server fall back to BREET_DEFAULT_NETWORK,
     * which is how the wrong-chain bug paid out in the first place: the user is
     * quoted, and on the external path addressed, on a chain nobody chose.
     */
    if (!network) return setError('Choose the network you hold your crypto on.');

    /**
     * An unknown network fee is a refusal, not a pass.
     *
     * floorVerdict is undefined both when the amount is fine and when we could
     * not compute a floor at all, so testing it alone lets an unpriced chain
     * through unchecked - the one case where the deposit is most likely to
     * land under Breet's minimum and be held.
     */
    if (estimatedGasUsd === undefined) {
      return setError(`We could not check network fees for ${networkLabel(network)} just now. Try again shortly.`);
    }

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
        `You have ${usd(spendable!)} ${asset.toUpperCase()} available to withdraw. ` +
        (canFundExternally
          ? `Lower the amount, or choose "I'll send crypto myself" to send from another wallet.`
          /**
           * THE ADVICE MUST MATCH THE BUTTONS ON SCREEN.
           *
           * With manual funding hidden behind the admin flag, naming that
           * button points the user at a control they cannot see - which reads
           * as the app being broken. Caught by grepping the BUILT bundle for
           * the button text, not from the source diff.
           */
          : `Lower the amount to continue.`)
      );
    }

    setQuoting(true);
    try {
      /**
       * SAVE A MANUALLY ENTERED ACCOUNT BEFORE QUOTING IT.
       *
       * The server will only pay an account it has verified, so a hand-typed
       * NUBAN has to become a saved row first. This is also the moment the
       * name match happens: POST re-resolves the account server side and
       * compares the bank's name to the profile name - the client's `resolved`
       * copy is display only and proves nothing about who is asking.
       *
       * NOT gated on a client-side name comparison. Deciding here whether the
       * names match would put the security decision in the browser, where it
       * can be edited. The server returns `status`, and only `verified` is
       * usable; anything else is reported and the withdrawal stops.
       */
      let activePayoutAccountId = payoutAccountId;
      if (!activePayoutAccountId) {
        const saved = await api<SavedNgnPayoutAccount>('/api/ngn/payout-accounts', {
          method: 'POST',
          body: JSON.stringify({ userId, bankId, accountNumber }),
        });
        /**
         * WHAT COUNTS AS USABLE DEPENDS ON WHO IS BEING PAID.
         *
         * Paying yourself requires `verified`, which means the bank's name
         * matched the profile name. Paying someone else CANNOT clear that bar
         * by definition - a third party's account is in a different name, so
         * the save comes back `rejected` with verdict 'mismatch'. Treating
         * that as a failure would make the tab unusable the moment an operator
         * switched it on, and the error would tell a user paying their
         * supplier that the account "must be in your own name" - advice that
         * contradicts the button they just pressed.
         *
         * The account still had to RESOLVE: a NUBAN that names nobody never
         * reaches here, because saveNgnPayoutAccount() re-resolves server side
         * and throws when the bank cannot find it. So the row is real and the
         * name shown below is the bank's, not the user's guess.
         */
        const usable = payingSomeoneElse
          ? saved.matchVerdict === 'mismatch' || saved.status === 'verified'
          : saved.status === 'verified';

        if (!usable) {
          setQuoting(false);
          /**
           * Named plainly, because "pending review" invites the user to wait
           * for something that is not coming on this rail: naira payouts go to
           * an account in the user's own name, and a mismatch is not a queue
           * position. Telling them to wait would be a lie of omission.
           */
          return setError(
            saved.matchVerdict === 'mismatch'
              ? `That account belongs to ${saved.accountName}. Naira withdrawals can only go to an account in your own name.`
              : 'We could not confirm that account is yours. Our team is checking it - try another account meanwhile.'
          );
        }
        activePayoutAccountId = saved.id;
        setPayoutAccountId(saved.id);
        /**
         * Only the user's OWN accounts join the saved list.
         *
         * The list is headed "Withdraw to" and every row in it is offered as a
         * one-tap self-payout. A third party's account in there would be one
         * tap away from being paid on a later withdrawal, by a user who had
         * since switched back to "Pay myself" - and the server would refuse
         * it, so the row would be an option that always fails. Recipients need
         * their own list with its own screening, not a seat in this one.
         */
        if (saved.status === 'verified') {
          setSavedAccounts((current) => {
            const rest = (current ?? []).filter((account) => account.id !== saved.id);
            return [saved, ...rest];
          });
        }
        setAddingNewAccount(false);
        setJustSaved(saved.id);
      }

      /**
       * THE DESTINATION HAS TO TRAVEL WITH THE QUOTE.
       *
       * Without payoutAccountId the server falls back to the only verified
       * account on file, and refuses outright when there is more than one. It
       * used to silently pay the first - so this screen could show one bank
       * while the naira went to another.
       *
       * `activePayoutAccountId` is empty during a manual entry; the account is
       * saved first (below) and its new id used, so the quote still names an
       * account the server has verified rather than a raw NUBAN.
       */
      const destination = activePayoutAccountId
        ? `&payoutAccountId=${encodeURIComponent(activePayoutAccountId)}`
        : '';
      const result = await api<NgnQuote>(
        // network is what lets the server price gas for the RIGHT chain -
        // without it the estimate silently falls back to the default network's.
        `/api/ngn/quote?userId=${encodeURIComponent(userId)}&direction=offramp&sourceCurrency=${asset}&destinationCurrency=ngn&sourceAmount=${encodeURIComponent(amount)}&network=${encodeURIComponent(network)}${destination}`
      );
      setQuote(result);
    } catch (err) {
      setError((err as Error).message || 'Could not price that withdrawal.');
    } finally {
      setQuoting(false);
    }
  }

  const selectedBank = banks.find((bank) => bank.id === bankId);

  /**
   * THE DESTINATION, WHICHEVER WAY IT WAS CHOSEN.
   *
   * Amount, quoting and Continue were all gated on `resolved`, which is only
   * ever set by the manual bank lookup. Selecting a saved account therefore
   * left the form with no amount field and a dead Continue button - the saved
   * list would have looked like it worked and then gone nowhere.
   *
   * A saved account is the STRONGER evidence of the two: it was re-resolved
   * and name-matched server side when it was saved, whereas `resolved` is a
   * read-only client lookup that proves nothing about who is asking. So it is
   * shaped into the same type here rather than the gates being loosened.
   */
  const chosenSavedAccount = savedAccounts?.find((account) => account.id === payoutAccountId);
  const destinationAccount: ResolvedNgnBankAccount | null = chosenSavedAccount
    ? {
        // bankId carried through: the confirmation screen and the order both
        // need to name the bank, and a payout with an account number but no
        // bank is not routable.
        bankId: chosenSavedAccount.bankId,
        accountNumber: chosenSavedAccount.accountNumber,
        accountName: chosenSavedAccount.accountName,
        bankName: chosenSavedAccount.bankName,
        // Saved rows only reach `verified` when the resolution WAS trustworthy,
        // so this is a fact about the row, not an optimistic default.
        trustworthy: true,
      }
    : resolved;

  return (
    <article className="panel form-panel trade-card">
      <p className="eyebrow">Step 1</p>
      <h3>Where should the naira go?</h3>
      <p className="muted">Choose your bank and enter your account number. We confirm the account name before anything is sent.</p>

      <div className="form premium-form">
        {/* WHO IS BEING PAID.
 
            Shown ONLY when third-party payouts are switched on, following the
            same rule as the funding-source group below: hidden, not disabled.
            A greyed-out "Pay someone else" asks "why can't I click this?"
            about a path that is not coming soon on this rail - Breet binds the
            payout bank to the user's permanent deposit address, so it needs a
            different provider product, not a flag flip. A disabled control
            would promise otherwise.
 
            With the toggle off there is also no CHOICE to render: a segmented
            control with one option is just a label. The heading and the saved
            list below already say the naira goes to the user's own account.
 
            This is presentation only. createNgnQuote() refuses a destination
            whose matchVerdict is not 'match' whenever the toggle is off, so
            hiding the tab is the second barrier, never the only one. */}
        {canPayThirdParty && (
          <div className="seg" role="group" aria-label="Who is being paid">
            <button
              type="button"
              className={payingSomeoneElse ? '' : 'active'}
              aria-pressed={!payingSomeoneElse}
              onClick={() => {
                setPayingSomeoneElse(false);
                // The destination decides the price and the recipient. Neither
                // survives a change of who is being paid.
                setQuote(null);
                setError('');
              }}
            >
              Pay myself
            </button>
            <button
              type="button"
              className={payingSomeoneElse ? 'active' : ''}
              aria-pressed={payingSomeoneElse}
              onClick={() => {
                setPayingSomeoneElse(true);
                // A saved account is by definition the user's own, so it
                // cannot stay selected once they are paying someone else.
                setPayoutAccountId('');
                setAddingNewAccount(true);
                setQuote(null);
                setError('');
              }}
            >
              Pay someone else
            </button>
          </div>
        )}
        {/* ASKED FIRST, because it changes what every later step means.
 
            Placed above the bank picker deliberately: choosing "I'll send
            crypto myself" turns off the balance check entirely, and a user who
            discovers that option AFTER being blocked on an amount has already
            been told they cannot do something they can. */}
        {/* HIDDEN, NOT DISABLED, WHEN THE ADMIN TOGGLE IS OFF.
 
            A greyed-out button asks "why can't I click this?" about a feature
            deliberately withdrawn, which is a support ticket for no gain. With
            one funding source there is also no CHOICE to present - a segmented
            control with a single option is just a label - so the whole group
            goes and the hint below states the funding source as a fact.
 
            The `external` branch throughout this file is intentionally left
            intact rather than deleted: it works, it is ~30 lines, and it comes
            back the moment deposit-address UX is solid. See migration 045. */}
        {canFundExternally && (
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
        )}
        {fundingSource === 'external' && Boolean(network) && (
          <p className="field-hint">
            We'll show you an address to send {asset.toUpperCase()} to on {networkLabel(network)}. The naira is paid out once it arrives.
          </p>
        )}

        <fieldset className="seg-fieldset">
          <legend>Asset to withdraw</legend>
          <div className="seg network-seg">
            {selectableAssets.map((option) => {
              const disabled = fundingSource === 'balance' && typeof option.spendable === 'number' && option.spendable <= 0;
              return (
                <label
                  key={option.asset}
                  className={`seg-radio ${option.asset === asset ? 'active' : ''} ${disabled ? 'disabled' : ''}`}
                >
                  <input
                    type="radio"
                    name="sell-asset"
                    value={option.asset}
                    checked={option.asset === asset}
                    disabled={disabled}
                    onChange={() => {
                      if (disabled || option.asset === asset) return;
                      onAssetChange?.(option.asset);
                    }}
                  />
                  <span>
                    {option.label}
                    <small>
                      {option.spendable === undefined
                        ? 'Checking balance'
                        : option.spendable === null
                          ? 'Balance unavailable'
                          : `${usd(option.spendable)} ${option.asset.toUpperCase()} available`}
                    </small>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {/* THE CHAIN, CHOSEN BY THE PERSON WHOSE COINS THEY ARE.
 
            There was no control here at all. The network was fixed to 'solana'
            by a default parameter one level up, so a user holding USDC on Base
            or Polygon was quoted against Solana, shown Solana's minimum, and -
            on the external path - handed a SOLANA deposit address. Sending
            Base USDC to it loses the funds, and the screen that caused it
            never mentioned Solana until the address appeared.
 
            Rendered only when the user genuinely has a choice: with one
            supported chain a picker is noise, but the chain is still NAMED,
            because it decides where the money is sent. */}
        {options.length > 1 ? (
          /* A REAL RADIO GROUP, not buttons that merely look like one.
 
             This was a row of <button> elements with an `active` class. It
             LOOKED chosen and behaved correctly with a mouse, but nothing in
             the markup said the options were mutually exclusive: a screen
             reader announced three unrelated buttons, none of them marked as
             selected, and arrow keys did not move between them.
 
             For the control that decides WHICH CHAIN THE MONEY LEAVES ON,
             "which one is currently picked" cannot be a purely visual fact.
             Native <input type="radio"> in a <fieldset> gives the grouping,
             the selected state, and arrow-key navigation for free - all of it
             better than a hand-rolled version would be. */
          <fieldset className="seg-fieldset">
            <legend>Network</legend>
            <div className="seg network-seg">
              {options.map((option) => (
                <label
                  key={option.network}
                  className={`seg-radio ${option.network === network ? 'active' : ''}`}
                >
                  <input
                    type="radio"
                    name="sell-network"
                    value={option.network}
                    checked={option.network === network}
                    onChange={() => {
                      if (option.network === network) return;
                      // The old quote was priced on the old chain, and the
                      // minimum that justified it no longer applies.
                      setQuote(null);
                      setError('');
                      onNetworkChange?.(option.network);
                    }}
                  />
                  <span>{networkLabel(option.network)}</span>
                </label>
              ))}
            </div>
            {/* THE HINT HAS TO DESCRIBE THE FLOW THE USER IS ACTUALLY IN.
 
                "Send USDC on the network you actually hold it on" is manual-
                funding language: it tells someone to make a transfer. With
                balance funding the user sends nothing - Sivan moves it - and
                the only thing the network choice affects is which balance is
                debited and what it costs. Caught by LOOKING at the rendered
                screenshot; the code and the tests were both already green. */}
            <span className="field-hint">
              {canFundExternally
                ? `Send ${asset.toUpperCase()} on the network you actually hold it on. Minimums differ per network.`
                : `Choose the network holding your ${asset.toUpperCase()}. Fees differ per network.`}
            </span>
          </fieldset>
        ) : network ? (
          <p className="field-hint">Withdrawing {asset.toUpperCase()} on {networkLabel(network)}.</p>
        ) : (
          /* No chain resolved yet. Quoting now would price against nothing,
             so the button below stays disabled until this settles. */
          <p className="field-hint" aria-live="polite">
            {options.length === 0 ? 'Checking which networks are available…' : 'Choose a network to continue.'}
          </p>
        )}


        {/* THE ACCOUNTS ALREADY PROVED TO BE THIS USER'S.
 
            A returning user's most common action by far is "the same account
            as last time", and that is now one tap with no bank search and no
            NUBAN retyped. The manual form is not removed, only deferred behind
            an explicit choice - a user with a second account of their own must
            still be able to use it.
 
            Rendered only once the fetch has settled (`savedAccounts !== null`),
            so the manual form never appears and is then displaced by a list
            arriving a moment later under the user's thumb. */}
        {savedAccounts !== null && savedAccounts.length > 0 && !addingNewAccount && (
          <div className="saved-payout-accounts">
            <p className="bank-list-label">Withdraw to</p>
            {savedAccounts.map((account) => (
              <button
                type="button"
                key={account.id}
                className={`bank-option${payoutAccountId === account.id ? ' selected' : ''}`}
                aria-pressed={payoutAccountId === account.id}
                onClick={() => {
                  setPayoutAccountId(account.id);
                  // A quote is bound to a destination. Changing the destination
                  // invalidates the price the user was shown against the old one.
                  setQuote(null);
                  setError('');
                }}
              >
                <span>
                  <strong>{account.accountName}</strong>
                  <span className="muted"> {account.bankName} · {maskAccountNumber(account.accountNumber)}</span>
                </span>
                {justSaved === account.id && <span className="field-hint">Saved for next time</span>}
              </button>
            ))}
            <button
              type="button"
              className="bank-list-more"
              onClick={() => {
                setAddingNewAccount(true);
                // Clearing the selection is what makes the quote send no
                // payoutAccountId, so the newly typed account is saved first.
                setPayoutAccountId('');
                setQuote(null);
                setError('');
              }}
            >
              Use a different account
            </button>
          </div>
        )}

        {/* The manual path: a first-time user, or someone adding another of
            their own accounts. Hidden while a saved account is selected so the
            two cannot both be filled in and disagree about where money goes. */}
        {(savedAccounts !== null && (savedAccounts.length === 0 || addingNewAccount || payingSomeoneElse)) && (
          <>
        {/* The "New account" strip belongs to the self-payout flow only.
 
            While paying someone else there is nothing to cancel BACK to: the
            saved list holds the user's own accounts, and Cancel would silently
            reselect one while the tab still read "Pay someone else" - the
            screen and the destination disagreeing, which is the class of bug
            this whole change set exists to remove. The tab itself is the way
            back. */}
        {savedAccounts.length > 0 && !payingSomeoneElse && (
          <div className="details-box compact">
            <span>New account</span>
            <button
              type="button"
              className="ghost-btn small"
              onClick={() => {
                setAddingNewAccount(false);
                setBankId('');
                setBankQuery('');
                setAccountNumber('');
                setResolved(null);
                setQuote(null);
                setError('');
                if (savedAccounts.length === 1) setPayoutAccountId(savedAccounts[0].id);
              }}
            >
              Cancel
            </button>
          </div>
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
            {/* THE NAME IS THE CONFIRMATION, SO SAY WHAT TO DO WITH IT.
 
                The bank's own answer for this NUBAN is already rendered above,
                but as a bare name it reads as decoration. A wrong digit
                resolves to a real stranger, and a naira transfer cannot be
                recalled - so when the money is going to someone else, the name
                is the last check that exists and the copy has to ask for it
                explicitly rather than hope the user reads carefully.
 
                Only when trustworthy: on sandbox any number resolves to a
                plausible name, and telling someone to verify a simulated name
                would train them to trust a check that proves nothing. */}
            {payingSomeoneElse
              ? resolved.trustworthy && (
                  <span className="field-hint">
                    Check this is the right person. Naira transfers cannot be reversed.
                  </span>
                )
              : (
                /* Stated BEFORE the withdrawal, not after. The account is saved
                   as a side effect of withdrawing to it, and a user should know
                   that at the moment they can still back out. */
                <span className="field-hint">We'll save this account so you don't have to type it next time.</span>
              )}
          </div>
        )}
          </>
        )}

        {destinationAccount && (
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
                    : `${usd(spendable)} ${asset.toUpperCase()} available to withdraw.`}
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
            {/* Only quotable with a real fee. Without one this said "network
                fee included" over a figure computed from a guess. */}
            {breetMinimumUsd !== undefined && estimatedGasUsd !== undefined && !amount && (
              <span className="field-hint">Minimum about ${offrampClears({ amountUsd: 0, breetMinimumUsd, estimatedGasUsd }).minimumUsd.toFixed(2)} on {networkLabel(network)}, network fee included.</span>
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

        {/* Built here rather than inline so the naira/asset conversion is
            visible and testable, not buried in three nested ternaries. */}
        {quote && !quoteExpired && (
          <div className="details-box">
            <div className="kv"><span>You send</span><strong>{trimTrailingZeros(quote.sourceAmount)} {asset.toUpperCase()}</strong></div>
            <div className="kv"><span>You receive</span><strong>{formatPayoutAmount(quote.destinationAmount, 'ngn')}</strong></div>
            <div className="kv"><span>Rate</span><strong>1 {asset.toUpperCase()} ≈ {formatPayoutAmount(quote.rate, 'ngn', 2)}</strong></div>
            {/*
              THE FEE, ITEMISED - WHO CHARGES WHAT, IN BOTH UNITS.

              This row rendered `formatPayoutAmount(quote.feeAmount, 'ngn')`.
              On an off-ramp quote feeAmount is denominated in what the user
              SENDS (USDC), because ngn-margin.ts computes it from the source
              amount - so a real fee of 0.5107 USDC printed as "₦1".

              Reported from the screen: 51 USDC at ₦1,500 showed "YOU RECEIVE
              ₦75,734" against a ₦76,500 gross, so ₦766 was actually taken -
              766x what the row claimed. A user who subtracts the two numbers
              finds money missing and nothing on the page explains it.

              Now shown as naira FIRST, because that is the column the user is
              doing arithmetic in, with the asset amount beside it because that
              is the unit actually charged. Split into Sivan's margin and the
              provider's cut when the server sends the breakdown, so the total
              can be checked rather than trusted.
            */}
            {feeRows.map((row) => (
              <div className="kv" key={row.label}>
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
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
              disabled={quoting || !destinationAccount || !network || !(amountUsd > 0) || overBalance || Boolean(floorVerdict && !floorVerdict.clears)}
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
              onClick={() => onReady({ quote, account: destinationAccount!, fundingSource })}
            >
              Continue →
            </button>
          )}
        </div>
      </div>
    </article>
  );
}
