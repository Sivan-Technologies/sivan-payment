import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const booleanFromEnv = z.preprocess((value) => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  }
  return value;
}, z.boolean());

const positiveIntFromEnv = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  const num = Number(value);
  if (Number.isNaN(num)) return undefined;
  return num;
}, z.number().int().positive());

const numberFromEnv = z.preprocess((value) => {
  if (value === '' || value === undefined || value === null) return undefined;
  const num = Number(value);
  if (Number.isNaN(num)) return undefined;
  return num;
}, z.number());

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  CUSTOMER_APP_URL: z.string().url().optional().default('https://app.sivantech.online'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),
  ESCROW_AGENT_URL: z.string().url().optional(),
  CORE_API_BASE_URL: z.string().url().optional(),
  WHATSAPP_NOTIFICATION_URL: z.string().url().optional(),
  TEXTILE_CELO_DEPOSIT_ADDRESS: z.string().optional(),
  SIVAN_CELO_AGENT_ADDRESS: z.string().optional(),
  CELO_AGENT_PRIVATE_KEY: z.string().optional().default(''),
  SENTRY_DSN: z.string().optional().default(''),
  SENTRY_ENVIRONMENT: z.string().optional().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  TELEGRAM_OPS_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_OPS_CHAT_ID: z.string().optional().default(''),
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_DEFAULT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_ADMIN_MAX_PER_MINUTE: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE: z.coerce.number().int().positive().default(600),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(60 * 1000),
  RATE_LIMIT_AUTH_START_MAX: z.coerce.number().int().positive().default(30),
  RATE_LIMIT_AUTH_VERIFY_MAX: z.coerce.number().int().positive().default(60),
  ADMIN_API_KEY: z.string().optional().default(''),
  USER_JWT_SECRET: z.string().min(1),
  USER_JWT_EXPIRES_MINUTES: z.coerce.number().int().positive().default(60),

  AUTH_OTP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(10),
  /**
   * Minimum gap between two OTP emails to the SAME address.
   *
   * This is an email-budget control, not an abuse control - the IP+email rate
   * limiter already handles abuse. On the Resend free tier (100/day) the
   * limiter alone permits 480 sends a day from one address, so a cooldown is
   * what actually keeps the quota alive. 0 disables it.
   */
  AUTH_OTP_RESEND_COOLDOWN_SECONDS: z.coerce.number().int().nonnegative().default(60),
  AUTH_DEV_SHOW_OTP: booleanFromEnv.default(true),
  AUTH_REQUIRE_USER: booleanFromEnv.default(true),
  IDENTITY_LINK_SERVICE_SECRET: z.string().optional().default(''),
  IDENTITY_PAIRING_TOKEN_EXPIRES_MINUTES: z.coerce.number().int().positive().default(10),

  /**
   * Failed-attempt lockout on pairing-code redemption. See
   * identity/pairing-attempts.ts for why this exists alongside the per-IP
   * rate limiter rather than relying on it.
   *
   * 6 attempts is chosen to sit above human error and below useful guessing: a
   * user reading a code off another screen gets several tries, an attacker gets
   * 6 shots per 15 minutes at ~21M combinations. The lockout is per
   * (channel, redeeming identity), so one user's fumbling never blocks another.
   */
  IDENTITY_PAIRING_LOCKOUT_ENABLED: booleanFromEnv.default(true),

  /**
   * Require a withdrawal PIN on every money-out request.
   *
   * DEFAULTS TO FALSE, and that is the entire point of it existing.
   *
   * The server can demand a PIN the moment this code deploys. The clients
   * cannot supply one yet: the WhatsApp and Telegram bots have no PIN prompt,
   * and the web withdrawal flow does not collect it. Enforcing on deploy would
   * therefore reject EVERY withdrawal on both rails - including from users who
   * have dutifully set a PIN, because nothing would be asking them for it.
   *
   * So the enforcement ships dark. Turn it on only once every client can
   * prompt, and turn it on for one deployment at a time, because the failure
   * mode is total: no user can withdraw by any route.
   */
  WITHDRAWAL_PIN_ENFORCED: booleanFromEnv.default(false),

  IDENTITY_PAIRING_MAX_FAILED_ATTEMPTS: z.coerce.number().int().positive().default(6),
  IDENTITY_PAIRING_LOCKOUT_WINDOW_MINUTES: z.coerce.number().int().positive().default(15),
  IDENTITY_PAIRING_LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().optional().default('Sivan <no-reply@sivan.local>'),
  LEGAL_TERMS_VERSION: z.string().default('2026-07-14'),
  LEGAL_PRIVACY_VERSION: z.string().default('2026-07-14'),
  LEGAL_RISK_DISCLOSURE_VERSION: z.string().default('2026-07-14'),
  SUPPORT_NOTIFICATION_EMAIL: z.preprocess((value) => value === '' ? undefined : value, z.string().email().optional()).default(''),
  SUPPORT_UPLOAD_PROVIDER: z.enum(['disabled', 'mock', 'r2']).default('disabled'),
  SUPPORT_ATTACHMENT_MAX_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  R2_ENDPOINT: z.string().optional().default(''),
  R2_REGION: z.string().optional().default('auto'),
  R2_ACCESS_KEY_ID: z.string().optional().default(''),
  R2_SECRET_ACCESS_KEY: z.string().optional().default(''),
  R2_BUCKET: z.string().optional().default(''),
  R2_PUBLIC_BASE_URL: z.string().optional().default(''),
  BRIDGE_MOCK_MODE: booleanFromEnv.default(false),
  DEFAULT_OFFRAMP_PROVIDER: z.string().default('bridge'),
  BRIDGE_BASE_URL: z.string().url().default('https://api.sandbox.bridge.xyz/v0'),
  BRIDGE_API_KEY: z.string().optional().default(''),
  BRIDGE_WEBHOOK_PUBLIC_KEY: z.string().optional().default(''),
  AVALANCHE_RPC_URL: z.string().url().optional(),
  /**
   * Solana RPC, primary then fallback.
   *
   * Needed because Privy SIGNS but does not READ. Whether a recipient already
   * holds a USDC token account is a chain-state question only an RPC can
   * answer, and getting it wrong means a transfer that fails or funds sent to
   * an account nobody can spend from.
   *
   * The public endpoint works but is rate-limited and explicitly not for
   * production, so it is the last resort rather than the default.
   */
  /**
   * Where the Sivan transfer fee is collected, on Solana.
   *
   * WHY THIS EXISTS. The fee was being deducted in the LEDGER only: the chain
   * moved `amount - fee` to the recipient and the fee simply stayed in the
   * sending user's own wallet. Sivan's books recorded revenue that had never
   * left the customer's custody, scattered a few cents at a time across every
   * user - real accounting, unrealised money, and nothing to reconcile against.
   *
   * WHY NOT A SWEEP JOB. Collecting later means a whole extra transaction per
   * user, so Sivan would pay gas twice to recover a $0.25 fee - worse
   * economics than not collecting at all. Solana bills per SIGNATURE, not per
   * instruction, so the fee transfer rides along as a second instruction in
   * the transaction that was already being paid for. One signature, one gas
   * cost, and the fee lands atomically with the send: if the transfer fails,
   * no fee moves and there is nothing to reconcile.
   *
   * Empty by default. Absent or malformed means the previous behaviour - the
   * fee stays in the user's wallet - which is the safe direction: the worst
   * outcome is uncollected revenue, never a misdirected transfer.
   */
  SIVAN_FEE_WALLET_SOLANA: z.string().optional().default(''),
  SIVAN_FEE_WALLET_STELLAR: z.string().optional().default(''),
  SIVAN_FEE_WALLET_CELO: z.string().optional().default(''),
  SIVAN_CELO_FEE_WALLET: z.string().optional().default(''),
  SOLANA_RPC_URL: z.string().url().optional(),
  SOLANA_RPC_FALLBACK_URL: z.string().url().optional(),
  /**
   * EVM RPC, per chain. Same reason as Solana above: Privy signs but does not
   * read, so a displayed balance needs an eth_call somewhere.
   *
   * Optional, and the public endpoint is the fallback. Public Base/Ethereum
   * RPCs are aggressively rate-limited and will start refusing a deployment
   * that leans on them, which surfaces as an unavailable balance rather than a
   * wrong one - degraded, but not dishonest.
   */
  BASE_RPC_URL: z.string().url().optional(),
  BASE_RPC_FALLBACK_URL: z.string().url().optional(),
  ETHEREUM_RPC_URL: z.string().url().optional(),
  ETHEREUM_RPC_FALLBACK_URL: z.string().url().optional(),
  STELLAR_HORIZON_URL: z.string().url().optional(),
  STELLAR_SPONSOR_ACCOUNT_ID: z.string().optional(),
  STELLAR_SPONSOR_SECRET_KEY: z.string().optional(),
  STELLAR_MAX_FEE_STROOPS: z.coerce.number().optional().default(1000),
  STELLAR_SPONSORED_RESERVES: z.coerce.boolean().optional().default(true),
  BALANCE_TRANSFERS_ENABLED: z.coerce.boolean().default(true),
  WEBHOOK_MAX_AGE_MS: positiveIntFromEnv.default(10 * 60 * 1000),
  /**
   * 1.25%, not 0.
   *
   * A zero default meant a deployment that forgot the variable earned Sivan
   * nothing on every off-ramp, silently and indefinitely. Worse, this figure
   * is the FALLBACK for the virtual-account fee, and Bridge fixes a VA fee at
   * provisioning time and will not change it retroactively - so a VA created
   * while this was 0 earned nothing for the life of the account, unreclaimably.
   *
   * A revenue default of zero is not a safe default. It is a silent one.
   */
  SIVAN_OFFRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(1.25),
  SIVAN_ONRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  BRIDGE_OFFRAMP_COST_PERCENT: z.coerce.number().min(0).max(100).default(0.5),
  BRIDGE_KYC_COST_USD: z.coerce.number().min(0).default(2),
  BRIDGE_KYB_COST_USD: z.coerce.number().min(0).default(10),
  CUSTOMER_ACQUISITION_COST_USD: z.coerce.number().min(0).default(0),
  /**
   * Which chain network THIS DEPLOYMENT signs against.
   *
   * A deployment-wide constant, not a per-user setting: the test stack runs
   * testnet, the live stack runs mainnet, and no request can move a process
   * between them. See src/wallets/network-mode.ts for why it is pinned here
   * rather than offered as a control.
   *
   * Defaults to mainnet so a service that forgets to set it behaves like
   * production - real money, and every fiat guard active. Defaulting the other
   * way would sign real transfers onto a chain nobody is watching.
   */
  NETWORK_MODE: z.enum(['mainnet', 'testnet']).default('mainnet'),

  DATABASE_PROVIDER: z.enum(['json', 'postgres']).default('json'),

  DATABASE_URL: z.string().optional().default(''),
  DATABASE_FILE: z.string().default('.data/sivan-offramp.json'),
  VIRTUAL_ACCOUNTS_ENABLED: booleanFromEnv.default(false),
  VIRTUAL_ACCOUNT_REQUESTS_ENABLED: booleanFromEnv.default(false),
  VIRTUAL_ACCOUNT_PROVIDER: z.enum(['mock', 'bridge', 'nomba', 'monnify', 'flutterwave']).default('mock'),
  BRIDGE_VIRTUAL_ACCOUNTS_ENABLED: booleanFromEnv.default(false),
  /**
   * Minimum USD before a virtual-account settlement is swept Bridge -> Privy.
   *
   * SIX DOLLARS, AND FOR THIS SWEEP ONLY. Not Sivan/Privy user transfers, not
   * the NGN off-ramp sweep - those move money a user explicitly asked to move,
   * where a minimum would block a legitimate instruction. This one is an
   * automatic internal hand-off nobody requested, so it is the only place a
   * "not worth the gas" floor belongs.
   *
   * Sized against the ~$0.31 first-time SPL token-account rent rather than the
   * network fee. Below the floor the balance stays credited and spendable, and
   * the next deposit sweeps the accumulated total.
   */
  BRIDGE_TO_PRIVY_MIN_SWEEP_USD: z.coerce.number().min(0).default(6),
  BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_CURRENCY: z.string().default('usdc'),
  /**
   * Solana. Settlement lands on the chain the product actually runs on -
   * cheapest gas, and the network every Nigerian off-ramp already quotes.
   */
  BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL: z.string().default('solana'),
  // Removed: these named a single pooled wallet/address that every virtual
  // account settled into, making Sivan the holder of user funds contrary to
  // Bridge ToS 2.1(m). Settlement is now each user's own Bridge wallet.
  // Deliberately left out of the schema so a stale value in a Render env or
  // .env file has no effect and cannot silently restore pooled settlement.
  //   BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS
  //   BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID
  /**
   * The developer fee Bridge charges on virtual-account deposits, as a percent.
   *
   * FIXED AT PROVISIONING. Bridge accepts developer_fee_percent when the
   * virtual account is created; every deposit that lands afterwards is billed
   * at whatever was set then, and those cannot be reclaimed. A wrong value here
   * is not a config mistake to be corrected later - it is permanent revenue
   * loss for that account.
   *
   * Defaulted to 1.25 rather than '0.0' for that reason, and enforced as a
   * non-zero floor at the provisioning call itself - see
   * assertVirtualAccountFeeConfigured().
   */
  BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT: z.string().default('1.25'),
  ACE_PROVIDER: z.enum(['local', 'remote']).default('local'),
  SIVAN_AI_API_URL: z.string().url().optional(),
  SIVAN_AI_API_KEY: z.string().optional().default(''),
  // 3500 was too short for a real model call. Sivan AI runs on a free Render
  // instance that sleeps after 15 minutes; a cold start measured 23s, and even
  // warm, a knowledge-grounded answer rarely returns inside 3.5s. The practical
  // effect was that ACE_PROVIDER=remote was set but almost every request aborted
  // and fell back to the local canned answer - Sia looked "connected" in config
  // and was not connected in behaviour, silently, because the fallback is quiet.
  //
  // 9000 is a ceiling, not a target: it MUST stay under the Cloudflare worker's
  // 12s UPSTREAM_TIMEOUT_MS. Past that the worker aborts first and the user gets
  // a 503 instead of the graceful local fallback, which is strictly worse.
  //
  // A cold start still exceeds this. That case is handled by warming the service
  // when the drawer opens (see /api/ace/warmup) rather than by waiting longer.
  SIVAN_AI_TIMEOUT_MS: z.coerce.number().int().positive().default(9000),

  SIVAN_AI_FALLBACK_ENABLED: booleanFromEnv.default(true),
  // 'breet' was missing here while ngn-provider-registry.ts already had a
  // `if (name === 'breet')` branch. The registry could never be reached:
  // NGN_PROVIDER=breet failed this enum and the whole service refused to boot,
  // so the Breet integration was unreachable by configuration.
  NGN_PROVIDER: z.enum(['mock', 'linkio', 'eversend', 'nomba', 'paj', 'breet']).default('mock'),
  NGN_LIVE_PROVIDER_ENABLED: booleanFromEnv.default(false),
  PAJ_RAMP_ENV: z.enum(['staging', 'production']).default('staging'),
  // Breet - primary NGN provider. https://docs.breet.io
  // Sivan's own margin on the NGN rail, separate from the Bridge percentages.
  // 0 means "not set" and the NGN flows fall back to the Bridge fees.
  SIVAN_NGN_ONRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  SIVAN_NGN_OFFRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  SIVAN_NGN_MINIMUM_FEE_NGN: z.coerce.number().min(0).default(0),
  /**
   * How Sivan earns revenue on NGN off-ramp.
   *
   * sivan_fee_wallet: visible Sivan margin, collected on-chain into Sivan's
   * fee wallet during the Privy sweep.
   * breet_markup: Breet applies markup inside its rate/settlement; Sivan must
   * not also collect an on-chain fee.
   * disabled: no Sivan revenue, only provider cost.
   */
  NGN_OFFRAMP_REVENUE_MODE: z.enum(['sivan_fee_wallet', 'breet_markup', 'disabled']).default('sivan_fee_wallet'),
  // Privy - embedded wallet layer. https://docs.privy.io
  // Wallets are USER-OWNED: Sivan holds neither funds nor keys, so a transfer
  // needs the user's signature. See privy-wallet.provider.ts for why.
  /**
   * Fallback wallet provider, used when no admin override is set.
   *
   * Was only ever read through process.env, so it was invisible to the typed
   * config and could not be validated. The admin control in
   * wallet-controls.service.ts takes precedence over this.
   */
  WALLET_PROVIDER: z.string().optional().default('mock'),
  PRIVY_APP_ID: z.string().optional().default(''),
  PRIVY_APP_SECRET: z.string().optional().default(''),
  /**
   * P-256 private key (PKCS#8 PEM) for Sivan's delegated signer.
   *
   * Its presence is what makes one-tap off-ramp possible: with it the backend
   * can move USDC out of a user-owned Privy wallet as an ADDITIONAL SIGNER;
   * without it createTransfer honestly returns pending_user_signature. Absent
   * by default so the safe behaviour is the default.
   */
  PRIVY_AUTHORIZATION_PRIVATE_KEY: z.string().optional().default(''),
  /** Key quorum id holding that public key, attached to wallets at creation. */
  PRIVY_AUTHORIZATION_KEY_QUORUM_ID: z.string().optional().default(''),
  BREET_APP_ID: z.string().optional().default(''),
  BREET_APP_SECRET: z.string().optional().default(''),
  // Required header on every request; Breet rejects a missing or invalid value.
  BREET_ENV: z.enum(['development', 'production']).default('development'),
  /**
   * TREAT SANDBOX BANK RESOLUTIONS AS TRUSTWORTHY EVIDENCE.
   *
   * OFF by default, and it must stay off anywhere real money moves.
   *
   * Breet's sandbox returns a plausible name for ANY account number - verified
   * live, just now: 0000000000, 1234567890 and 9999999999 at PalmPay all
   * resolve to "Samuel Udochukwu". A name match against that proves nothing,
   * so sandbox resolutions are marked untrustworthy and a clean match is sent
   * to a human instead of granting Level 1.
   *
   * That is the right call, and it had an unintended consequence: on the test
   * environment the auto-approve path became UNREACHABLE. Every perfect match
   * queued for review - 38 of them, all "Samuel Udochukwu" vs "Samuel
   * Udochukwu", score 1.0 - so the behaviour that will run in production was
   * the one behaviour nobody could exercise or see.
   *
   * This switch makes that path testable WITHOUT weakening production, because
   * turning it on is a deliberate, visible, per-environment act rather than a
   * quiet relaxation of the rule.
   *
   * The receipts, taken live against Breet's sandbox:
   *
   *   PalmPay 1111111111 -> Samuel Udochukwu
   *   PalmPay 0000000000 -> Samuel Udochukwu
   *   PalmPay 1234567890 -> Samuel Udochukwu
   *   PalmPay 9999999999 -> Samuel Udochukwu
   *   Access  1111111111 -> Samuel Udochukwu   (any BANK id, too)
   *
   * Always the API key owner, whatever you ask for. That is why the gate
   * exists and why this override must never reach anywhere real.
   *
   * REFUSED IN PRODUCTION, and against any live bank resolver. Enforced in
   * app.ts at boot, not merely documented: a comment saying "do not set this
   * in production" is not a control.
   */
  NGN_TRUST_SANDBOX_BANK_RESOLUTION: booleanFromEnv.default(false),
  BREET_WEBHOOK_SECRET: z.string().optional().default(''),
  /**
   * How often to ask the NGN provider what it actually settled, in seconds.
   *
   * The webhook is not trustworthy enough to be the only path: six real
   * deliveries for one completed, paid-out settlement were all refused, and
   * the transfer sat at "awaiting_crypto_deposit" while the naira was already
   * in the user's bank. This closes that gap whatever happens to delivery.
   *
   * 0 disables it. Default 300s - fast enough that a stuck payout is measured
   * in minutes, slow enough to be nothing to a partner API.
   */
  NGN_SETTLEMENT_POLL_SECONDS: z.coerce.number().int().nonnegative().default(300),
  /**
   * How often to re-check crypto sends that are still 'processing'.
   *
   * Nothing ever confirmed them before this: 'completed' was declared in the
   * status union and never assigned to a transfer, so a send that had settled
   * on chain within seconds still read "Processing" hours later. 0 disables.
   */
  TRANSFER_CONFIRM_POLL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  /** Age at which an unconfirmed send is escalated to a human, in minutes. */
  TRANSFER_CONFIRM_STALE_MINUTES: z.coerce.number().int().positive().default(30),
  /**
   * How often to sweep wallets for inbound deposits, in seconds. 0 disables.
   *
   * 60s because an exchange withdrawal takes minutes to arrive on chain, so a
   * finer interval buys nothing a user could perceive while multiplying RPC
   * calls by the number of wallets. This is a stopgap detector; the real fix is
   * RPC webhooks, at which point this goes to 0.
   */
  DEPOSIT_POLL_SECONDS: z.coerce.number().int().nonnegative().default(60),
  /**
   * How often to deliver deposit notifications, in seconds. 0 disables.
   *
   * Separate from detection on purpose: a failing email provider must not stop
   * deposits being RECORDED, and a slow sweep must not delay the alert for a
   * deposit already found. The two loops share only the database.
   */
  DEPOSIT_NOTIFY_SECONDS: z.coerce.number().int().nonnegative().default(45),
  /**
   * How often to re-check pending deposits for finality, in seconds. 0
   * disables.
   *
   * Separate from both detection and notification, for the same reason those
   * two are separate from each other: a slow chain read while confirming an
   * old deposit must not delay DETECTING a new one. Without this loop a
   * deposit stays 'pending' forever - which is exactly what shipped, and what
   * put "In progress" next to money the balance card already called spendable.
   *
   * 45s rather than the scan's 60s: confirmation is the tail of the delay a
   * user actually watches, and waiting longer saves no chain reads.
   */
  DEPOSIT_CONFIRM_SECONDS: z.coerce.number().int().nonnegative().default(45),
  /**
   * How often the service agreement deadline sweeper runs, in seconds. 0 disables.
   *
   * Checks funded/in_delivery agreements for approaching or missed deadlines and
   * dispatches proactive notifications (6-hour warning to seller; overdue notice
   * to both buyer and seller). 300s (5 minutes) is fine-grained enough to catch
   * the 6-hour window well in advance while not generating noise under load.
   */
  DEADLINE_SWEEP_SECONDS: z.coerce.number().int().nonnegative().default(300),
  // Breet's merchant reference for this integration. Identifies Sivan to Breet
  // in support and reconciliation; not a credential.
  BREET_MERCHANT_REFERENCE: z.string().optional().default(''),
  // Asset to quote and generate deposit addresses for. From Breet's fetch-assets endpoint.
  BREET_DEFAULT_ASSET_ID: z.string().optional().default(''),
  BREET_DEFAULT_BANK_ID: z.string().optional().default(''),
  BREET_DEFAULT_ACCOUNT_NUMBER: z.string().optional().default(''),
  // Breet's platform fee, confirmed by their team: 0.5%, applied ON TOP of the
  // rate rather than baked into the spread, computed as
  // (feePercentage / 100) x amountInUSD. Defaulting to 0 would have quoted
  // users a rate Sivan cannot settle at and eaten the difference.
  BREET_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0.5),
  // On-ramp destination network, in SIVAN's vocabulary (solana, ethereum,
  // base, ...), not Breet's. breet-networks.ts translates and refuses pairs
  // Breet cannot service. Defaulting to Breet's own 'SOL' here would not match
  // the map and every on-ramp would be refused.
  BREET_DEFAULT_NETWORK: z.string().optional().default('solana'),
  BREET_DEFAULT_RECIPIENT_ADDRESS: z.string().optional().default(''),
  PAJ_RAMP_BASE_URL: z.string().url().optional().default('https://api-staging.paj.cash'),
  PAJ_RAMP_API_KEY: z.string().optional().default(''),
  PAJ_RAMP_WEBHOOK_URL: z.string().url().optional(),
  PAJ_RAMP_DEFAULT_CURRENCY: z.string().default('NGN'),
  PAJ_RAMP_DEFAULT_CHAIN: z.enum(['SOLANA', 'MONAD']).default('SOLANA'),
  PAJ_RAMP_USDC_MINT: z.string().optional().default(''),
  PAJ_RAMP_USDT_MINT: z.string().optional().default(''),
  PAJ_RAMP_BUSINESS_USDC_FEE: z.string().default('0'),
  PAJ_RAMP_REQUIRE_SIVAN_KYC: booleanFromEnv.default(true),
  PAJ_RAMP_SESSION_MODE: z.enum(['merchant', 'user_otp']).default('merchant'),
  PAJ_RAMP_MERCHANT_TOKEN: z.string().optional().default(''),
  PAJ_RAMP_DEFAULT_RECIPIENT_ADDRESS: z.string().optional().default(''),
  PAJ_RAMP_DEFAULT_BANK_ID: z.string().optional().default(''),
  PAJ_RAMP_DEFAULT_ACCOUNT_NUMBER: z.string().optional().default(''),
  KYC_LEVEL_PROVIDER: z.enum(['mock', 'monnify', 'flutterwave', 'identifyorg']).default('mock'),
  MONNIFY_BASE_URL: z.string().url().optional().default('https://api.monnify.com'),
  MONNIFY_API_KEY: z.string().optional().default(''),
  MONNIFY_SECRET_KEY: z.string().optional().default(''),
  MONNIFY_CONTRACT_CODE: z.string().optional().default(''),

  /**
   * FLUTTERWAVE, as a SECOND BVN provider alongside Monnify.
   *
   * Two providers rather than one because a single BVN vendor is a single
   * point of failure on the step that gates every Nigerian's limits. If
   * Monnify is down or rejects a valid BVN, an operator can switch rather than
   * strand Level 2 for everybody.
   *
   * v3 (consent) is the CBN-compliant path and the one to use: NIBSS requires
   * the BVN owner to approve the merchant before their data is released. v2 is
   * a direct lookup with no consent step - kept reachable behind a flag
   * because some accounts still have it enabled, but it must not be the
   * default. See KYC-DESIGN.md.
   */
  /**
   * IDENTIFYORG - the third BVN provider, and the one intended to carry Level 2.
   *
   * WHY A THIRD. The other two cannot currently do the job:
   *   - Monnify has no live API key issued to this account at all.
   *   - Flutterwave's working path is v2, a direct lookup with NO consent step,
   *     which is exactly the thing the CBN expects a merchant not to do. Its
   *     compliant v3 consent flow needs a human on a NIBSS page and so cannot
   *     settle synchronously.
   *
   * IdentifyOrg answers a BVN match in ONE synchronous call - under 3 seconds
   * by their own documentation - and accepts first_name/last_name/date_of_birth
   * for cross-matching, which is precisely the shape BvnInfoMatchInput already
   * carries. That is why it slots in without changing the interface.
   *
   * ONE HEADER, NO TOKEN DANCE: X-IdentifyOrg-Key. Unlike Monnify there is no
   * OAuth step to fail separately, which is also what makes health() honest -
   * GET /v1/balance either answers with a real credit balance or it does not.
   *
   * COST IS PER CALL and denominated in NGN (their responses carry a `cost`
   * field). Nothing in the provider retries on its own: a retry loop against a
   * metered identity API is a spending bug as much as a correctness one.
   */
  IDENTIFYORG_BASE_URL: z.string().url().optional().default('https://api.identifyorg.com'),
  IDENTIFYORG_API_KEY: z.string().optional().default(''),
  /**
   * The confidence at or above which a cross-match counts as `matched`.
   *
   * Their BVN response carries `match` (boolean) AND `confidence_score`
   * (0-100). Trusting `match` alone would accept a weak cross-match as proof
   * of identity on the step that raises a user's ceiling to NGN 5,000,000, so
   * a score below this threshold is downgraded to `review` for a human rather
   * than granted. 80 is deliberately conservative; raise it, never lower it
   * silently.
   */
  IDENTIFYORG_MIN_CONFIDENCE: z.coerce.number().min(0).max(100).default(80),

  FLUTTERWAVE_BASE_URL: z.string().url().optional().default('https://api.flutterwave.com'),
  FLUTTERWAVE_V2_BASE_URL: z.string().url().optional().default('https://api.ravepay.co'),
  FLUTTERWAVE_SECRET_KEY: z.string().optional().default(''),
  /**
   * Where NIBSS returns the customer after they approve or decline.
   *
   * Required by the consent endpoint. Pointed at the frontend, not the API:
   * the customer is a human in a browser and must land on a page, not on JSON.
   */
  FLUTTERWAVE_BVN_REDIRECT_URL: z.string().optional().default(''),
  /**
   * Use the v2 direct lookup instead of v3 consent. OFF by default.
   *
   * A deliberate, visible switch rather than a silent fallback: skipping
   * consent is a compliance decision, not a technical one, and it should be
   * something an operator turns on knowingly.
   */
  /**
   * booleanFromEnv, NOT z.coerce.boolean().
   *
   * z.coerce.boolean() is JavaScript truthiness: the STRING 'false' is a
   * non-empty string and therefore coerces to TRUE. Setting
   * FLUTTERWAVE_BVN_ALLOW_V2_DIRECT=false would have silently ENABLED the
   * no-consent lookup - the exact opposite of the operator's instruction, on
   * a compliance switch. Caught by a test that expected v3 and got v2.
   */
  FLUTTERWAVE_BVN_ALLOW_V2_DIRECT: booleanFromEnv.default(false)
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
