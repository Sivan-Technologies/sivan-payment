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
  CORS_ORIGIN: z.string().default('*'),
  LOG_LEVEL: z.string().default('info'),
  SENTRY_DSN: z.string().optional().default(''),
  SENTRY_ENVIRONMENT: z.string().optional().default(''),
  SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
  ADMIN_API_KEY: z.string().optional().default(''),
  USER_JWT_SECRET: z.string().default('dev-user-jwt-secret-change-me'),
  USER_JWT_EXPIRES_MINUTES: z.coerce.number().int().positive().default(60),
  AUTH_OTP_EXPIRES_MINUTES: z.coerce.number().int().positive().default(10),
  AUTH_DEV_SHOW_OTP: booleanFromEnv.default(true),
  AUTH_REQUIRE_USER: booleanFromEnv.default(true),
  EMAIL_PROVIDER: z.enum(['console', 'resend']).default('console'),
  RESEND_API_KEY: z.string().optional().default(''),
  EMAIL_FROM: z.string().optional().default('Sivan <no-reply@sivan.local>'),
  BRIDGE_MOCK_MODE: booleanFromEnv.default(true),
  DEFAULT_OFFRAMP_PROVIDER: z.string().default('bridge'),
  BRIDGE_BASE_URL: z.string().url().default('https://api.sandbox.bridge.xyz/v0'),
  BRIDGE_API_KEY: z.string().optional().default(''),
  BRIDGE_WEBHOOK_PUBLIC_KEY: z.string().optional().default(''),
  WEBHOOK_MAX_AGE_MS: z.coerce.number().int().positive().default(10 * 60 * 1000),
  SIVAN_OFFRAMP_FEE_PERCENT: z.coerce.number().min(0).max(100).default(0),
  BRIDGE_OFFRAMP_COST_PERCENT: z.coerce.number().min(0).max(100).default(0.5),
  BRIDGE_KYC_COST_USD: z.coerce.number().min(0).default(2),
  BRIDGE_KYB_COST_USD: z.coerce.number().min(0).default(10),
  CUSTOMER_ACQUISITION_COST_USD: z.coerce.number().min(0).default(0),
  DATABASE_PROVIDER: z.enum(['json', 'postgres']).default('json'),
  DATABASE_URL: z.string().optional().default(''),
  DATABASE_FILE: z.string().default('.data/sivan-offramp.json')
});

export const env = envSchema.parse(process.env);
export type Env = typeof env;
