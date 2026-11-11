import { FastifyRequest, FastifyReply } from 'fastify';
import { unauthorized } from '../shared/errors.js';
import { env } from '../config/env.js';
import { developerKeysService } from './developer-keys.service.js';

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
  const startTime = Date.now();
  const apiKey = (
    (request.headers['x-sivan-api-key'] as string) ||
    (request.headers.authorization?.replace(/^Bearer\s+/i, '')) ||
    ''
  ).trim();

  if (!apiKey) {
    throw unauthorized('Missing X-Sivan-Api-Key header. Provide a valid Sivan developer API key.');
  }

  const endpointPath = request.url.split('?')[0];

  // 1. Check Multi-Tenant Developer API Keys database
  if (apiKey.startsWith('sk_live_sivan_') || apiKey.startsWith('sk_test_sivan_')) {
    const devAuth = await developerKeysService.authenticateKey(apiKey, endpointPath);
    if (!devAuth.valid) {
      throw unauthorized(devAuth.reason || 'Invalid or revoked Sivan developer API key.');
    }

    const rec = devAuth.record!;
    (request as any).developerAuth = {
      keyId: rec.id,
      isLive: rec.environment === 'live',
      developerName: rec.developerName,
    } satisfies DeveloperAuthContext;

    // Asynchronously log usage upon response
    reply.raw.on('finish', () => {
      const latencyMs = Date.now() - startTime;
      developerKeysService
        .recordUsageLog({
          keyId: rec.id,
          endpoint: endpointPath,
          method: request.method,
          statusCode: reply.statusCode || 200,
          latencyMs,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'],
        })
        .catch(() => {});
    });

    return;
  }

  // 2. Fallback to B2B Merchant API Keys
  if (apiKey.startsWith('sk_live_') || apiKey.startsWith('sk_test_')) {
    try {
      const { b2bMerchantService } = await import('../business/service/b2b-merchant.service.js');
      const { merchant } = await b2bMerchantService.authenticateApiKey(apiKey);
      const isLive = apiKey.startsWith('sk_live_');
      (request as any).b2bMerchant = merchant;
      (request as any).developerAuth = {
        keyId: apiKey.slice(0, 16),
        isLive,
        developerName: merchant.name,
      } satisfies DeveloperAuthContext;
      return;
    } catch {
      // Continue to static fallback
    }
  }

  // 3. Fallback to Environment Variables or Sandbox Default Keys
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
