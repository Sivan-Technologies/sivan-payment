import crypto from 'node:crypto';
import type pg from 'pg';
import { db } from '../database/json-database.js';
import { signUserJwt } from './jwt.js';
import { badRequest, notFound } from '../shared/errors.js';
import { lookupTelegramIdentity, lookupWhatsappIdentity } from '../identity/identity.service.js';

export interface WebAuthChallengeRecord {
  id: string;
  deviceInfo: string;
  ipAddress: string;
  location?: string;
  status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CONSUMED' | 'EXPIRED';
  userId?: string;
  authToken?: string;
  authUserData?: any;
  authorizedChannel?: 'telegram' | 'whatsapp';
  authorizedIdentifier?: string;
  createdAt: string;
  expiresAt: string;
  authorizedAt?: string;
  consumedAt?: string;
}

export class WebChallengeService {
  private getPool(): pg.Pool {
    const database: any = db;
    if (typeof database.getPool === 'function') {
      return database.getPool();
    }
    throw new Error('Postgres pool is not available on database instance');
  }

  /**
   * Creates a new single-use 5-minute Web Auth Challenge.
   */
  async createChallenge(input: {
    deviceInfo: string;
    ipAddress: string;
    location?: string;
  }): Promise<{
    challengeId: string;
    qrPayload: string;
    telegramUrl: string;
    whatsappUrl?: string;
    expiresAt: string;
  }> {
    const pool = this.getPool();
    const challengeId = `wch_${crypto.randomBytes(16).toString('hex')}`;
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    const client = await pool.connect();

    try {
      await client.query(
        `INSERT INTO web_auth_challenges (
          id, device_info, ip_address, location, status, expires_at
        ) VALUES ($1, $2, $3, $4, 'PENDING', $5)`,
        [
          challengeId,
          input.deviceInfo.slice(0, 255),
          input.ipAddress.slice(0, 64),
          input.location ? input.location.slice(0, 128) : null,
          expiresAt,
        ]
      );

      const telegramBotName = process.env.TELEGRAM_BOT_USERNAME || 'SivanAi_bot';
      const rawWhatsapp = (process.env.WHATSAPP_PHONE_NUMBER || process.env.WHATSAPP_NUMBER || process.env.META_PHONE_NUMBER || '').trim().replace(/\D/g, '');
      const whatsappNumber = rawWhatsapp || undefined;

      const telegramUrl = `https://t.me/${telegramBotName}?start=auth_${challengeId}`;
      const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=AUTH%20${challengeId}` : undefined;
      const frontendAppUrl = (process.env.FRONTEND_APP_URL || 'https://app.sivantech.online').replace(/\/+$/, '');
      const qrPayload = `${frontendAppUrl}/auth/confirm?c=${challengeId}`;

      return {
        challengeId,
        qrPayload,
        telegramUrl,
        whatsappUrl,
        expiresAt,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Retrieves challenge details for display in Telegram or WhatsApp before approving.
   */
  async getChallengeDetails(challengeId: string): Promise<{
    challengeId: string;
    deviceInfo: string;
    ipAddress: string;
    location?: string;
    status: string;
    expiresAt: string;
    telegramUrl: string;
    whatsappUrl?: string;
  } | null> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      const res = await client.query(
        `SELECT id, device_info, ip_address, location, status, expires_at 
         FROM web_auth_challenges WHERE id = $1 LIMIT 1`,
        [challengeId]
      );

      if (res.rowCount === 0) return null;
      const row = res.rows[0];

      const isExpired = new Date(row.expires_at).getTime() <= Date.now();
      if (isExpired && row.status === 'PENDING') {
        await client.query(`UPDATE web_auth_challenges SET status = 'EXPIRED' WHERE id = $1`, [challengeId]);
        row.status = 'EXPIRED';
      }

      const telegramBotName = process.env.TELEGRAM_BOT_USERNAME || 'SivanAi_bot';
      const rawWhatsapp = (process.env.WHATSAPP_PHONE_NUMBER || process.env.WHATSAPP_NUMBER || process.env.META_PHONE_NUMBER || '').trim().replace(/\D/g, '');
      const whatsappNumber = rawWhatsapp || undefined;

      const telegramUrl = `https://t.me/${telegramBotName}?start=auth_${challengeId}`;
      const whatsappUrl = whatsappNumber ? `https://wa.me/${whatsappNumber}?text=AUTH%20${challengeId}` : undefined;

      return {
        challengeId: row.id,
        deviceInfo: row.device_info,
        ipAddress: row.ip_address,
        location: row.location || undefined,
        status: row.status,
        expiresAt: row.expires_at,
        telegramUrl,
        whatsappUrl,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Authorizes or declines a challenge from Telegram or WhatsApp.
   */
  async authorizeChallenge(input: {
    challengeId: string;
    telegramUserId?: string;
    whatsappNumber?: string;
    action: 'APPROVE' | 'DECLINE';
  }): Promise<{ authorized: boolean; status: string; message: string }> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      const res = await client.query(
        `SELECT * FROM web_auth_challenges WHERE id = $1 FOR UPDATE`,
        [input.challengeId]
      );

      if (res.rowCount === 0) {
        throw notFound('Web challenge not found or expired.');
      }

      const row = res.rows[0];
      if (row.status !== 'PENDING') {
        throw badRequest(`Challenge is already ${row.status.toLowerCase()}.`);
      }

      if (new Date(row.expires_at).getTime() <= Date.now()) {
        await client.query(`UPDATE web_auth_challenges SET status = 'EXPIRED' WHERE id = $1`, [input.challengeId]);
        throw badRequest('Web challenge has expired. Please refresh the QR code on your browser.');
      }

      if (input.action === 'DECLINE') {
        await client.query(
          `UPDATE web_auth_challenges SET status = 'DECLINED' WHERE id = $1`,
          [input.challengeId]
        );
        return { authorized: false, status: 'DECLINED', message: 'Web login request declined.' };
      }

      // Action is APPROVE -> Resolve user
      let user: any = null;
      let channel: 'telegram' | 'whatsapp' = 'telegram';
      let identifier: string = '';

      if (input.telegramUserId) {
        channel = 'telegram';
        identifier = String(input.telegramUserId).trim();
        user = await db.findUserByTelegramUserId(identifier);
        if (!user) {
          const identity = await lookupTelegramIdentity(identifier);
          if (identity.linked && identity.paymentUserId) {
            user = await db.findUserById(identity.paymentUserId);
          }
        }
      } else if (input.whatsappNumber) {
        channel = 'whatsapp';
        identifier = String(input.whatsappNumber).trim();
        user = await db.findUserByWhatsappNumber(identifier);
        if (!user) {
          const identity = await lookupWhatsappIdentity(identifier);
          if (identity.linked && identity.paymentUserId) {
            user = await db.findUserById(identity.paymentUserId);
          }
        }
      } else {
        throw badRequest('Either telegramUserId or whatsappNumber must be provided.');
      }

      if (!user) {
        throw badRequest(`No Sivan account found for this ${channel} user. Please complete onboarding in chat first.`);
      }

      // Generate user JWT token
      const token = signUserJwt({
        userId: user.id,
        email: user.email,
        roles: ['user'],
      });

      const userData = {
        id: user.id,
        email: user.email,
        fullName: user.fullName || user.username || (channel === 'telegram' ? 'Telegram User' : 'WhatsApp User'),
        primaryChannel: user.primaryChannel || channel,
      };

      await client.query(
        `UPDATE web_auth_challenges SET 
          status = 'APPROVED',
          user_id = $1,
          auth_token = $2,
          auth_user_data = $3,
          authorized_channel = $4,
          authorized_identifier = $5,
          authorized_at = NOW()
        WHERE id = $6`,
        [
          user.id,
          token,
          JSON.stringify(userData),
          channel,
          identifier,
          input.challengeId,
        ]
      );

      return {
        authorized: true,
        status: 'APPROVED',
        message: 'Web login authorized successfully.',
      };
    } finally {
      client.release();
    }
  }

  /**
   * Browser polling endpoint. Returns JWT and user once approved, then marks as CONSUMED.
   */
  async pollChallenge(challengeId: string): Promise<{
    status: 'PENDING' | 'APPROVED' | 'DECLINED' | 'CONSUMED' | 'EXPIRED' | 'NOT_FOUND';
    token?: string;
    user?: any;
    expiresAt?: string;
  }> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      const res = await client.query(
        `SELECT * FROM web_auth_challenges WHERE id = $1 FOR UPDATE`,
        [challengeId]
      );

      if (res.rowCount === 0) {
        return { status: 'NOT_FOUND' };
      }

      const row = res.rows[0];

      if (row.status === 'PENDING') {
        if (new Date(row.expires_at).getTime() <= Date.now()) {
          await client.query(`UPDATE web_auth_challenges SET status = 'EXPIRED' WHERE id = $1`, [challengeId]);
          return { status: 'EXPIRED' };
        }
        return { status: 'PENDING', expiresAt: row.expires_at };
      }

      if (row.status === 'APPROVED') {
        // Immediately mark as CONSUMED so the token cannot be fetched again
        await client.query(
          `UPDATE web_auth_challenges SET status = 'CONSUMED', consumed_at = NOW() WHERE id = $1`,
          [challengeId]
        );

        return {
          status: 'APPROVED',
          token: row.auth_token,
          user: row.auth_user_data,
        };
      }

      return { status: row.status };
    } finally {
      client.release();
    }
  }
}

export const webChallengeService = new WebChallengeService();

