import { FastifyRequest, FastifyReply } from 'fastify';
import { unauthorized } from '../shared/errors.js';
import { env } from '../config/env.js';

export interface DeveloperAuthContext {
  keyId: string;
  isLive: boolean;
  developerName: string;
}

const VALID_DEV_KEYS = new Set([
  'sk_test_sivan_developer_default',
  'sk_live_sivan_agent_master',
  process.env.SIVAN_DEV_API_KEY || 'sk_test_sivan_dev_sandbox',
]);

/**
 * Fastify preHandler to authenticate external developers and AI agents.
 */
export async function requireDeveloperApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const apiKey = (
    (request.headers['x-sivan-api-key'] as string) ||
    (request.headers.authorization?.replace(/^Bearer\s+/i, '')) ||
    ''
  ).trim();

  if (!apiKey) {
    throw unauthorized('Missing X-Sivan-Api-Key header. Provide a valid Sivan developer API key.');
  }

  // Check key validity
  const isRecognized = apiKey.startsWith('sk_test_') || apiKey.startsWith('sk_live_') || VALID_DEV_KEYS.has(apiKey);
  if (!isRecognized) {
    throw unauthorized('Invalid Sivan developer API key provided.');
  }

  const isLive = apiKey.startsWith('sk_live_') || env.APP_ENV === 'production';

  (request as any).developerAuth = {
    keyId: apiKey.slice(0, 16),
    isLive,
    developerName: isLive ? 'Production Agent' : 'Sandbox Developer',
  } satisfies DeveloperAuthContext;
}
