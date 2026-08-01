import { useState } from 'react';
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
        <section className="landing-hero premium-hero">
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

        <section className="landing-strip" id="rails">
          <span>{assets}{assets.toLowerCase().includes('usdt') ? '' : ' · USDT ready when enabled'}</span>
          <span>{payoutCurrencies}</span>
          <span>{networks}</span>
          <span>NGN supported</span>
        </section>

        <section className="landing-section two-directions" id="features">
          <div className="section-head center"><p className="eyebrow center">Two directions</p><h2>Move value in either direction.</h2><p>One platform. One verification. Sell crypto to your bank or prepare to buy crypto with fiat with the same simple experience.</p></div>
          <div className="direction-grid">
            <article className="direction-card sell"><span className="chip-pill">↗ Sell</span><h3>Crypto to your bank account.</h3><p>Send stablecoins from any wallet. We convert and pay out through enabled provider-supported bank rails.</p><ul><li>✓ Solana, Base and Ethereum</li><li>✓ Works with USDC and USDT when enabled</li><li>✓ Payouts in {payoutCurrencies} and NGN</li><li>✓ Unique deposit address per withdrawal</li><li>✓ Track confirmations and payout status</li></ul><div><strong>From {feePercent}%</strong><button className="primary-btn" onClick={onGetStarted}>Start selling →</button></div></article>
            <article className="direction-card buy"><span className="chip-pill purple">↙ Buy</span><em>Rollout ready</em><h3>Buy crypto directly with fiat.</h3><p>Pay by supported bank rails and receive stablecoins in a wallet you control once on-ramp backend rails are live.</p><ul><li>✓ Bank transfer flow planned</li><li>✓ Delivered after payment clears</li><li>✓ Self-custody wallet destination</li><li>✓ Same verification covers both directions</li></ul><div><strong>Provider rollout</strong><button className="secondary-btn" onClick={onBuy}>Start buying →</button></div></article>
          </div>
        </section>

        <section className="landing-section" id="how">
          <div className="section-head center"><p className="eyebrow center">How it works</p><h2>Three steps from crypto to cash.</h2><p>Whether you're buying or selling, the flow is guided end to end with no order books, no trading interface, and no jargon.</p></div>
          <div className="steps-grid-premium">
            <StepCard n="01" icon="♢" title="Create and verify your account" body="Sign up with your email and complete a short identity check. Your verification unlocks supported payment flows." />
            <StepCard n="02" icon="▭" title="Choose rails and send funds" body="Pick your bank, asset, and network. Review the fee and safety warning before a deposit address is created." />
            <StepCard n="03" icon="◷" title="Receive your payout" body="Stablecoin deposits are detected by the provider, converted, and paid out to your selected bank account." />
          </div>
        </section>

        <section className="landing-section" id="business">
          <div className="section-head center"><p className="eyebrow center">Why Sivan</p><h2>Built for people who just want it to work.</h2><p>We've stripped out the complexity and built a regulated-grade ramp experience with everyday users in mind.</p></div>
          <div className="feature-grid-premium">
            <FeatureCard icon="⚡" title="Fast payouts" body="Create a deposit address quickly and track payout status as provider updates arrive." />
            <FeatureCard icon="🔒" title="Non-custodial by design" body="Provider-backed settlement flows handle deposits and payouts. Sivan never asks for private keys." />
            <FeatureCard icon="🌍" title="Global, multi-currency" body={`Cash out to ${payoutCurrencies}, or straight to a Nigerian bank account in NGN.`} />
            <FeatureCard icon="▥" title="Transparent pricing" body={`The live Sivan fee is ${feePercent}%. It is displayed before users receive a deposit address.`} />
            <FeatureCard icon="🛡" title="Built-in compliance" body="Verification, sanctions screening, anti-fraud checks, and provider requirements are built into the guided flow." />
            <FeatureCard icon="☷" title="Clear transaction tracking" body="Users can follow address creation, deposit detection, conversion, payout processing, and completion." />
          </div>
        </section>

        <section className="landing-section faq-section" id="faq">
          <div className="section-head center"><p className="eyebrow center">Frequently asked</p><h2>Questions, answered.</h2></div>
          <div className="faq-list">{faqItems.map((item, index) => <div className={`faq-item ${openFaq === index ? 'open' : ''}`} key={item.q}><button onClick={() => setOpenFaq(openFaq === index ? null : index)}><strong>{item.q}</strong><span>⌄</span></button>{openFaq === index && <p>{item.a}</p>}</div>)}</div>
        </section>

        <section className="landing-section final-cta-section" id="start">
          <div className="final-cta-card"><p className="eyebrow center">Get started</p><h2>Your first transaction in about five minutes.</h2><p>Move between crypto and your bank with a few taps. No exchange account, no order books, no hassle.</p><button className="primary-btn" onClick={onGetStarted}>Create free account →</button><small>Already have an account? <button onClick={onDashboard}>Sign in</button></small></div>
        </section>
      </main>

      <LandingFooter onDashboard={onDashboard} onGetStarted={onGetStarted} onBuy={onBuy} />
    </div>
  );
}

function QuoteBox({ label, amount, asset, helper, editable = false, onAmountChange }: { label: string; amount: string; asset: string; helper: string; editable?: boolean; onAmountChange?: (value: string) => void }) {
  return <div className="quote-box"><div><small>{label}</small>{editable ? <input className="quote-amount-input" value={amount} inputMode="decimal" onChange={(event) => onAmountChange?.(event.target.value)} /> : <strong>{amount}</strong>}</div><div><span>{asset}</span><small>{helper}</small></div></div>;
}

function StepCard({ n, icon, title, body }: { n: string; icon: string; title: string; body: string }) {
  return <article className="step-card-premium"><i>{icon}</i><b>{n}</b><h3>{title}</h3><p>{body}</p></article>;
}

function FeatureCard({ icon, title, body }: { icon: string; title: string; body: string }) {
  return <article className="feature-card-premium"><i>{icon}</i><h3>{title}</h3><p>{body}</p></article>;
}

function LandingFooter({ onDashboard, onGetStarted, onBuy }: { onDashboard: () => void; onGetStarted: () => void; onBuy: () => void }) {
  return (
    <footer className="landing-footer">
      <div className="footer-grid">
        <div className="footer-brand-col">
          <div className="footer-brand"><img src="/asset/sivan-logo.png" alt="Sivan" /><strong>Sivan</strong></div>
          <p>Stablecoin-to-bank payment rails for verified users. Sivan helps users move supported stablecoins into bank payouts through provider-backed settlement flows.</p>
          <div className="footer-badges"><span>Solana · Base · Ethereum</span><span>USDC / USDT ready</span><span>USD · GBP · EUR</span><span>NGN supported</span></div>
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
      <div className="rail-chips muted-chips">{enabledAssets.length ? enabledAssets.map((asset) => <span key={asset.asset}>{asset.label}</span>) : <span>No assets</span>}<span>{enabledNetworks.length} networks</span><span>NGN supported</span></div>
      <p className="muted">Only enabled assets, networks, and payout currencies appear in the withdrawal flow.</p>
    </article>
  );
}
