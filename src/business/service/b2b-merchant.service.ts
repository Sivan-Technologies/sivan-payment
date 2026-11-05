import crypto from 'node:crypto';
import type pg from 'pg';
import { db } from '../../database/json-database.js';
import { env } from '../../config/env.js';
import type {
  B2bMerchantRecord,
  B2bMerchantApiKeyRecord,
  B2bDispatchedFlowRecord,
} from '../../database/types.js';

export interface CreateMerchantInput {
  name: string;
  slug?: string;
  email: string;
  phone: string;
  webhookUrl?: string;
  customGreeting?: string;
  customButtonLabel?: string;
  customSuccessMessage?: string;
}

export interface DispatchFlowInput {
  customerPhone: string;
  customerName?: string;
  amountNgn: number;
  currency?: string;
  orderReference?: string;
  flowType?: string;
  greetingMessage?: string;
  buttonLabel?: string;
  successMessage?: string;
  metadata?: Record<string, any>;
}

export class B2bMerchantService {
  private getPool(): pg.Pool {
    const database: any = db;
    if (typeof database.getPool === 'function') {
      return database.getPool();
    }
    throw new Error('Postgres pool is not available on database instance');
  }

  /**
   * Generates a cryptographically secure random API key pair for a merchant.
   * Format:
   *   Secret Key: sk_live_<32 hex chars>
   *   Public Key: pk_live_<24 hex chars>
   *   Secret Hash: SHA-256(secretKey)
   */
  generateKeyPair(mode: 'live' | 'test' = 'live'): {
    secretKey: string;
    publicKey: string;
    secretHash: string;
    maskedKey: string;
    prefix: string;
  } {
    const prefix = mode === 'live' ? 'sk_live_' : 'sk_test_';
    const pubPrefix = mode === 'live' ? 'pk_live_' : 'pk_test_';
    const secretRandom = crypto.randomBytes(16).toString('hex');
    const secretKey = `${prefix}${secretRandom}`;
    const publicKey = `${pubPrefix}${crypto.randomBytes(12).toString('hex')}`;
    const secretHash = crypto.createHash('sha256').update(secretKey).digest('hex');
    const maskedKey = `${prefix}...${secretRandom.slice(-4)}`;

    return { secretKey, publicKey, secretHash, maskedKey, prefix };
  }

  /**
   * Registers a new B2B merchant and provisions their first live API key.
   */
  async createMerchant(input: CreateMerchantInput): Promise<{
    merchant: B2bMerchantRecord;
    secretKey: string;
    publicKey: string;
  }> {
    const pool = this.getPool();
    const slug = (input.slug || input.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || `merch-${Date.now()}`;

    const webhookSecret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const merchantRes = await client.query(
        `INSERT INTO b2b_merchants (
          name, slug, email, phone, status, webhook_url, webhook_secret,
          custom_greeting, custom_button_label, custom_success_message
        ) VALUES ($1, $2, $3, $4, 'ACTIVE', $5, $6, $7, $8, $9)
        RETURNING *`,
        [
          input.name,
          slug,
          input.email,
          input.phone,
          input.webhookUrl || null,
          webhookSecret,
          input.customGreeting || null,
          input.customButtonLabel || null,
          input.customSuccessMessage || null,
        ]
      );

      const m = merchantRes.rows[0];
      const merchant: B2bMerchantRecord = {
        id: m.id,
        name: m.name,
        slug: m.slug,
        email: m.email,
        phone: m.phone,
        status: m.status,
        webhookUrl: m.webhook_url,
        webhookSecret: m.webhook_secret,
        customGreeting: m.custom_greeting,
        customButtonLabel: m.custom_button_label,
        customSuccessMessage: m.custom_success_message,
        totalVolumeNgn: Number(m.total_volume_ngn),
        totalDealsCount: Number(m.total_deals_count),
        createdAt: m.created_at.toISOString(),
        updatedAt: m.updated_at.toISOString(),
      };

      const keyPair = this.generateKeyPair('live');
      await client.query(
        `INSERT INTO b2b_merchant_api_keys (
          merchant_id, key_prefix, public_key, secret_hash, masked_key, mode, status
        ) VALUES ($1, $2, $3, $4, $5, 'live', 'ACTIVE')`,
        [merchant.id, keyPair.prefix, keyPair.publicKey, keyPair.secretHash, keyPair.maskedKey]
      );

      await client.query('COMMIT');

      return {
        merchant,
        secretKey: keyPair.secretKey,
        publicKey: keyPair.publicKey,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Authenticates a merchant request via Bearer API Key.
   */
  async authenticateApiKey(authHeader?: string): Promise<{
    merchant: B2bMerchantRecord;
    apiKey: B2bMerchantApiKeyRecord;
  }> {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      throw new Error('Unauthorized: Missing or malformed Authorization header');
    }

    const token = authHeader.slice(7).trim();
    if (!token.startsWith('sk_live_') && !token.startsWith('sk_test_')) {
      throw new Error('Unauthorized: Invalid API key format');
    }

    const secretHash = crypto.createHash('sha256').update(token).digest('hex');
    const pool = this.getPool();

    const res = await pool.query(
      `SELECT k.*, m.name as m_name, m.slug as m_slug, m.email as m_email, m.phone as m_phone,
              m.status as m_status, m.webhook_url, m.webhook_secret, m.custom_greeting,
              m.custom_button_label, m.custom_success_message, m.total_volume_ngn, m.total_deals_count,
              m.created_at as m_created_at, m.updated_at as m_updated_at
       FROM b2b_merchant_api_keys k
       JOIN b2b_merchants m ON k.merchant_id = m.id
       WHERE k.secret_hash = $1 AND k.status = 'ACTIVE' AND m.status = 'ACTIVE'`,
      [secretHash]
    );

    if (res.rows.length === 0) {
      throw new Error('Unauthorized: Invalid or revoked API key');
    }

    const row = res.rows[0];

    // Asynchronously update last_used_at
    void pool.query('UPDATE b2b_merchant_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id]).catch(() => {});

    const merchant: B2bMerchantRecord = {
      id: row.merchant_id,
      name: row.m_name,
      slug: row.m_slug,
      email: row.m_email,
      phone: row.m_phone,
      status: row.m_status,
      webhookUrl: row.webhook_url,
      webhookSecret: row.webhook_secret,
      customGreeting: row.custom_greeting,
      customButtonLabel: row.custom_button_label,
      customSuccessMessage: row.custom_success_message,
      totalVolumeNgn: Number(row.total_volume_ngn),
      totalDealsCount: Number(row.total_deals_count),
      createdAt: row.m_created_at.toISOString(),
      updatedAt: row.m_updated_at.toISOString(),
    };

    const apiKey: B2bMerchantApiKeyRecord = {
      id: row.id,
      merchantId: row.merchant_id,
      keyPrefix: row.key_prefix,
      publicKey: row.public_key,
      secretHash: row.secret_hash,
      maskedKey: row.masked_key,
      mode: row.mode,
      status: row.status,
      lastUsedAt: row.last_used_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
    };

    return { merchant, apiKey };
  }

  /**
   * Dispatches an interactive WhatsApp Meta Flow or custom checkout on behalf of a merchant.
   */
  async dispatchFlow(
    merchant: B2bMerchantRecord,
    input: DispatchFlowInput
  ): Promise<{
    reference: string;
    status: string;
    customerPhone: string;
    amountNgn: number;
    metaMessageId?: string;
    checkoutUrl: string;
  }> {
    const pool = this.getPool();
    const cleanPhone = input.customerPhone.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Invalid customer phone number');
    }

    if (!input.amountNgn || input.amountNgn <= 0) {
      throw new Error('amountNgn must be a positive number');
    }

    const reference = input.orderReference || `ORD_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const greeting = input.greetingMessage || merchant.customGreeting || `Hello! Tap below to complete your order from ${merchant.name}:`;
    const buttonText = input.buttonLabel || merchant.customButtonLabel || `Pay ₦${input.amountNgn.toLocaleString('en-NG')}`;
    const successMsg = input.successMessage || merchant.customSuccessMessage || `Payment confirmed! Thank you for choosing ${merchant.name}.`;

    // Direct mobile checkout link
    const checkoutUrl = `https://app.sivantech.online/checkout/${reference}`;

    // Meta Cloud WhatsApp Dispatch
    let metaMessageId: string | undefined;
    const metaToken = process.env.META_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID || '1362997560228079';
    const apiVersion = process.env.META_GRAPH_API_VERSION || 'v25.0';

    if (metaToken && phoneNumberId) {
      try {
        const messageBody = [
          greeting,
          '',
          `Amount: ₦${input.amountNgn.toLocaleString('en-NG')}`,
          `Reference: ${reference}`,
          '',
          `Tap to complete payment securely:\n${checkoutUrl}`,
        ].join('\n');

        const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${metaToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'text',
            text: { body: messageBody },
          }),
        });

        if (metaRes.ok) {
          const body: any = await metaRes.json();
          metaMessageId = body?.messages?.[0]?.id;
        } else {
          console.warn('[b2b.dispatch] Meta WhatsApp dispatch status:', metaRes.status);
        }
      } catch (err: any) {
        console.warn('[b2b.dispatch] Meta WhatsApp dispatch failed (non-fatal):', err?.message || err);
      }
    }

    // Persist flow dispatch
    await pool.query(
      `INSERT INTO b2b_dispatched_flows (
        merchant_id, reference, customer_phone, customer_name, amount_ngn,
        currency, flow_type, status, meta_message_id, greeting_message,
        button_label, success_message, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11, $12)`,
      [
        merchant.id,
        reference,
        cleanPhone,
        input.customerName || null,
        input.amountNgn,
        input.currency || 'NGN',
        input.flowType || 'checkout',
        metaMessageId || null,
        greeting,
        buttonText,
        successMsg,
        JSON.stringify(input.metadata || {}),
      ]
    );

    return {
      reference,
      status: 'PENDING',
      customerPhone: cleanPhone,
      amountNgn: input.amountNgn,
      metaMessageId,
      checkoutUrl,
    };
  }

  /**
   * Retrieves a dispatched flow by its order reference.
   */
  async getFlowByReference(reference: string): Promise<B2bDispatchedFlowRecord | null> {
    const pool = this.getPool();
    const res = await pool.query('SELECT * FROM b2b_dispatched_flows WHERE reference = $1', [reference]);
    if (res.rows.length === 0) return null;

    const row = res.rows[0];
    return {
      id: row.id,
      merchantId: row.merchant_id,
      reference: row.reference,
      customerPhone: row.customer_phone,
      customerName: row.customer_name,
      amountNgn: Number(row.amount_ngn),
      currency: row.currency,
      flowType: row.flow_type,
      status: row.status,
      dedicatedAccountNumber: row.dedicated_account_number,
      dedicatedBankName: row.dedicated_bank_name,
      metaMessageId: row.meta_message_id,
      greetingMessage: row.greeting_message,
      buttonLabel: row.button_label,
      successMessage: row.success_message,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
      completedAt: row.completed_at?.toISOString(),
    };
  }

  /**
   * Marks a flow as completed and dispatches a signed webhook to the partner server.
   */
  async completeFlow(reference: string, paidAmountNgn: number): Promise<boolean> {
    const pool = this.getPool();
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const flowRes = await client.query(
        `UPDATE b2b_dispatched_flows
         SET status = 'COMPLETED', completed_at = NOW()
         WHERE reference = $1 AND status = 'PENDING'
         RETURNING *`,
        [reference]
      );

      if (flowRes.rows.length === 0) {
        await client.query('ROLLBACK');
        return false;
      }

      const flow = flowRes.rows[0];

      // Update merchant totals
      const merchRes = await client.query(
        `UPDATE b2b_merchants
         SET total_volume_ngn = total_volume_ngn + $1,
             total_deals_count = total_deals_count + 1,
             updated_at = NOW()
         WHERE id = $2
         RETURNING *`,
        [paidAmountNgn, flow.merchant_id]
      );

      await client.query('COMMIT');

      // Dispatch Webhook to merchant if configured
      const merchant = merchRes.rows[0];
      if (merchant?.webhook_url) {
        void this.dispatchWebhookToMerchant(merchant, flow, paidAmountNgn);
      }

      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Signs payload with HMAC-SHA256 and delivers to merchant webhook URL.
   */
  private async dispatchWebhookToMerchant(
    merchant: any,
    flow: any,
    paidAmountNgn: number
  ): Promise<void> {
    try {
      const payload = {
        event: 'payment.successful',
        reference: flow.reference,
        merchantId: merchant.id,
        amount: paidAmountNgn,
        currency: flow.currency || 'NGN',
        customerPhone: flow.customer_phone,
        customerName: flow.customer_name,
        metadata: flow.metadata,
        timestamp: new Date().toISOString(),
      };

      const payloadString = JSON.stringify(payload);
      const signature = crypto
        .createHmac('sha256', merchant.webhook_secret || 'default_secret')
        .update(payloadString)
        .digest('hex');

      await fetch(merchant.webhook_url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Sivan-Signature': signature,
          'User-Agent': 'Sivan-Webhook-Dispatcher/1.0',
        },
        body: payloadString,
        signal: AbortSignal.timeout(5000),
      });
    } catch (err: any) {
      console.warn('[b2b.webhook] Failed to dispatch webhook to merchant:', err?.message || err);
    }
  }
}

export const b2bMerchantService = new B2bMerchantService();

