import type { FastifyInstance } from 'fastify';
import { passkeyService } from './passkey.service.js';

export async function passkeyRoutes(app: FastifyInstance) {
  /**
   * Generates registration challenge for WebAuthn passkey setup.
   */
  app.post('/api/identity/passkey/register/challenge', async (request, reply) => {
    const { userId } = (request.body || {}) as { userId?: string };
    if (!userId) return reply.code(400).send({ error: { message: 'Missing userId' } });

    try {
      const challenge = await passkeyService.createRegistrationChallenge(userId);
      return { data: challenge };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message } });
    }
  });

  /**
   * Verifies challenge and saves new biometric passkey credential.
   */
  app.post('/api/identity/passkey/register/verify', async (request, reply) => {
    const { userId, challenge, credentialId, publicKey, deviceType, deviceName, transports } = (request.body || {}) as any;
    if (!userId || !challenge || !credentialId || !publicKey) {
      return reply.code(400).send({ error: { message: 'Missing required passkey registration fields' } });
    }

    try {
      const credential = await passkeyService.verifyAndSaveRegistration({
        userId,
        challenge,
        credentialId,
        publicKey,
        deviceType,
        deviceName,
        transports,
      });
      return { data: { success: true, credential } };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message } });
    }
  });

  /**
   * Generates authentication challenge for biometric step-up transfer.
   */
  app.post('/api/identity/passkey/auth/challenge', async (request, reply) => {
    const { userId } = (request.body || {}) as { userId?: string };
    if (!userId) return reply.code(400).send({ error: { message: 'Missing userId' } });

    try {
      const challenge = await passkeyService.createAuthenticationChallenge(userId);
      return { data: challenge };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message, code: err.details?.code } });
    }
  });

  /**
   * Verifies biometric authentication and returns single-use step-up token.
   */
  app.post('/api/identity/passkey/auth/verify', async (request, reply) => {
    const { userId, challenge, credentialId, signature, amount, currency, destinationRef, channel } = (request.body || {}) as any;
    if (!userId || !challenge || !credentialId || !amount || !currency || !destinationRef) {
      return reply.code(400).send({ error: { message: 'Missing required biometric authentication fields' } });
    }

    try {
      const result = await passkeyService.verifyAuthenticationAndMintStepUp({
        userId,
        challenge,
        credentialId,
        signature,
        amount,
        currency,
        destinationRef,
        channel,
      });
      return { data: result };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message } });
    }
  });

  /**
   * Direct Telegram Mini-App (TMA) Biometric Token verification.
   */
  app.post('/api/identity/passkey/tma/verify', async (request, reply) => {
    const { userId, biometricToken, amount, currency, destinationRef } = (request.body || {}) as any;
    if (!userId || !biometricToken || !amount || !currency || !destinationRef) {
      return reply.code(400).send({ error: { message: 'Missing TMA biometric parameters' } });
    }

    try {
      const result = await passkeyService.verifyTmaBiometricDirect({
        userId,
        biometricToken,
        amount,
        currency,
        destinationRef,
      });
      return { data: result };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message } });
    }
  });

  /**
   * Lists user's registered passkey devices.
   */
  app.get('/api/identity/passkey/list/:userId', async (request, reply) => {
    const { userId } = request.params as { userId: string };
    try {
      const list = await passkeyService.listUserPasskeys(userId);
      return { data: list };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message } });
    }
  });

  /**
   * Deletes a registered passkey device.
   */
  app.delete('/api/identity/passkey/:credentialId', async (request, reply) => {
    const { credentialId } = request.params as { credentialId: string };
    const { userId } = (request.query || {}) as { userId?: string };
    if (!userId) return reply.code(400).send({ error: { message: 'Missing userId' } });

    try {
      const deleted = await passkeyService.deletePasskey(userId, credentialId);
      return { data: { success: deleted } };
    } catch (err: any) {
      return reply.code(err.statusCode || 400).send({ error: { message: err.message } });
    }
  });
}
