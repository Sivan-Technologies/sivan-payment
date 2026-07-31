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

const envSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_URL: z.string().url().default('http://localhost:3000'),
  CUSTOMER_APP_URL: z.string().url().optional().default('https://app.sivantech.online'),
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional().default(''),
  SENTRY_ENVIRONMENT: z.string().optional().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  RATE_LIMIT_ENABLED: booleanFromEnv.default(true),
  RATE_LIMIT_DEFAULT_MAX_PER_MINUTE: z.coerce.number().int().positive().default(120),
  RATE_LIMIT_ADMIN_MAX_PER_MINUTE: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_WEBHOOK_MAX_PER_MINUTE: z.coerce.number().int().positive().default(300),
  RATE_LIMIT_AUTH_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  RATE_LIMIT_AUTH_START_MAX: z.coerce.number().int().positive().default(5),
  RATE_LIMIT_AUTH_VERIFY_MAX: z.coerce.number().int().positive().default(20),
  ADMIN_API_KEY: z.string().optional().default(''),
  USER_JWT_SECRET: z.string().default('dev-user-jwt-secret-change-me'),
  USER_JWT_EXPIRES_MINUTES: z.coerce.number().int().positive().default(60),
  AUTH_OTP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(10),
  AUTH_DEV_SHOW_OTP: booleanFromEnv.default(true),
  AUTH_REQUIRE_USER: booleanFromEnv.default(true),
  IDENTITY_LINK_SERVICE_SECRET: z.string().optional().default(''),
  IDENTITY_PAIRING_TOKEN_EXPIRES_MINUTES: z.coerce.number().int().positive().default(10),
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
  WEBHOOK_MAX_AGE_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  SIVAN_OFFRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  SIVAN_ONRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  BRIDGE_OFFRAMP_COST_PERCENT: z.coerce.number().min(0).max(100).default(0.5),
  BRIDGE_KYC_COST_USD: z.coerce.number().min(0).default(2),
  BRIDGE_KYB_COST_USD: z.coerce.number().min(0).default(10),
  CUSTOMER_ACQUISITION_COST_USD: z.coerce.number().min(0).default(0),
  DATABASE_PROVIDER: z.enum(['json', 'postgres']).default('json'),
  DATABASE_URL: z.string().optional().default(''),
  DATABASE_FILE: z.string().default('.data/sivan-offramp.json'),
  VIRTUAL_ACCOUNTS_ENABLED: booleanFromEnv.default(false),
  VIRTUAL_ACCOUNT_REQUESTS_ENABLED: booleanFromEnv.default(false),
  VIRTUAL_ACCOUNT_PROVIDER: z.enum(['mock', 'bridge', 'nomba', 'monnify', 'flutterwave']).default('mock'),
  BRIDGE_VIRTUAL_ACCOUNTS_ENABLED: booleanFromEnv.default(false),
  BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_CURRENCY: z.string().default('usdc'),
  BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_PAYMENT_RAIL: z.string().default('base'),
  // Removed: these named a single pooled wallet/address that every virtual
  // account settled into, making Sivan the holder of user funds contrary to
  // Bridge ToS 2.1(m). Settlement is now each user's own Bridge wallet.
  // Deliberately left out of the schema so a stale value in a Render env or
  // .env file has no effect and cannot silently restore pooled settlement.
  //   BRIDGE_VIRTUAL_ACCOUNT_DESTINATION_ADDRESS
  //   BRIDGE_VIRTUAL_ACCOUNT_BRIDGE_WALLET_ID
  BRIDGE_VIRTUAL_ACCOUNT_DEVELOPER_FEE_PERCENT: z.string().default('0.0'),
  ACE_PROVIDER: z.enum(['local', 'remote']).default('local'),
  SIVAN_AI_API_URL: z.string().url().optional(),
  SIVAN_AI_API_KEY: z.string().optional().default(''),
  SIVAN_AI_TIMEOUT_MS: z.coerce.number().int().positive().default(3500),
  SIVAN_AI_FALLBACK_ENABLED: booleanFromEnv.default(true),
  NGN_PROVIDER: z.enum(['mock', 'linkio', 'eversend', 'nomba', 'paj']).default('mock'),
  NGN_LIVE_PROVIDER_ENABLED: booleanFromEnv.default(false),
  PAJ_RAMP_ENV: z.enum(['staging', 'production']).default('staging'),
  // Breet - primary NGN provider. https://docs.breet.io
  BREET_APP_ID: z.string().optional().default(''),
  BREET_APP_SECRET: z.string().optional().default(''),
  // Required header on every request; Breet rejects a missing or invalid value.
  BREET_ENV: z.enum(['development', 'production']).default('development'),
  BREET_WEBHOOK_SECRET: z.string().optional().default(''),
  // Asset to quote and generate deposit addresses for. From Breet's fetch-assets endpoint.
  BREET_DEFAULT_ASSET_ID: z.string().optional().default(''),
  BREET_DEFAULT_BANK_ID: z.string().optional().default(''),
  BREET_DEFAULT_ACCOUNT_NUMBER: z.string().optional().default(''),
  BREET_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  // On-ramp destination network. ERC20 | TRC20 | BSC | SOL | TON (USDC not on TON).
  BREET_DEFAULT_NETWORK: z.string().optional().default('SOL'),
  BREET_DEFAULT_RECIPIENT_ADDRESS: z.string().optional().default(''),
  PAJ_RAMP_BASE_URL: z.string().url().optional().default('https://api-staging.paj.cash'),
  PAJ_RAMP_API_KEY: z.string().optional().default(''),
  PAJ_RAMP_WEBHOOK_URL: z.string().url().optional().default('https://api.sivantech.online/api/payment/api/webhooks/paj'),
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
  PAJ_RAMP_DEFAULT_ACCOUNT_NUMBER: z.string().optional().default('')
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
