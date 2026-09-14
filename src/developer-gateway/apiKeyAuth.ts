import { FastifyRequest, FastifyReply } from 'fastify';
import { unauthorized } from '../shared/errors.js';
import { env } from '../config/env.js';

export interface DeveloperAuthContext {
  keyId: string;
  isLive: boolean;
  developerName: string;
}

function getValidDevKeys(): Set<string> {
  const keys = new Set<string>();
  if (process.env.SIVAN_DEV_API_KEY) {
    keys.add(process.env.SIVAN_DEV_API_KEY);
  }
  if (env.APP_ENV !== 'production') {
    keys.add('sk_test_sivan_developer_default');
    keys.add('sk_test_sivan_dev_sandbox');
  }
  return keys;
}

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
  const validKeys = getValidDevKeys();
  const isRecognized =
    (env.APP_ENV !== 'production' && apiKey.startsWith('sk_test_')) ||
    validKeys.has(apiKey) ||
    (Boolean(process.env.SIVAN_DEV_API_KEY) && apiKey === process.env.SIVAN_DEV_API_KEY);
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
