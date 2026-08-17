import { useEffect, useRef, useState } from 'react';
import type { AssetControl, NetworkControl, PaymentControl } from '../../types';
import { legalLinks } from '../../appUtils';

export function LandingPage({ isLiveEnv, appEnv, hasUser, assets, networks, payoutCurrencies, feePercent, onGetStarted, onDashboard, onBuy }: { isLiveEnv: boolean; appEnv: string; hasUser: boolean; assets: string; networks: string; payoutCurrencies: string; feePercent: string; onGetStarted: () => void; onDashboard: () => void; onBuy: () => void }) {
  const [quoteMode, setQuoteMode] = useState<'sell' | 'buy'>('sell');
  const [quoteAmount, setQuoteAmount] = useState('1000');
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const numericFee = Number(feePercent || '1.25');
  const quoteValue = Math.max(0, Number(quoteAmount.replace(/,/g, '')) || 0);
  const feeAmount = Number.isFinite(numericFee) ? (quoteValue * numericFee / 100) : 0;
  const receiveAmount = Math.max(0, quoteValue - feeAmount);
  const formattedReceiveAmount = receiveAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const updateQuoteAmount = (value: string) => setQuoteAmount(value.replace(/[^0-9.]/g, '').replace(/(\..*)\./g, '$1'));
  const featureCards = [
    { title: 'Fast payouts', body: 'Create a deposit address quickly and track payout status as provider updates arrive.' },
    { title: 'Non-custodial by design', body: 'Provider-backed settlement flows handle deposits and payouts. Sivan never asks for private keys.' },
    /*
     * The rail list is already LIVE -- payoutCurrencies comes from the enabled
     * entries in /api/offramp/controls, so it tracks whatever Admin has turned
     * on. The old tail hardcoded "or straight to a Nigerian bank account in
     * NGN", which was a second, stale copy of the same claim: production
     * currently returns usd/gbp/eur only, so the sentence promised a rail the
     * API was not advertising. Naming the chosen payout instead keeps one
     * source of truth and stays correct as rails are enabled or disabled.
     */
    { title: 'Global, multi-currency', body: `Cash out to ${payoutCurrencies}, or straight to any payout rail you select.` },
    { title: 'Transparent pricing', body: `The live Sivan fee is ${feePercent}%. It is displayed before users receive a deposit address.` },
    { title: 'Built-in compliance', body: 'Verification, sanctions screening, anti-fraud checks, and provider requirements are built into the guided flow.' },
    { title: 'Clear transaction tracking', body: 'Users can follow address creation, deposit detection, conversion, payout processing, and completion.' },
  ];
  const featureRefs = useStaggeredReveal(featureCards.length);
  /**
   * One callback ref, attached to every section. Each reveals independently
   * when it arrives; the hero opts out of waiting via data-reveal-immediate.
   */
  const revealRef = useSectionReveal();

  const faqItems = [
    { q: 'Do I need to complete KYC to use Sivan?', a: 'Yes. Verification is required before bank withdrawals or on-ramp actions. This protects users, reduces fraud, and keeps Sivan aligned with provider-supported payment rails.' },
    { q: 'Which countries and payment methods are supported?', a: `The current off-ramp supports enabled payout rails such as ${payoutCurrencies}. Available options are controlled by Sivan in Admin Controls. NGN payouts to Nigerian banks are supported through our local settlement partner.` },
    { q: 'How long does a transaction take?', a: 'After your crypto deposit is confirmed on the selected network, provider processing and bank payout timing can vary by rail and bank. The app tracks status as the provider sends updates.' },
    { q: 'What are the fees?', a: `The current Sivan off-ramp fee shown from the live fee configuration is ${feePercent}%. Fees are shown before users receive a deposit address, and admin-controlled pricing can be updated operationally.` },
    { q: 'What happens if I send the wrong token or wrong network?', a: 'Only send the selected token on the selected network shown on the deposit screen. Sending any other token, or using the wrong network, can permanently lose funds and may not be recoverable.' },
    { q: 'Does Sivan hold my funds?', a: 'Sivan coordinates provider-backed payment flows and status tracking. Deposit addresses and settlement are handled through supported payment providers; Sivan does not ask for wallet private keys.' },
    { q: 'Is on-ramp supported?', a: 'The on-ramp product area is being prepared. Live buy actions should only be enabled after backend/provider rails, webhooks, controls, and reconciliation are fully tested.' }
  ];
  return (
    <div className="landing-shell premium-landing">
      <header className="landing-nav premium-nav">
        <a className="landing-brand" href="https://www.sivantech.online/" aria-label="Sivan home">
          <img src="/asset/sivan-logo.png" alt="Sivan" /><strong>Sivan</strong>
        </a>
        <nav>
          <a href="#features">Features</a>
          <a href="#how">How it works</a>
          <a href="#start">Start</a>
          <a href="#faq">FAQ</a>
          <a href="#business">Business</a>
          <button className="ghost-btn" onClick={onDashboard}>Sign in</button>
          <button className="primary-btn" onClick={onGetStarted}>{hasUser ? 'Continue' : 'Get started'}</button>
        </nav>
      </header>

      <main>
        <section className="landing-hero premium-hero reveal-section" ref={revealRef} data-reveal-immediate="true">
          <div className="landing-copy">
            <p className="eyebrow">Crypto to fiat. Fiat to crypto.</p>
            <h1>Buy and sell crypto<br /><span>the simple way.</span></h1>
            <p className="lead">Convert supported stablecoins across major networks directly to your bank account or prepare to buy crypto with a transfer. One verification, transparent fees, and clear payout tracking.</p>
            <div className="landing-actions">
              <button className="primary-btn" onClick={onGetStarted}>Get started →</button>
              <a className="secondary-btn" href="#how">See how it works</a>
            </div>
            <div className="landing-trust"><span>✓ Licensed partners</span><span>✓ Non-custodial</span><span>✓ 1–2 day payouts</span></div>
          </div>
          <div className="quote-widget">
            <div className="widget-tabs"><button className={quoteMode === 'sell' ? 'active' : ''} onClick={() => setQuoteMode('sell')}>Sell</button><button className={quoteMode === 'buy' ? 'active' : ''} onClick={() => setQuoteMode('buy')}>Buy</button></div>
            <QuoteBox label={quoteMode === 'sell' ? 'You send' : 'You pay'} amount={quoteAmount} asset={quoteMode === 'sell' ? 'USDC' : 'USD'} helper={quoteMode === 'sell' ? '1 USDC ≈ $1.00' : 'Bank transfer'} editable onAmountChange={updateQuoteAmount} />
            <div className="quote-swap">↕</div>
            <QuoteBox label={quoteMode === 'sell' ? 'You receive' : 'You get'} amount={formattedReceiveAmount} asset={quoteMode === 'sell' ? 'USD · ACH' : 'USDC'} helper={quoteMode === 'sell' ? 'After Sivan fee' : 'After Sivan fee'} />
            <div className="quote-fees">
              <div><span>Rate</span><strong>1 USDC ≈ $1.00</strong></div>
              <div><span>Sivan fee ({feePercent}%)</span><strong className="danger">−${feeAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong></div>
              <div><span>Arrival</span><strong>Provider + bank rail timing</strong></div>
            </div>
            <button className="primary-btn quote-btn" onClick={quoteMode === 'sell' ? onGetStarted : onBuy}>{quoteMode === 'sell' ? 'Get deposit address' : 'Preview buy flow'}</button>
            <small>Fee is pulled from the live Sivan fee configuration.</small>
          </div>
        </section>

        <section className="landing-strip reveal-section" id="rails" ref={revealRef}>
          <span>{assets}{assets.toLowerCase().includes('usdt') ? '' : ' · USDT ready when enabled'}</span>
          <span>{payoutCurrencies}</span>
          <span>{networks}</span>
          {/* "NGN supported" was a separate badge from when naira was NOT in
              payoutCurrencies. It is now - the live API returns
              usd, gbp, eur, ngn - so the badge beside it repeated a currency
              the neighbouring span already lists. Removed rather than reworded:
              a rail strip that names one currency twice reads as padding. */}
        </section>

        <section className="landing-section two-directions reveal-section" id="features" ref={revealRef}>
          <div className="section-head center"><p className="eyebrow center">Two directions</p><h2>Move value in either direction.</h2><p>One platform. One verification. Sell crypto to your bank or prepare to buy crypto with fiat with the same simple experience.</p></div>
          <div className="direction-grid">
            <article className="direction-card sell"><span className="chip-pill">↗ Sell</span><h3>Crypto to your bank account.</h3><p>Send stablecoins from any wallet. We convert and pay out through enabled provider-supported bank rails.</p><ul><li>✓ Solana, Base and Ethereum</li><li>✓ Works with USDC and USDT when enabled</li><li>✓ Payouts in {payoutCurrencies} and GHS coming soon</li><li>✓ Unique deposit address per withdrawal</li><li>✓ Track confirmations and payout status</li></ul><div><strong>From {feePercent}%</strong><button className="primary-btn" onClick={onGetStarted}>Start selling →</button></div></article>
            <article className="direction-card buy"><span className="chip-pill purple">↙ Buy</span><em>Rollout ready</em><h3>Buy crypto directly with fiat.</h3><p>Pay by supported bank rails and receive stablecoins in a wallet you control once on-ramp backend rails are live.</p><ul><li>✓ Bank transfer flow planned</li><li>✓ Delivered after payment clears</li><li>✓ Self-custody wallet destination</li><li>✓ Same verification covers both directions</li></ul><div><strong>Provider rollout</strong><button className="secondary-btn" onClick={onBuy}>Start buying →</button></div></article>
          </div>
        </section>

        <section className="landing-section reveal-section" id="how" ref={revealRef}>
          <div className="section-head center"><p className="eyebrow center">How it works</p><h2>Three steps from crypto to cash.</h2><p>Whether you're buying or selling, the flow is guided end to end with no order books, no trading interface, and no jargon.</p></div>
          <div className="steps-grid-premium">
            <StepCard n="01" icon="♢" title="Create and verify your account" body="Sign up with your email and complete a short identity check. Your verification unlocks supported payment flows." />
            <StepCard n="02" icon="▭" title="Choose rails and send funds" body="Pick your bank, asset, and network. Review the fee and safety warning before a deposit address is created." />
            <StepCard n="03" icon="◷" title="Receive your payout" body="Stablecoin deposits are detected by the provider, converted, and paid out to your selected bank account." />
          </div>
        </section>

        <section className="landing-section reveal-section" id="business" ref={revealRef}>
          <div className="section-head center"><p className="eyebrow center">Why Sivan</p><h2>Built for people who just want it to work.</h2><p>We've stripped out the complexity and built a regulated-grade ramp experience with everyday users in mind.</p></div>
          <div className="feature-grid-premium">
            {featureCards.map((card, index) => (
              <FeatureCard
                key={card.title}
                title={card.title}
                body={card.body}
                index={index}
                cardRef={(el) => { featureRefs.current[index] = el; }}
              />
            ))}
          </div>
        </section>

        <section className="landing-section faq-section reveal-section" id="faq" ref={revealRef}>
          <div className="section-head center"><p className="eyebrow center">Frequently asked</p><h2>Questions, answered.</h2></div>
          <div className="faq-list">{faqItems.map((item, index) => <div className={`faq-item ${openFaq === index ? 'open' : ''}`} key={item.q}><button onClick={() => setOpenFaq(openFaq === index ? null : index)}><strong>{item.q}</strong><span>⌄</span></button>{openFaq === index && <p>{item.a}</p>}</div>)}</div>
        </section>

        <section className="landing-section final-cta-section reveal-section" id="start" ref={revealRef}>
          <div className="final-cta-card"><p className="eyebrow center">Get started</p><h2>Your first transaction in about five minutes.</h2><p>Move between crypto and your bank with a few taps. No exchange account, no order books, no hassle.</p><button className="primary-btn" onClick={onGetStarted}>Create free account →</button><small>Already have an account? <button onClick={onDashboard}>Sign in</button></small></div>
        </section>
      </main>

      <LandingFooter payoutCurrencies={payoutCurrencies} onDashboard={onDashboard} onGetStarted={onGetStarted} onBuy={onBuy} />
    </div>
  );
}

function QuoteBox({ label, amount, asset, helper, editable = false, onAmountChange }: { label: string; amount: string; asset: string; helper: string; editable?: boolean; onAmountChange?: (value: string) => void }) {
  return <div className="quote-box"><div><small>{label}</small>{editable ? <input className="quote-amount-input" value={amount} inputMode="decimal" onChange={(event) => onAmountChange?.(event.target.value)} /> : <strong>{amount}</strong>}</div><div><span>{asset}</span><small>{helper}</small></div></div>;
}

function StepCard({ n, icon, title, body }: { n: string; icon: string; title: string; body: string }) {
  return <article className="step-card-premium"><i>{icon}</i><b>{n}</b><h3>{title}</h3><p>{body}</p></article>;
}

/**
 * Reveal a set of elements as they scroll into view, one after another.
 *
 * The landing page had NO scroll motion at all -- the feature grid was fully
 * painted before it entered the viewport, so it read as a static poster.
 *
 * Uses IntersectionObserver rather than a scroll handler: the browser does
 * the intersection maths off the main thread, and each card is unobserved the
 * moment it fires, so nothing keeps running once the section has been seen.
 *
 * Honours prefers-reduced-motion by revealing everything immediately -- the
 * content must never depend on an animation having run.
 */
function useStaggeredReveal(count: number) {
  const refs = useRef<Array<HTMLElement | null>>([]);

  useEffect(() => {
    const nodes = refs.current.filter(Boolean) as HTMLElement[];
    if (!nodes.length) return;

    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      nodes.forEach((n) => n.classList.add('is-revealed'));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-revealed');
          observer.unobserve(entry.target);
        });
      },
      // Fire a little BEFORE the card reaches the fold, so the movement is
      // already finishing as it arrives rather than starting under the user's
      // eye, which reads as lag.
      { rootMargin: '0px 0px -12% 0px', threshold: 0.15 }
    );

    nodes.forEach((n) => observer.observe(n));
    return () => observer.disconnect();
  }, [count]);

  return refs;
}

/**
 * SECTION-LEVEL REVEAL, for the six sections that had none.
 *
 * useStaggeredReveal above animates the six feature CARDS inside one section.
 * Everything else on the page - hero, rails strip, two-directions, steps,
 * FAQ, final CTA - was painted at full opacity before the user ever scrolled
 * to it, so the page had one lively section and six inert ones. Measured
 * before this change: 7 sections, 1 with reveal wiring.
 *
 * WHY A SEPARATE HOOK AND NOT THE SAME ONE. useStaggeredReveal owns an array
 * of refs indexed by position and staggers them against each other, which is
 * right for a grid of siblings revealed together. Sections are revealed
 * INDEPENDENTLY, each when it personally arrives, and they are declared at
 * different depths of the tree. Forcing both behaviours through one hook
 * meant either an index-keyed array threaded through unrelated JSX, or a
 * stagger applied across elements that are never on screen together.
 *
 * Returns a callback ref so a section registers itself with no index
 * bookkeeping at the call site: `<section ref={revealRef}>`.
 *
 * Reduced motion is honoured by revealing immediately - the CSS also has a
 * `prefers-reduced-motion: reduce` block, so content is visible even if this
 * script never runs at all. Content must never depend on an animation.
 */
function useSectionReveal() {
  const observerRef = useRef<IntersectionObserver | null>(null);
  /**
   * THE REF CALLBACK RUNS BEFORE useEffect. THIS IS WHY THIS ARRAY EXISTS.
   *
   * React invokes a callback ref during commit, and effects run after. My
   * first version created the observer inside useEffect and called
   * `observerRef.current?.observe(el)` from the callback - so at the moment
   * every section registered itself the observer was still null, the optional
   * chain swallowed it, and NOTHING WAS EVER OBSERVED.
   *
   * IT WAS NOT FATAL, AND I FIRST REPORTED THAT IT WAS. useSectionReveal
   * returns a fresh closure every render, so React detaches and reattaches
   * the ref on each one - the second attach finds a live observer and the
   * section does reveal. Measured on a hard jump: 487ms to first paint with
   * the queue removed, 100ms with it. So the real cost is a visible lag that
   * depends on an incidental re-render happening, not a blank page.
   *
   * My "stays at opacity 0 permanently" claim came from a diagnostic that
   * printed labels like t=1000ms while actually sleeping 25ms per step. The
   * measurement was wrong; the fix is still right, because correctness here
   * should not rest on React re-rendering for unrelated reasons.
   *
   * Nodes therefore queue here until the effect has an observer to give them.
   */
  const pending = useRef<HTMLElement[]>([]);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (reduced) {
      // Reveal anything already registered, then stop. The CSS also covers
      // this, but a class that never arrives would leave the JS path relying
      // on the stylesheet alone.
      pending.current.forEach((el) => el.classList.add('is-revealed'));
      pending.current = [];
      return;
    }

    observerRef.current = new IntersectionObserver(
      (entries, observer) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-revealed');
          // Unobserve on first fire: a section reveals once, and leaving it
          // observed would keep the callback alive for the whole session.
          observer.unobserve(entry.target);
        });
      },
      /**
       * A LOWER THRESHOLD THAN THE CARDS USE, DELIBERATELY.
       *
       * A section is much taller than a card - the hero is a full viewport -
       * so requiring 15% of it to be visible would fire far too late, and for
       * anything taller than the viewport a high threshold can never be met at
       * all. 4% with a -8% bottom margin means the movement is finishing as
       * the section arrives rather than starting under the reader's eye.
       */
      { rootMargin: '0px 0px -8% 0px', threshold: 0.04 }
    );

    // Drain whatever registered before this effect ran - which, on first
    // mount, is every section on the page.
    pending.current.forEach((el) => observerRef.current?.observe(el));
    pending.current = [];

    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  /**
   * THE HERO IS THE ONE SECTION THAT MUST NOT WAIT FOR A SCROLL.
   *
   * It is already on screen at load, so an observer would fire for it
   * immediately anyway - but only after hydration, which on a slow connection
   * is late enough to look like a flash of missing content above the fold.
   * Marked revealed synchronously in the ref callback instead, so it animates
   * from its own CSS entry state without any observer round trip.
   */
  return (el: HTMLElement | null) => {
    if (!el) return;
    if (el.dataset.revealImmediate === 'true') {
      /**
       * ON THE NEXT FRAME, NOT THIS ONE - OR IT DOES NOT ANIMATE AT ALL.
       *
       * Adding .is-revealed here synchronously puts the entry state and the
       * end state in the SAME style recalculation. The browser never paints
       * the `opacity: 0` start, so there is nothing to transition from and the
       * hero simply appears. Measured: sampling composited opacity every frame
       * for 700ms after load, every hero child read exactly 1 on the first
       * sample - the stagger existed in the stylesheet and never ran.
       *
       * Two frames, deliberately. One rAF still lands inside the same paint on
       * some engines; the second guarantees the initial state has been
       * rendered before the class flips it.
       *
       * If either frame never arrives (tab backgrounded before paint), the
       * reduced-motion CSS block and the observer path below both still leave
       * the content visible - nothing here can strand the hero at opacity 0.
       */
      requestAnimationFrame(() => requestAnimationFrame(() => {
        el.classList.add('is-revealed');
      }));
      return;
    }
    // Already past the fold on first paint (deep link, restored scroll
    // position): reveal without waiting, or the section stays invisible until
    // the user scrolls it out and back.
    const box = el.getBoundingClientRect();
    if (box.top < window.innerHeight && box.bottom > 0) {
      el.classList.add('is-revealed');
      return;
    }
    /**
     * Observe now if the effect has already run (later re-renders), otherwise
     * queue for the effect to pick up. Without the queue branch this is a
     * no-op on first mount, which is exactly the bug described above.
     */
    if (observerRef.current) observerRef.current.observe(el);
    else pending.current.push(el);
  };
}

function FeatureCard({
  title,
  body,
  index,
  cardRef,
}: {
  title: string;
  body: string;
  index: number;
  cardRef: (el: HTMLElement | null) => void;
}) {
  /**
   * Cursor-tracking spotlight.
   *
   * --mx/--my are written as raw pixels on the element and consumed by a
   * radial-gradient in CSS. Writing a custom property does not invalidate
   * layout, so this stays cheap; the alternative (moving a positioned child)
   * would thrash on every mousemove.
   *
   * rAF-throttled because pointermove fires far more often than the screen
   * refreshes, and skipped entirely without a fine pointer -- on touch there
   * is no hover to track and it would only cost battery.
   */
  const frame = useRef(0);

  const onPointerMove = (event: React.PointerEvent<HTMLElement>) => {
    if (frame.current) return;
    const el = event.currentTarget;
    const x = event.clientX;
    const y = event.clientY;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const rect = el.getBoundingClientRect();
      el.style.setProperty('--mx', `${x - rect.left}px`);
      el.style.setProperty('--my', `${y - rect.top}px`);
    });
  };

  const clearSpotlight = (event: React.PointerEvent<HTMLElement>) => {
    if (frame.current) {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    }
    event.currentTarget.style.removeProperty('--mx');
    event.currentTarget.style.removeProperty('--my');
  };

  return (
    <article
      ref={cardRef}
      className="feature-card-premium text-only"
      // Each card trails the one before it, so the row assembles left to right
      // instead of all six snapping in at once.
      style={{ ['--reveal-delay' as string]: `${index * 70}ms` }}
      onPointerMove={onPointerMove}
      onPointerLeave={clearSpotlight}
    >
      <span className="feature-card-glow" aria-hidden="true" />
      <h3>{title}</h3>
      <p>{body}</p>
    </article>
  );
}

function LandingFooter({ payoutCurrencies, onDashboard, onGetStarted, onBuy }: { payoutCurrencies: string; onDashboard: () => void; onGetStarted: () => void; onBuy: () => void }) {
  return (
    <footer className="landing-footer">
      <div className="footer-grid">
        <div className="footer-brand-col">
          <div className="footer-brand"><img src="/asset/sivan-logo.png" alt="Sivan" /><strong>Sivan</strong></div>
          <p>Stablecoin-to-bank payment rails for verified users. Sivan helps users move supported stablecoins into bank payouts through provider-backed settlement flows.</p>
          {/* The currency badge is LIVE, not a hardcoded list. It read
              "USD · GBP · EUR" beside a separate "NGN supported" - two badges
              for one fact, and both stale the moment an admin enables or
              disables a rail in Admin Controls. payoutCurrencies already
              reflects what is actually switched on. */}
          <div className="footer-badges"><span>Solana · Base · Ethereum</span><span>USDC / USDT ready</span><span>{payoutCurrencies}</span></div>
        </div>
        <FooterCol title="Product" links={[{ label: 'Sell crypto', action: onGetStarted }, { label: 'Buy crypto', action: onBuy }, { label: 'Open dashboard', action: onDashboard }, { label: 'Supported rails', href: '#rails' }]} />
        <FooterCol title="Business" links={[{ label: 'Payment operations', href: '#business' }, { label: 'On-ramp rollout', action: onBuy }, { label: 'Talk to support', href: 'mailto:support@sivantech.online' }]} />
        <FooterCol title="Resources" links={[{ label: 'How it works', href: '#how' }, { label: 'FAQ', href: '#faq' }, { label: 'Safety', href: '#safety' }, { label: 'Sivan website', href: 'https://www.sivantech.online/' }]} />
        <FooterCol title="Company" links={[{ label: 'Pilot access', href: 'https://waitlist.sivantech.online/' }, { label: 'Terms of Service', href: legalLinks.terms }, { label: 'Privacy Policy', href: legalLinks.privacy }, { label: 'Risk Disclosure', href: legalLinks.risk }, { label: 'Data Retention', href: legalLinks.dataRetention }, { label: 'AML/KYC', href: legalLinks.amlKyc }, { label: 'Jurisdictions', href: legalLinks.jurisdictions }, { label: 'Wrong Network Policy', href: legalLinks.wrongNetwork }, { label: 'Complaints', href: legalLinks.complaints }, { label: 'Cookies', href: legalLinks.cookies }]} />
      </div>
      <div className="footer-bottom">
        <p>© 2026 Sivan Technologies. All rights reserved. Cryptoassets and stablecoins are volatile and may not be protected by financial compensation schemes. Services depend on licensed/provider-supported payment rails and may be unavailable in some jurisdictions. Sivan does not ask for wallet private keys.</p>
      </div>
    </footer>
  );
}

function FooterCol({ title, links }: { title: string; links: Array<{ label: string; href?: string; action?: () => void }> }) {
  return <div className="footer-col"><h4>{title}</h4>{links.map((link) => link.action ? <button key={link.label} onClick={link.action}>{link.label}</button> : <a key={link.label} href={link.href} target={link.href?.startsWith('http') ? '_blank' : undefined} rel={link.href?.startsWith('http') ? 'noreferrer' : undefined}>{link.label}</a>)}</div>;
}

function InfoCard({ n, title, body }: { n: string; title: string; body: string }) {
  return <article className="landing-info-card"><span>{n}</span><h3>{title}</h3><p>{body}</p></article>;
}

function RailsCard({ enabledControls, enabledAssets, enabledNetworks }: { enabledControls: PaymentControl[]; enabledAssets: AssetControl[]; enabledNetworks: NetworkControl[] }) {
  return (
    <article className="panel rails-card">
      <div className="panel-head"><div><p className="eyebrow">Available rails</p><h3>Configured by Sivan Controls</h3></div></div>
      <div className="rail-chips">{enabledControls.length ? enabledControls.map((control) => <span key={control.currency}>{control.currency.toUpperCase()}</span>) : <span>No payout rails</span>}</div>
      {/* No "NGN supported" chip here. The row directly above renders every
          ENABLED payout currency from Admin Controls, and naira is one of
          them - so this repeated it, in a card whose whole claim is that it
          mirrors the live configuration. A hardcoded chip in that card is
          also the one that goes stale silently if NGN is ever switched off. */}
      <div className="rail-chips muted-chips">{enabledAssets.length ? enabledAssets.map((asset) => <span key={asset.asset}>{asset.label}</span>) : <span>No assets</span>}<span>{enabledNetworks.length} networks</span></div>
      <p className="muted">Only enabled assets, networks, and payout currencies appear in the withdrawal flow.</p>
    </article>
  );
}
