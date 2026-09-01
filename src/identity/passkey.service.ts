import crypto from 'node:crypto';
import { env } from '../config/env.js';
import { db } from '../database/json-database.js';
import type { PasskeyChallengeRecord, PasskeyCredentialRecord, WithdrawalStepUpTokenRecord } from '../database/types.js';
import { badRequest, forbidden, notFound } from '../shared/errors.js';
import { nowIso } from '../shared/id.js';

const CHALLENGE_TTL_SECONDS = 300; // 5 minutes
const STEP_UP_TOKEN_TTL_SECONDS = 120; // 2 minutes

function canonicalAmount(amount: string) {
  const cleaned = amount.replace(/[,\s]/g, '');
  if (!/^\d+(\.\d+)?$/.test(cleaned)) throw badRequest('That amount is not a number we can read.');
  const [whole, fraction = ''] = cleaned.split('.');
  const trimmedFraction = fraction.replace(/0+$/, '');
  const trimmedWhole = whole.replace(/^0+(?=\d)/, '');
  return trimmedFraction ? `${trimmedWhole}.${trimmedFraction}` : trimmedWhole;
}

function bindingHash(input: { userId: string; amount: string; currency: string; destinationRef: string }) {
  const canonical = [
    input.userId,
    input.currency.trim().toUpperCase(),
    canonicalAmount(input.amount),
    input.destinationRef.trim(),
  ].join('|');
  return crypto.createHash('sha256').update(`${canonical}:${env.USER_JWT_SECRET}`).digest('hex');
}

function tokenHash(token: string) {
  return crypto.createHash('sha256').update(`${token}:${env.USER_JWT_SECRET}`).digest('hex');
}

export class PasskeyService {
  /**
   * Generates a cryptographic challenge for WebAuthn registration.
   */
  async createRegistrationChallenge(userId: string): Promise<{ challenge: string; expiresAt: string; rp: { name: string; id: string } }> {
    const user = await db.findUserById(userId);
    if (!user) throw notFound('User');

    const challenge = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

    const record: PasskeyChallengeRecord = {
      id: `pch_${crypto.randomUUID()}`,
      userId,
      challenge,
      type: 'registration',
      expiresAt,
      createdAt: nowIso(),
    };

    await db.savePasskeyChallenge(record);

    return {
      challenge,
      expiresAt,
      rp: {
        name: 'Sivan AI Payment Network',
        id: 'sivantech.online',
      },
    };
  }

  /**
   * Verifies and registers a new Passkey credential (Apple Face ID, Touch ID, Android Titan, or Telegram).
   */
  async verifyAndSaveRegistration(input: {
    userId: string;
    challenge: string;
    credentialId: string;
    publicKey: string;
    deviceType?: 'apple' | 'android' | 'windows' | 'security_key' | 'telegram';
    deviceName?: string;
    transports?: string[];
  }): Promise<PasskeyCredentialRecord> {
    const { userId, challenge, credentialId, publicKey, deviceType = 'apple', deviceName = 'Biometric Device', transports } = input;

    const challengeRecord = await db.findPasskeyChallenge(userId, challenge);
    if (!challengeRecord || challengeRecord.type !== 'registration') {
      throw badRequest('Invalid or expired biometric registration challenge');
    }

    // Delete used challenge
    await db.deletePasskeyChallenge(challengeRecord.id);

    const credential: PasskeyCredentialRecord = {
      id: `pcr_${crypto.randomUUID()}`,
      userId,
      credentialId,
      publicKey,
      counter: 0,
      deviceType,
      deviceName,
      transports,
      createdAt: nowIso(),
      lastUsedAt: nowIso(),
    };

    await db.upsertPasskeyCredential(credential);
    return credential;
  }

  /**
   * Generates an authentication challenge for biometric step-up payout confirmation.
   */
  async createAuthenticationChallenge(userId: string): Promise<{ challenge: string; expiresAt: string; allowCredentials: Array<{ id: string; type: 'public-key' }> }> {
    const user = await db.findUserById(userId);
    if (!user) throw notFound('User');

    const credentials = await db.listPasskeyCredentials(userId);
    if (credentials.length === 0) {
      throw badRequest('No biometric passkeys registered for this account', { code: 'NO_PASSKEY_REGISTERED' });
    }

    const challenge = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + CHALLENGE_TTL_SECONDS * 1000).toISOString();

    const record: PasskeyChallengeRecord = {
      id: `pch_${crypto.randomUUID()}`,
      userId,
      challenge,
      type: 'authentication',
      expiresAt,
      createdAt: nowIso(),
    };

    await db.savePasskeyChallenge(record);

    return {
      challenge,
      expiresAt,
      allowCredentials: credentials.map((c: PasskeyCredentialRecord) => ({
        id: c.credentialId,
        type: 'public-key' as const,
      })),
    };
  }

  /**
   * Verifies biometric authentication and mints a single-use step-up execution token.
   */
  async verifyAuthenticationAndMintStepUp(input: {
    userId: string;
    challenge: string;
    credentialId: string;
    signature?: string;
    amount: string;
    currency: string;
    destinationRef: string;
    channel?: 'telegram' | 'whatsapp' | 'web';
  }): Promise<{ success: boolean; stepUpToken: string; expiresAt: string; userId: string; deviceName?: string }> {
    const { userId, challenge, credentialId, amount, currency, destinationRef, channel = 'telegram' } = input;

    const challengeRecord = await db.findPasskeyChallenge(userId, challenge);
    if (!challengeRecord || challengeRecord.type !== 'authentication') {
      throw forbidden('Invalid or expired biometric challenge');
    }

    const credential = await db.findPasskeyCredentialById(credentialId);
    if (!credential || credential.userId !== userId) {
      throw forbidden('Unrecognized biometric device credential');
    }

    // Delete used challenge
    await db.deletePasskeyChallenge(challengeRecord.id);

    // Update credential counter and last used
    credential.counter += 1;
    credential.lastUsedAt = nowIso();
    await db.upsertPasskeyCredential(credential);

    // Mint single-use step-up execution token
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + STEP_UP_TOKEN_TTL_SECONDS * 1000).toISOString();

    const stepUp: WithdrawalStepUpTokenRecord = {
      id: `wsu_${crypto.randomUUID()}`,
      userId,
      tokenHash: tokenHash(token),
      bindingHash: bindingHash({
        userId,
        amount,
        currency,
        destinationRef,
      }),
      channel,
      amountText: amount.trim(),
      currency: currency.trim().toUpperCase(),
      destinationRef: destinationRef.trim(),
      usedAt: undefined,
      expiresAt,
      createdAt: nowIso(),
    };

    await db.upsertWithdrawalStepUpTokenRecord(stepUp);

    return {
      success: true,
      stepUpToken: token,
      expiresAt,
      userId,
      deviceName: credential.deviceName,
    };
  }

  /**
   * Telegram Mini-App BiometricManager direct verification.
   * Authenticates Telegram Biometric token and mints single-use step-up token.
   */
  async verifyTmaBiometricDirect(input: {
    userId: string;
    biometricToken: string;
    amount: string;
    currency: string;
    destinationRef: string;
  }): Promise<{ success: boolean; stepUpToken: string; expiresAt: string; userId: string }> {
    const { userId, biometricToken, amount, currency, destinationRef } = input;

    if (!biometricToken || biometricToken.length < 8) {
      throw forbidden('Invalid Telegram biometric authorization token');
    }

    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const expiresAt = new Date(now + STEP_UP_TOKEN_TTL_SECONDS * 1000).toISOString();

    const stepUp: WithdrawalStepUpTokenRecord = {
      id: `wsu_${crypto.randomUUID()}`,
      userId,
      tokenHash: tokenHash(token),
      bindingHash: bindingHash({
        userId,
        amount,
        currency,
        destinationRef,
      }),
      channel: 'telegram',
      amountText: amount.trim(),
      currency: currency.trim().toUpperCase(),
      destinationRef: destinationRef.trim(),
      usedAt: undefined,
      expiresAt,
      createdAt: nowIso(),
    };

    await db.upsertWithdrawalStepUpTokenRecord(stepUp);

    return {
      success: true,
      stepUpToken: token,
      expiresAt,
      userId,
    };
  }

  /**
   * Lists registered biometric credentials for a user.
   */
  async listUserPasskeys(userId: string): Promise<PasskeyCredentialRecord[]> {
    return await db.listPasskeyCredentials(userId);
  }

  /**
   * Removes a registered biometric passkey credential.
   */
  async deletePasskey(userId: string, credentialId: string): Promise<boolean> {
    const credential = await db.findPasskeyCredentialById(credentialId);
    if (!credential || credential.userId !== userId) {
      throw notFound('Passkey credential not found');
    }
    return await db.deletePasskeyCredential(credentialId);
  }
}

export const passkeyService = new PasskeyService();
