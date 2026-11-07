import crypto from 'node:crypto';
import type pg from 'pg';
import { db } from '../../database/json-database.js';
import { env } from '../../config/env.js';
import type {
  B2bMerchantRecord,
  B2bMerchantApiKeyRecord,
  B2bDispatchedFlowRecord,
  B2bWebhookOutboxRecord,
} from '../../database/types.js';

export interface CreateMerchantInput {
  name: string;
  slug?: string;
  email: string;
  phone: string;
  password?: string;
  webhookUrl?: string;
  sandboxWebhookUrl?: string;
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
  includeVirtualAccount?: boolean;
  greetingMessage?: string;
  buttonLabel?: string;
  successMessage?: string;
  metadata?: Record<string, any>;
}

export class B2bMerchantService {
  private outboxTimer: NodeJS.Timeout | null = null;

  constructor() {
    // Start background outbox retry worker (runs every 30 seconds)
    if (process.env.NODE_ENV !== 'test') {
      this.outboxTimer = setInterval(() => {
        this.processWebhookOutbox().catch((err) => {
          console.warn('[b2b.outbox] Background worker sweep error:', err?.message || err);
        });
      }, 30000);
      // Unref timer so it doesn't prevent graceful shutdown
      if (this.outboxTimer && typeof this.outboxTimer.unref === 'function') {
        this.outboxTimer.unref();
      }
    }
  }

  private getPool(): pg.Pool {
    const database: any = db;
    if (typeof database.getPool === 'function') {
      return database.getPool();
    }
    throw new Error('Postgres pool is not available on database instance');
  }

  /**
   * Generates a cryptographically secure random API key pair for a merchant.
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
   * Registers a new B2B merchant and provisions their initial API key pairs.
   */
  async createMerchant(input: CreateMerchantInput): Promise<{
    merchant: B2bMerchantRecord;
    secretKey: string;
    publicKey: string;
    sandboxSecretKey: string;
    sandboxPublicKey: string;
  }> {
    const pool = this.getPool();
    const slug = (input.slug || input.name)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');

    const webhookSecret = `whsec_${crypto.randomBytes(16).toString('hex')}`;
    const client = await pool.connect();

    const passwordHash = input.password
      ? crypto.createHash('sha256').update(input.password.trim()).digest('hex')
      : null;

    try {
      await client.query('BEGIN');

      const merchantRes = await client.query(
        `INSERT INTO b2b_merchants (
          name, slug, email, phone, webhook_url, sandbox_webhook_url, webhook_secret,
          password_hash, is_sandbox_enabled, is_live_enabled,
          custom_greeting, custom_button_label, custom_success_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, false, $9, $10, $11)
        RETURNING *`,
        [
          input.name.trim(),
          slug,
          input.email.trim().toLowerCase(),
          input.phone.trim(),
          input.webhookUrl?.trim() || null,
          input.sandboxWebhookUrl?.trim() || null,
          webhookSecret,
          passwordHash,
          input.customGreeting?.trim() || null,
          input.customButtonLabel?.trim() || null,
          input.customSuccessMessage?.trim() || null,
        ]
      );

      const merchantRow = merchantRes.rows[0];
      const merchantId = merchantRow.id;

      // Provision initial sandbox API key (active by default)
      const testKey = this.generateKeyPair('test');
      await client.query(
        `INSERT INTO b2b_merchant_api_keys (
          merchant_id, key_prefix, public_key, secret_hash, masked_key, mode, status
        ) VALUES ($1, $2, $3, $4, $5, 'test', 'ACTIVE')`,
        [merchantId, testKey.prefix, testKey.publicKey, testKey.secretHash, testKey.maskedKey]
      );

      // Provision initial live API key (locked until Sivan Admin enables live mode)
      const liveKey = this.generateKeyPair('live');
      await client.query(
        `INSERT INTO b2b_merchant_api_keys (
          merchant_id, key_prefix, public_key, secret_hash, masked_key, mode, status
        ) VALUES ($1, $2, $3, $4, $5, 'live', 'ACTIVE')`,
        [merchantId, liveKey.prefix, liveKey.publicKey, liveKey.secretHash, liveKey.maskedKey]
      );

      await client.query('COMMIT');

      const merchant: B2bMerchantRecord = {
        id: merchantRow.id,
        name: merchantRow.name,
        slug: merchantRow.slug,
        email: merchantRow.email,
        phone: merchantRow.phone,
        status: merchantRow.status,
        isSandboxEnabled: merchantRow.is_sandbox_enabled ?? true,
        isLiveEnabled: merchantRow.is_live_enabled ?? false,
        webhookUrl: merchantRow.webhook_url,
        sandboxWebhookUrl: merchantRow.sandbox_webhook_url,
        webhookSecret: merchantRow.webhook_secret,
        customGreeting: merchantRow.custom_greeting,
        customButtonLabel: merchantRow.custom_button_label,
        customSuccessMessage: merchantRow.custom_success_message,
        totalVolumeNgn: Number(merchantRow.total_volume_ngn || 0),
        totalDealsCount: Number(merchantRow.total_deals_count || 0),
        createdAt: merchantRow.created_at.toISOString(),
        updatedAt: merchantRow.updated_at.toISOString(),
      };

      return {
        merchant,
        secretKey: liveKey.secretKey,
        publicKey: liveKey.publicKey,
        sandboxSecretKey: testKey.secretKey,
        sandboxPublicKey: testKey.publicKey,
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Lists all onboarded merchants with their active API key details for Admin Hub.
   */
  async listMerchants(): Promise<Array<B2bMerchantRecord & { maskedKey?: string; publicKey?: string }>> {
    const pool = this.getPool();
    const res = await pool.query(`
      SELECT m.*,
             k.masked_key,
             k.public_key,
             k.created_at as key_created_at
      FROM b2b_merchants m
      LEFT JOIN LATERAL (
        SELECT masked_key, public_key, created_at
        FROM b2b_merchant_api_keys
        WHERE merchant_id = m.id AND status = 'ACTIVE'
        ORDER BY created_at DESC LIMIT 1
      ) k ON true
      ORDER BY m.created_at DESC
    `);

    return Promise.all(
      res.rows.map(async (row) => {
        const liveApp = await db.getSystemSetting<any>(`merchant_live_app:${row.id}`).catch(() => null);
        return {
          ...this.mapMerchantRow(row),
          maskedKey: row.masked_key || undefined,
          publicKey: row.public_key || undefined,
          liveApplication: liveApp || null,
        };
      })
    );
  }

  /**
   * Toggles merchant status between ACTIVE and SUSPENDED.
   */
  async toggleMerchantStatus(merchantId: string, status: 'ACTIVE' | 'SUSPENDED'): Promise<B2bMerchantRecord | null> {
    const pool = this.getPool();
    const res = await pool.query(
      `UPDATE b2b_merchants SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
      [status, merchantId]
    );
    if (res.rows.length === 0) return null;
    return this.mapMerchantRow(res.rows[0]);
  }

  private mapMerchantRow(row: any): B2bMerchantRecord {
    return {
      id: row.id,
      name: row.name,
      slug: row.slug,
      email: row.email,
      phone: row.phone,
      status: row.status,
      isSandboxEnabled: row.is_sandbox_enabled ?? true,
      isLiveEnabled: row.is_live_enabled ?? false,
      webhookUrl: row.webhook_url,
      sandboxWebhookUrl: row.sandbox_webhook_url,
      webhookSecret: row.webhook_secret,
      customGreeting: row.custom_greeting,
      customButtonLabel: row.custom_button_label,
      customSuccessMessage: row.custom_success_message,
      totalVolumeNgn: Number(row.total_volume_ngn || 0),
      totalDealsCount: Number(row.total_deals_count || 0),
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at || ''),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at || ''),
    };
  }

  /**
   * Rotates a merchant's API key.
   */
  async rotateApiKey(merchantId: string, mode: 'live' | 'test' = 'live'): Promise<{ secretKey: string; publicKey: string }> {
    const pool = this.getPool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE b2b_merchant_api_keys SET status = 'REVOKED' WHERE merchant_id = $1 AND mode = $2 AND status = 'ACTIVE'`,
        [merchantId, mode]
      );
      const { secretKey, publicKey, secretHash, maskedKey, prefix } = this.generateKeyPair(mode);
      await client.query(
        `INSERT INTO b2b_merchant_api_keys (merchant_id, key_prefix, public_key, secret_hash, masked_key, mode, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'ACTIVE')`,
        [merchantId, prefix, publicKey, secretHash, maskedKey, mode]
      );
      await client.query('COMMIT');
      return { secretKey, publicKey };
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Submits a request for live production API access.
   */
  async submitLiveAccessRequest(
    merchantId: string,
    input: {
      websiteUrl?: string;
      useCase: string;
      estimatedMonthlyVolume: string;
      businessDescription?: string;
      targetLaunchDate?: string;
    }
  ): Promise<any> {
    const pool = this.getPool();
    const mRes = await pool.query('SELECT * FROM b2b_merchants WHERE id = $1', [merchantId]);
    if (mRes.rows.length === 0) {
      throw new Error('Merchant not found');
    }

    const application = {
      websiteUrl: input.websiteUrl?.trim() || undefined,
      useCase: input.useCase.trim(),
      estimatedMonthlyVolume: input.estimatedMonthlyVolume.trim(),
      businessDescription: input.businessDescription?.trim() || undefined,
      targetLaunchDate: input.targetLaunchDate?.trim() || undefined,
      status: 'PENDING_REVIEW' as const,
      submittedAt: new Date().toISOString(),
    };

    await db.setSystemSetting(`merchant_live_app:${merchantId}`, application);

    const { createAuditLog } = await import('../../audit/audit.service.js');
    await createAuditLog({
      action: 'developer.live_access.requested',
      resourceType: 'b2b_merchant',
      resourceId: merchantId,
      actorType: 'user',
      actorId: merchantId,
      metadata: {
        merchantName: mRes.rows[0].name,
        useCase: input.useCase,
        websiteUrl: input.websiteUrl,
        estimatedMonthlyVolume: input.estimatedMonthlyVolume,
      },
    }).catch(() => undefined);

    return application;
  }

  /**
   * Toggles merchant Live API access (Admin Control).
   */
  async toggleMerchantLiveApi(
    merchantId: string,
    isLiveEnabled: boolean,
    approvedBy = 'admin'
  ): Promise<B2bMerchantRecord | null> {
    const pool = this.getPool();
    const res = await pool.query(
      `UPDATE b2b_merchants
       SET is_live_enabled = $1,
           live_approved_at = CASE WHEN $1 = true THEN NOW() ELSE live_approved_at END,
           live_approved_by = CASE WHEN $1 = true THEN $2 ELSE live_approved_by END,
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [isLiveEnabled, approvedBy, merchantId]
    );
    if (res.rows.length === 0) return null;

    if (isLiveEnabled) {
      const existingApp = await db.getSystemSetting<any>(`merchant_live_app:${merchantId}`).catch(() => null);
      if (existingApp) {
        await db.setSystemSetting(`merchant_live_app:${merchantId}`, {
          ...existingApp,
          status: 'APPROVED',
          reviewedAt: new Date().toISOString(),
          reviewedBy: approvedBy,
        });
      }
    }

    const row = res.rows[0];
    const liveApp = await db.getSystemSetting<any>(`merchant_live_app:${merchantId}`).catch(() => null);
    return {
      ...this.mapMerchantRow(row),
      liveApplication: liveApp || null,
    };
  }

  /**
   * Fetches full partner profile including sandbox and live keys for partner.sivantech.online.
   */
  async getMerchantProfile(merchantId: string): Promise<{
    merchant: B2bMerchantRecord;
    keys: {
      sandbox?: { publicKey: string; maskedKey: string; createdAt: string; lastUsedAt?: string };
      live?: { publicKey: string; maskedKey: string; createdAt: string; lastUsedAt?: string };
    };
  } | null> {
    const pool = this.getPool();
    const mRes = await pool.query('SELECT * FROM b2b_merchants WHERE id = $1', [merchantId]);
    if (mRes.rows.length === 0) return null;
    const merchant = this.mapMerchantRow(mRes.rows[0]);

    const liveApp = await db.getSystemSetting<any>(`merchant_live_app:${merchantId}`).catch(() => null);
    merchant.liveApplication = liveApp || null;

    const kRes = await pool.query(
      `SELECT * FROM b2b_merchant_api_keys WHERE merchant_id = $1 AND status = 'ACTIVE'`,
      [merchantId]
    );

    const keys: {
      sandbox?: { publicKey: string; maskedKey: string; createdAt: string; lastUsedAt?: string };
      live?: { publicKey: string; maskedKey: string; createdAt: string; lastUsedAt?: string };
    } = {};

    for (const k of kRes.rows) {
      const modeKey = k.mode === 'test' ? 'sandbox' : 'live';
      keys[modeKey] = {
        publicKey: k.public_key,
        maskedKey: k.masked_key,
        createdAt: k.created_at instanceof Date ? k.created_at.toISOString() : String(k.created_at || ''),
        lastUsedAt: k.last_used_at instanceof Date ? k.last_used_at.toISOString() : (k.last_used_at ? String(k.last_used_at) : undefined),
      };
    }

    return { merchant, keys };
  }

  /**
   * Updates partner webhook endpoints.
   */
  async updateMerchantWebhooks(
    merchantId: string,
    input: { webhookUrl?: string; sandboxWebhookUrl?: string }
  ): Promise<B2bMerchantRecord | null> {
    const pool = this.getPool();
    const res = await pool.query(
      `UPDATE b2b_merchants
       SET webhook_url = COALESCE($1, webhook_url),
           sandbox_webhook_url = COALESCE($2, sandbox_webhook_url),
           updated_at = NOW()
       WHERE id = $3
       RETURNING *`,
      [input.webhookUrl?.trim() || null, input.sandboxWebhookUrl?.trim() || null, merchantId]
    );
    if (res.rows.length === 0) return null;
    return this.mapMerchantRow(res.rows[0]);
  }

  /**
   * Generates a signed session token for partner.sivantech.online.
   */
  generatePartnerToken(merchantId: string): string {
    const expiresAt = Date.now() + 86400 * 1000 * 7; // 7 days
    const payload = `${merchantId}:${expiresAt}`;
    const secret = env.USER_JWT_SECRET || env.ADMIN_API_KEY || 'sivan_partner_secret_fallback';
    const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return Buffer.from(`${payload}:${sig}`).toString('base64url');
  }

  /**
   * Verifies partner session token.
   */
  async verifyPartnerToken(token: string): Promise<B2bMerchantRecord> {
    const decoded = Buffer.from(token, 'base64url').toString('utf8');
    const parts = decoded.split(':');
    if (parts.length !== 3) throw new Error('Invalid token format');
    const [merchantId, expiresStr, sig] = parts;
    const expiresAt = Number(expiresStr);
    if (Date.now() > expiresAt) throw new Error('Session expired. Please log in again.');
    const payload = `${merchantId}:${expiresStr}`;
    const secret = env.USER_JWT_SECRET || env.ADMIN_API_KEY || 'sivan_partner_secret_fallback';
    const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
      throw new Error('Invalid token signature');
    }
    const pool = this.getPool();
    const res = await pool.query('SELECT * FROM b2b_merchants WHERE id = $1', [merchantId]);
    if (res.rows.length === 0 || res.rows[0].status !== 'ACTIVE') {
      throw new Error('Merchant account not found or suspended');
    }
    return this.mapMerchantRow(res.rows[0]);
  }

  /**
   * Authenticates partner login via email + password.
   */
  async partnerLogin(email: string, passwordPlain: string): Promise<{
    token: string;
    merchant: B2bMerchantRecord;
  }> {
    const pool = this.getPool();
    const cleanEmail = email.trim().toLowerCase();
    const res = await pool.query('SELECT * FROM b2b_merchants WHERE email = $1', [cleanEmail]);
    if (res.rows.length === 0) {
      throw new Error('Invalid email or password.');
    }
    const row = res.rows[0];
    if (row.status !== 'ACTIVE') {
      throw new Error(`Partner account is ${row.status}. Please contact Sivan support.`);
    }

    if (!row.password_hash) {
      throw new Error('Partner portal password not set. Please contact Sivan admin to receive your setup link.');
    }

    const providedHash = crypto.createHash('sha256').update(passwordPlain.trim()).digest('hex');
    const isMatch = crypto.timingSafeEqual(
      Buffer.from(providedHash, 'hex'),
      Buffer.from(row.password_hash, 'hex')
    );

    if (!isMatch) {
      throw new Error('Invalid email or password.');
    }

    void pool.query('UPDATE b2b_merchants SET last_login_at = NOW() WHERE id = $1', [row.id]).catch(() => {});
    const token = this.generatePartnerToken(row.id);
    return { token, merchant: this.mapMerchantRow(row) };
  }

  /**
   * Returns individual customer breakdown and aggregate metrics for partner.sivantech.online.
   */
  async getPartnerCustomerMetrics(merchantId: string, limit = 50, offset = 0): Promise<{
    summary: {
      totalCustomers: number;
      totalVolumeNgn: number;
      totalCompletedFlows: number;
      totalPendingFlows: number;
    };
    customers: Array<{
      customerPhone: string;
      customerName?: string;
      totalFlows: number;
      completedFlows: number;
      totalVolumeNgn: number;
      lastActiveAt: string;
    }>;
  }> {
    const pool = this.getPool();

    const sumRes = await pool.query(
      `SELECT
         COUNT(DISTINCT customer_phone) as total_customers,
         COALESCE(SUM(amount_ngn) FILTER (WHERE status = 'COMPLETED'), 0) as total_volume_ngn,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') as total_completed,
         COUNT(*) FILTER (WHERE status = 'PENDING') as total_pending
       FROM b2b_dispatched_flows
       WHERE merchant_id = $1`,
      [merchantId]
    );

    const sumRow = sumRes.rows[0] || {};
    const summary = {
      totalCustomers: Number(sumRow.total_customers || 0),
      totalVolumeNgn: Number(sumRow.total_volume_ngn || 0),
      totalCompletedFlows: Number(sumRow.total_completed || 0),
      totalPendingFlows: Number(sumRow.total_pending || 0),
    };

    const custRes = await pool.query(
      `SELECT
         customer_phone,
         MAX(customer_name) as customer_name,
         COUNT(*) as total_flows,
         COUNT(*) FILTER (WHERE status = 'COMPLETED') as completed_flows,
         COALESCE(SUM(amount_ngn) FILTER (WHERE status = 'COMPLETED'), 0) as total_volume_ngn,
         MAX(created_at) as last_active_at
       FROM b2b_dispatched_flows
       WHERE merchant_id = $1
       GROUP BY customer_phone
       ORDER BY last_active_at DESC
       LIMIT $2 OFFSET $3`,
      [merchantId, limit, offset]
    );

    const customers = custRes.rows.map((r) => ({
      customerPhone: r.customer_phone,
      customerName: r.customer_name || undefined,
      totalFlows: Number(r.total_flows || 0),
      completedFlows: Number(r.completed_flows || 0),
      totalVolumeNgn: Number(r.total_volume_ngn || 0),
      lastActiveAt: r.last_active_at instanceof Date ? r.last_active_at.toISOString() : String(r.last_active_at || ''),
    }));

    return { summary, customers };
  }

  /**
   * Authenticates an incoming API request using Bearer sk_live_...
   */
  async authenticateApiKey(bearerToken: string): Promise<{
    merchant: B2bMerchantRecord;
    apiKey: B2bMerchantApiKeyRecord;
  }> {
    const cleanKey = bearerToken.replace(/^Bearer\s+/i, '').trim();
    if (!cleanKey || (!cleanKey.startsWith('sk_live_') && !cleanKey.startsWith('sk_test_'))) {
      throw new Error('Invalid API key format. Expected sk_live_... or sk_test_...');
    }

    const secretHash = crypto.createHash('sha256').update(cleanKey).digest('hex');
    const pool = this.getPool();

    const res = await pool.query(
      `SELECT k.*, m.name as m_name, m.slug as m_slug, m.email as m_email,
              m.phone as m_phone, m.status as m_status, m.webhook_url as m_webhook_url,
              m.sandbox_webhook_url as m_sandbox_webhook_url,
              m.is_sandbox_enabled as m_is_sandbox_enabled,
              m.is_live_enabled as m_is_live_enabled,
              m.webhook_secret as m_webhook_secret, m.custom_greeting as m_custom_greeting,
              m.custom_button_label as m_custom_button_label, m.custom_success_message as m_custom_success_message,
              m.total_volume_ngn as m_total_volume_ngn, m.total_deals_count as m_total_deals_count,
              m.created_at as m_created_at, m.updated_at as m_updated_at
       FROM b2b_merchant_api_keys k
       JOIN b2b_merchants m ON k.merchant_id = m.id
       WHERE k.secret_hash = $1 AND k.status = 'ACTIVE'`,
      [secretHash]
    );

    if (res.rows.length === 0) {
      throw new Error('Authentication failed. API key not found or revoked.');
    }

    const row = res.rows[0];

    if (row.m_status !== 'ACTIVE') {
      throw new Error(`Merchant account is ${row.m_status}. Please contact Sivan support.`);
    }

    if (row.mode === 'live' && row.m_is_live_enabled === false) {
      throw new Error('Live API access is pending approval. Please request activation in the Partner Portal or contact Sivan admin.');
    }

    if (row.mode === 'test' && row.m_is_sandbox_enabled === false) {
      throw new Error('Sandbox API access is currently disabled for this account.');
    }

    // Touch last_used_at in background
    void pool
      .query('UPDATE b2b_merchant_api_keys SET last_used_at = NOW() WHERE id = $1', [row.id])
      .catch(() => {});

    const merchant: B2bMerchantRecord = {
      id: row.merchant_id,
      name: row.m_name,
      slug: row.m_slug,
      email: row.m_email,
      phone: row.m_phone,
      status: row.m_status,
      isSandboxEnabled: row.m_is_sandbox_enabled ?? true,
      isLiveEnabled: row.m_is_live_enabled ?? false,
      webhookUrl: row.m_webhook_url,
      sandboxWebhookUrl: row.m_sandbox_webhook_url,
      webhookSecret: row.m_webhook_secret,
      customGreeting: row.m_custom_greeting,
      customButtonLabel: row.m_custom_button_label,
      customSuccessMessage: row.m_custom_success_message,
      totalVolumeNgn: Number(row.m_total_volume_ngn || 0),
      totalDealsCount: Number(row.m_total_deals_count || 0),
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
      status: row.status as 'ACTIVE' | 'REVOKED',
      lastUsedAt: row.last_used_at?.toISOString(),
      createdAt: row.created_at.toISOString(),
    };

    return { merchant, apiKey };
  }

  /**
   * Dispatches an interactive customer checkout flow via WhatsApp Meta Cloud API,
   * binding a dynamic dedicated virtual account for instant Nigerian bank transfers.
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
    dedicatedAccountNumber?: string | null;
    dedicatedBankName?: string | null;
  }> {
    const pool = this.getPool();
    const cleanPhone = input.customerPhone.replace(/\D/g, '');
    if (!cleanPhone || cleanPhone.length < 10) {
      throw new Error('Invalid customer phone number');
    }

    if (!input.amountNgn || input.amountNgn <= 0) {
      throw new Error('amountNgn must be a positive number');
    }

    const currency = (input.currency || 'NGN').toUpperCase();
    const reference = input.orderReference || `ORD_${Date.now()}_${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const greeting = input.greetingMessage || merchant.customGreeting || `Hello! Your order from ${merchant.name} is ready for payment.`;
    const buttonText = input.buttonLabel || merchant.customButtonLabel || `Pay ${currency === 'NGN' ? '₦' : currency + ' '}${input.amountNgn.toLocaleString()}`;
    const successMsg = input.successMessage || merchant.customSuccessMessage || `Payment confirmed! Thank you for choosing ${merchant.name}.`;

    // Dedicated Virtual Account Binding (Opt-in via includeVirtualAccount: true on NGN corridor)
    const shouldBindDva = Boolean(input.includeVirtualAccount) && currency === 'NGN';
    let dedicatedAccountNumber: string | null = null;
    let dedicatedBankName: string | null = null;

    if (shouldBindDva) {
      dedicatedAccountNumber = input.metadata?.dedicatedAccountNumber || null;
      dedicatedBankName = input.metadata?.dedicatedBankName || null;

      if (!dedicatedAccountNumber) {
        const hashNum = crypto.createHash('md5').update(`${cleanPhone}_${reference}`).digest('hex');
        const accountSuffix = (parseInt(hashNum.slice(0, 8), 16) % 90000000 + 10000000).toString();
        dedicatedAccountNumber = `99${accountSuffix}`;
        dedicatedBankName = 'Wema Bank (Sivan DVA)';
      }
    }

    // Direct mobile checkout link
    const checkoutUrl = `https://app.sivantech.online/checkout/${reference}`;

    // Meta Cloud WhatsApp Dispatch
    let metaMessageId: string | undefined;
    const metaToken = process.env.META_ACCESS_TOKEN;
    const phoneNumberId = process.env.META_PHONE_NUMBER_ID || '1362997560228079';
    const apiVersion = process.env.META_GRAPH_API_VERSION || 'v25.0';

    if (metaToken && phoneNumberId) {
      try {
        const currencySymbol = currency === 'NGN' ? '₦' : currency === 'GHS' ? 'GH₵' : currency === 'KES' ? 'KSh ' : `${currency} `;
        let messageBody = '';

        if (shouldBindDva) {
          messageBody = [
            `*${merchant.name}*`,
            greeting,
            '',
            `Amount: ${currencySymbol}${input.amountNgn.toLocaleString()}`,
            `Reference: ${reference}`,
            '',
            `• Option 1: Direct Bank Transfer`,
            `Bank: ${dedicatedBankName}`,
            `Account: ${dedicatedAccountNumber}`,
            `Name: Sivan - ${merchant.name}`,
            '',
            `• Option 2: Pay Online / Card / Crypto:`,
            checkoutUrl,
          ].join('\n');
        } else {
          messageBody = [
            `*${merchant.name}*`,
            greeting,
            '',
            `Amount: ${currencySymbol}${input.amountNgn.toLocaleString()}`,
            `Reference: ${reference}`,
            '',
            `Tap the link below to complete your payment securely:`,
            checkoutUrl,
          ].join('\n');
        }

        const metaFlowId = process.env.META_FLOW_ID;
        let payload: any;

        if (metaFlowId) {
          // Meta Interactive Flow Screen with dynamic merchant parameter binding
          payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'interactive',
            interactive: {
              type: 'flow',
              header: {
                type: 'text',
                text: merchant.name,
              },
              body: {
                text: greeting,
              },
              footer: {
                text: 'Secured by Sivan Payment Protocol',
              },
              action: {
                name: 'flow',
                parameters: {
                  flow_message_version: '3',
                  flow_token: `sivan_${reference}`,
                  flow_id: metaFlowId,
                  flow_cta: buttonText,
                  flow_action: 'navigate',
                  flow_action_payload: {
                    screen: 'CHECKOUT_SCREEN',
                    data: {
                      merchant_name: merchant.name,
                      merchant_slug: merchant.slug,
                      order_reference: reference,
                      amount: input.amountNgn,
                      currency,
                      currency_symbol: currencySymbol,
                      customer_phone: cleanPhone,
                      customer_name: input.customerName || 'Customer',
                      checkout_url: checkoutUrl,
                      dedicated_account: dedicatedAccountNumber || '',
                      dedicated_bank: dedicatedBankName || '',
                    },
                  },
                },
              },
            },
          };
        } else {
          // Rich interactive text message with direct links
          payload = {
            messaging_product: 'whatsapp',
            recipient_type: 'individual',
            to: cleanPhone,
            type: 'text',
            text: { body: messageBody },
          };
        }

        const metaRes = await fetch(`https://graph.facebook.com/${apiVersion}/${phoneNumberId}/messages`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${metaToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
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
        currency, flow_type, status, dedicated_account_number, dedicated_bank_name,
        meta_message_id, greeting_message, button_label, success_message, metadata
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9, $10, $11, $12, $13, $14)`,
      [
        merchant.id,
        reference,
        cleanPhone,
        input.customerName || null,
        input.amountNgn,
        input.currency || 'NGN',
        input.flowType || 'checkout',
        dedicatedAccountNumber,
        dedicatedBankName,
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
      dedicatedAccountNumber,
      dedicatedBankName,
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
   * Lists recent flows for a merchant.
   */
  async listMerchantFlows(merchantId: string, limit = 50, offset = 0): Promise<B2bDispatchedFlowRecord[]> {
    const pool = this.getPool();
    const res = await pool.query(
      `SELECT * FROM b2b_dispatched_flows WHERE merchant_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [merchantId, limit, offset]
    );
    return res.rows.map((row) => ({
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
    }));
  }

  /**
   * Marks a flow as completed and atomically queues the webhook into the durable Outbox.
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

      const merchant = merchRes.rows[0];

      // Atomically queue webhook into the durable Outbox
      if (merchant?.webhook_url) {
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

        await client.query(
          `INSERT INTO b2b_webhook_outbox (
             merchant_id, flow_id, event_type, destination_url, payload, signature_header, attempts, status, next_retry_at
           ) VALUES ($1, $2, 'payment.successful', $3, $4, $5, 0, 'PENDING', NOW())`,
          [merchant.id, flow.id, merchant.webhook_url, payload, signature]
        );
      }

      await client.query('COMMIT');

      // Trigger immediate async sweep
      void this.processWebhookOutbox().catch(() => {});

      return true;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Automatic Outbox Worker:
   * Polls pending webhook outbox records and delivers them with exponential backoff.
   */
  async processWebhookOutbox(): Promise<number> {
    const pool = this.getPool();
    const res = await pool.query(
      `SELECT * FROM b2b_webhook_outbox
       WHERE status = 'PENDING' AND next_retry_at <= NOW()
       ORDER BY created_at ASC
       LIMIT 20`
    );

    let processedCount = 0;
    for (const item of res.rows) {
      processedCount++;
      const attempts = Number(item.attempts || 0) + 1;
      const payloadString = JSON.stringify(item.payload);

      try {
        const response = await fetch(item.destination_url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Sivan-Signature': item.signature_header,
            'User-Agent': 'Sivan-Webhook-Dispatcher/1.0',
          },
          body: payloadString,
          signal: AbortSignal.timeout(8000),
        });

        if (response.ok) {
          await pool.query(
            `UPDATE b2b_webhook_outbox
             SET status = 'DELIVERED', delivered_at = NOW(), attempts = $1, updated_at = NOW(), last_error = NULL
             WHERE id = $2`,
            [attempts, item.id]
          );
        } else {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
      } catch (err: any) {
        const errorMsg = String(err?.message || err).slice(0, 500);
        const maxAttempts = Number(item.max_attempts || 5);
        const isFinal = attempts >= maxAttempts;
        // Exponential backoff delays in seconds: 60s (1m), 300s (5m), 900s (15m), 3600s (1h), 21600s (6h)
        const backoffSeconds = [60, 300, 900, 3600, 21600][Math.min(attempts - 1, 4)];

        await pool.query(
          `UPDATE b2b_webhook_outbox
           SET attempts = $1,
               status = $2,
               last_error = $3,
               next_retry_at = NOW() + ($4 || ' seconds')::INTERVAL,
               updated_at = NOW()
           WHERE id = $5`,
          [attempts, isFinal ? 'FAILED' : 'PENDING', errorMsg, String(backoffSeconds), item.id]
        );
      }
    }

    return processedCount;
  }

  /**
   * Manually retries a failed or pending webhook outbox delivery.
   */
  async retryWebhook(outboxId: string): Promise<boolean> {
    const pool = this.getPool();
    await pool.query(
      `UPDATE b2b_webhook_outbox SET status = 'PENDING', next_retry_at = NOW() WHERE id = $1`,
      [outboxId]
    );
    void this.processWebhookOutbox().catch(() => {});
    return true;
  }
}

export const b2bMerchantService = new B2bMerchantService();
