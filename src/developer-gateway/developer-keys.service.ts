import crypto from 'node:crypto';
import type pg from 'pg';
import { db } from '../database/json-database.js';
import type { DeveloperApiKeyRecord, DeveloperUsageLogRecord } from '../database/types.js';

export interface IssueDeveloperKeyInput {
  developerName: string;
  email: string;
  organization?: string;
  environment?: 'sandbox' | 'live';
  permittedEndpoints?: string[];
  monthlyLimit?: number;
  expiryDate?: string;
  createdBy?: string;
  webhookUrl?: string;
}

export interface DeveloperAnalyticsSummary {
  totalKeys: number;
  activeKeys: number;
  revokedKeys: number;
  totalRequestsLifetime: number;
  totalRequestsMonth: number;
  avgLatencyMs: number;
  errorRatePercent: number;
  topEndpoints: { endpoint: string; count: number }[];
  recentLogs: DeveloperUsageLogRecord[];
}

export class DeveloperKeysService {
  private static instance: DeveloperKeysService;
  private keyCache = new Map<string, DeveloperApiKeyRecord>();
  private cacheExpiry = new Map<string, number>();
  private CACHE_TTL_MS = 60_000; // 1 minute in-memory cache

  static getInstance(): DeveloperKeysService {
    if (!DeveloperKeysService.instance) {
      DeveloperKeysService.instance = new DeveloperKeysService();
    }
    return DeveloperKeysService.instance;
  }

  private getPool(): pg.Pool | null {
    const database: any = db;
    if (typeof database.getPool === 'function') {
      try {
        return database.getPool();
      } catch {
        return null;
      }
    }
    return null;
  }

  private hashSecretKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
  }

  /**
   * Generates and registers a new developer API key.
   * Returns the plaintext key once only.
   */
  async issueKey(input: IssueDeveloperKeyInput): Promise<{ record: DeveloperApiKeyRecord; secretKey: string }> {
    const env = input.environment === 'sandbox' ? 'sandbox' : 'live';
    const prefixStr = env === 'sandbox' ? 'sk_test_sivan_' : 'sk_live_sivan_';
    const randomBytes = crypto.randomBytes(24).toString('hex');
    const secretKey = `${prefixStr}${randomBytes}`;
    const keyPrefix = secretKey.slice(0, 20); // e.g. "sk_live_sivan_a1b2c3"
    const maskedKey = `${keyPrefix}...${secretKey.slice(-4)}`;
    const keyHash = this.hashSecretKey(secretKey);
    const now = new Date().toISOString();

    const record: DeveloperApiKeyRecord = {
      id: crypto.randomUUID(),
      keyPrefix,
      keyHash,
      maskedKey,
      developerName: input.developerName.trim(),
      email: input.email.trim().toLowerCase(),
      organization: input.organization?.trim(),
      environment: env,
      permittedEndpoints: input.permittedEndpoints && input.permittedEndpoints.length > 0 ? input.permittedEndpoints : ['all'],
      monthlyLimit: Number(input.monthlyLimit) > 0 ? Number(input.monthlyLimit) : 1000,
      currentMonthRequests: 0,
      status: 'active',
      expiryDate: input.expiryDate || undefined,
      createdBy: input.createdBy || 'superadmin',
      createdAt: now,
      webhookUrl: input.webhookUrl?.trim() || undefined,
    };

    const pool = this.getPool();
    if (pool) {
      await pool.query(
        `INSERT INTO developer_api_keys (
          id, key_prefix, key_hash, masked_key, developer_name, email, organization,
          environment, permitted_endpoints, monthly_limit, current_month_requests,
          status, expiry_date, created_by, created_at, webhook_url
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          record.id,
          record.keyPrefix,
          record.keyHash,
          record.maskedKey,
          record.developerName,
          record.email,
          record.organization || null,
          record.environment,
          JSON.stringify(record.permittedEndpoints),
          record.monthlyLimit,
          record.currentMonthRequests,
          record.status,
          record.expiryDate || null,
          record.createdBy,
          record.createdAt,
          record.webhookUrl || null,
        ]
      );
    } else {
      await db.mutate((data) => {
        data.developerApiKeys = data.developerApiKeys || [];
        data.developerApiKeys.push(record);
      });
    }

    this.keyCache.set(record.keyHash, record);
    this.cacheExpiry.set(record.keyHash, Date.now() + this.CACHE_TTL_MS);

    return { record, secretKey };
  }

  /**
   * Authenticates a developer key and checks permissions and monthly quotas.
   */
  async authenticateKey(
    rawKey: string,
    endpointPath?: string
  ): Promise<{ valid: boolean; record?: DeveloperApiKeyRecord; reason?: string }> {
    if (!rawKey || typeof rawKey !== 'string') {
      return { valid: false, reason: 'Missing or malformed API key' };
    }

    const keyHash = this.hashSecretKey(rawKey.trim());
    let record = this.keyCache.get(keyHash);
    const cachedAt = this.cacheExpiry.get(keyHash) || 0;

    if (!record || Date.now() > cachedAt) {
      const pool = this.getPool();
      if (pool) {
        const res = await pool.query(
          `SELECT * FROM developer_api_keys WHERE key_hash = $1`,
          [keyHash]
        );
        if (res.rows.length === 0) {
          return { valid: false, reason: 'Invalid API key' };
        }
        const row = res.rows[0];
        record = {
          id: row.id,
          keyPrefix: row.key_prefix,
          keyHash: row.key_hash,
          maskedKey: row.masked_key,
          developerName: row.developer_name,
          email: row.email,
          organization: row.organization,
          environment: row.environment,
          permittedEndpoints: typeof row.permitted_endpoints === 'string' ? JSON.parse(row.permitted_endpoints) : (row.permitted_endpoints || ['all']),
          monthlyLimit: Number(row.monthly_limit || 1000),
          currentMonthRequests: Number(row.current_month_requests || 0),
          status: row.status,
          expiryDate: row.expiry_date ? new Date(row.expiry_date).toISOString() : undefined,
          lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
          createdBy: row.created_by,
          createdAt: new Date(row.created_at).toISOString(),
          revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
          revokedReason: row.revoked_reason,
          webhookUrl: row.webhook_url,
        };
      } else {
        const data = await db.read();
        record = (data.developerApiKeys || []).find((k) => k.keyHash === keyHash);
      }

      if (record) {
        this.keyCache.set(keyHash, record);
        this.cacheExpiry.set(keyHash, Date.now() + this.CACHE_TTL_MS);
      }
    }

    if (!record) {
      return { valid: false, reason: 'Invalid API key' };
    }

    if (record.status !== 'active') {
      return { valid: false, reason: `API key is ${record.status}` };
    }

    if (record.expiryDate && new Date(record.expiryDate).getTime() < Date.now()) {
      return { valid: false, reason: 'API key has expired' };
    }

    // Check scope if endpoint is provided
    if (endpointPath && record.permittedEndpoints && !record.permittedEndpoints.includes('all')) {
      const isAllowed = record.permittedEndpoints.some((pattern) => {
        if (pattern === endpointPath) return true;
        if (pattern.endsWith('*') && endpointPath.startsWith(pattern.slice(0, -1))) return true;
        return false;
      });
      if (!isAllowed) {
        return { valid: false, reason: `Endpoint ${endpointPath} is not authorized for this API key` };
      }
    }

    // Check monthly limit
    if (record.currentMonthRequests >= record.monthlyLimit) {
      return { valid: false, reason: `Monthly quota of ${record.monthlyLimit} requests exceeded` };
    }

    // Async record usage counter
    this.incrementUsage(record.id).catch(() => {});

    return { valid: true, record };
  }

  private async incrementUsage(keyId: string): Promise<void> {
    const now = new Date().toISOString();
    const pool = this.getPool();
    if (pool) {
      await pool.query(
        `UPDATE developer_api_keys 
         SET current_month_requests = current_month_requests + 1, last_used_at = NOW() 
         WHERE id = $1`,
        [keyId]
      );
    } else {
      await db.mutate((data) => {
        data.developerApiKeys = data.developerApiKeys || [];
        const item = data.developerApiKeys.find((k) => k.id === keyId);
        if (item) {
          item.currentMonthRequests = (item.currentMonthRequests || 0) + 1;
          item.lastUsedAt = now;
        }
      });
    }
  }

  /**
   * Logs an API request execution asynchronously.
   */
  async recordUsageLog(log: {
    keyId: string;
    endpoint: string;
    method: string;
    statusCode: number;
    latencyMs: number;
    ipAddress?: string;
    userAgent?: string;
  }): Promise<void> {
    const record: DeveloperUsageLogRecord = {
      id: crypto.randomUUID(),
      keyId: log.keyId,
      endpoint: log.endpoint,
      method: log.method,
      statusCode: log.statusCode,
      latencyMs: log.latencyMs,
      ipAddress: log.ipAddress,
      userAgent: log.userAgent,
      createdAt: new Date().toISOString(),
    };

    const pool = this.getPool();
    if (pool) {
      await pool.query(
        `INSERT INTO developer_usage_logs (
          id, key_id, endpoint, method, status_code, latency_ms, ip_address, user_agent, created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          record.id,
          record.keyId,
          record.endpoint,
          record.method,
          record.statusCode,
          record.latencyMs,
          record.ipAddress || null,
          record.userAgent || null,
          record.createdAt,
        ]
      );
    } else {
      await db.mutate((data) => {
        data.developerUsageLogs = data.developerUsageLogs || [];
        data.developerUsageLogs.unshift(record);
        if (data.developerUsageLogs.length > 5000) {
          data.developerUsageLogs = data.developerUsageLogs.slice(0, 5000);
        }
      });
    }
  }

  /**
   * Lists all issued developer keys (metadata only).
   */
  async listKeys(): Promise<Omit<DeveloperApiKeyRecord, 'keyHash'>[]> {
    const pool = this.getPool();
    let records: DeveloperApiKeyRecord[] = [];

    if (pool) {
      const res = await pool.query(
        `SELECT id, key_prefix, masked_key, developer_name, email, organization,
                environment, permitted_endpoints, monthly_limit, current_month_requests,
                status, expiry_date, last_used_at, created_by, created_at, revoked_at,
                revoked_reason, webhook_url
         FROM developer_api_keys
         ORDER BY created_at DESC`
      );
      records = res.rows.map((row) => ({
        id: row.id,
        keyPrefix: row.key_prefix,
        keyHash: '',
        maskedKey: row.masked_key,
        developerName: row.developer_name,
        email: row.email,
        organization: row.organization,
        environment: row.environment,
        permittedEndpoints: typeof row.permitted_endpoints === 'string' ? JSON.parse(row.permitted_endpoints) : (row.permitted_endpoints || ['all']),
        monthlyLimit: Number(row.monthly_limit || 1000),
        currentMonthRequests: Number(row.current_month_requests || 0),
        status: row.status,
        expiryDate: row.expiry_date ? new Date(row.expiry_date).toISOString() : undefined,
        lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : undefined,
        createdBy: row.created_by,
        createdAt: new Date(row.created_at).toISOString(),
        revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : undefined,
        revokedReason: row.revoked_reason,
        webhookUrl: row.webhook_url,
      }));
    } else {
      const data = await db.read();
      records = data.developerApiKeys || [];
    }

    return records.map(({ keyHash, ...safe }) => safe);
  }

  /**
   * Revokes an existing key immediately.
   */
  async revokeKey(id: string, reason = 'Revoked by admin'): Promise<boolean> {
    const now = new Date().toISOString();
    const pool = this.getPool();

    if (pool) {
      const res = await pool.query(
        `UPDATE developer_api_keys 
         SET status = 'revoked', revoked_at = NOW(), revoked_reason = $1 
         WHERE id = $2 RETURNING *`,
        [reason, id]
      );
      if (res.rows.length === 0) return false;
      const keyHash = res.rows[0].key_hash;
      if (keyHash) {
        this.keyCache.delete(keyHash);
        this.cacheExpiry.delete(keyHash);
      }
      return true;
    } else {
      let found = false;
      await db.mutate((data) => {
        data.developerApiKeys = data.developerApiKeys || [];
        const item = data.developerApiKeys.find((k) => k.id === id);
        if (item) {
          item.status = 'revoked';
          item.revokedAt = now;
          item.revokedReason = reason;
          this.keyCache.delete(item.keyHash);
          this.cacheExpiry.delete(item.keyHash);
          found = true;
        }
      });
      return found;
    }
  }

  /**
   * Returns recent request logs for a developer key.
   */
  async getKeyLogs(keyId: string, limit = 50): Promise<DeveloperUsageLogRecord[]> {
    const pool = this.getPool();
    if (pool) {
      const res = await pool.query(
        `SELECT * FROM developer_usage_logs WHERE key_id = $1 ORDER BY created_at DESC LIMIT $2`,
        [keyId, limit]
      );
      return res.rows.map((row) => ({
        id: row.id,
        keyId: row.key_id,
        endpoint: row.endpoint,
        method: row.method,
        statusCode: row.status_code,
        latencyMs: row.latency_ms,
        ipAddress: row.ip_address,
        userAgent: row.user_agent,
        createdAt: new Date(row.created_at).toISOString(),
      }));
    } else {
      const data = await db.read();
      return (data.developerUsageLogs || []).filter((l) => l.keyId === keyId).slice(0, limit);
    }
  }

  /**
   * Returns aggregate developer analytics across all keys.
   */
  async getAnalytics(): Promise<DeveloperAnalyticsSummary> {
    const keys = await this.listKeys();
    const totalKeys = keys.length;
    const activeKeys = keys.filter((k) => k.status === 'active').length;
    const revokedKeys = keys.filter((k) => k.status === 'revoked').length;
    const totalRequestsMonth = keys.reduce((acc, k) => acc + (k.currentMonthRequests || 0), 0);

    const pool = this.getPool();
    let totalRequestsLifetime = totalRequestsMonth;
    let avgLatencyMs = 45;
    let errorRatePercent = 0;
    let topEndpoints: { endpoint: string; count: number }[] = [];
    let recentLogs: DeveloperUsageLogRecord[] = [];

    if (pool) {
      const countRes = await pool.query(`SELECT COUNT(*) as count FROM developer_usage_logs`);
      totalRequestsLifetime = Number(countRes.rows[0]?.count || totalRequestsMonth);

      const latencyRes = await pool.query(`SELECT AVG(latency_ms) as avg_lat FROM developer_usage_logs`);
      avgLatencyMs = Math.round(Number(latencyRes.rows[0]?.avg_lat || 45));

      const errRes = await pool.query(
        `SELECT COUNT(*) as err_count FROM developer_usage_logs WHERE status_code >= 400`
      );
      const errCount = Number(errRes.rows[0]?.err_count || 0);
      errorRatePercent = totalRequestsLifetime > 0 ? Number(((errCount / totalRequestsLifetime) * 100).toFixed(1)) : 0;

      const topRes = await pool.query(
        `SELECT endpoint, COUNT(*) as count FROM developer_usage_logs GROUP BY endpoint ORDER BY count DESC LIMIT 5`
      );
      topEndpoints = topRes.rows.map((r) => ({ endpoint: r.endpoint, count: Number(r.count) }));

      const recentRes = await pool.query(
        `SELECT * FROM developer_usage_logs ORDER BY created_at DESC LIMIT 20`
      );
      recentLogs = recentRes.rows.map((r) => ({
        id: r.id,
        keyId: r.key_id,
        endpoint: r.endpoint,
        method: r.method,
        statusCode: r.status_code,
        latencyMs: r.latency_ms,
        ipAddress: r.ip_address,
        userAgent: r.user_agent,
        createdAt: new Date(r.created_at).toISOString(),
      }));
    } else {
      const data = await db.read();
      const logs = data.developerUsageLogs || [];
      totalRequestsLifetime = Math.max(logs.length, totalRequestsMonth);
      if (logs.length > 0) {
        avgLatencyMs = Math.round(logs.reduce((acc, l) => acc + (l.latencyMs || 0), 0) / logs.length);
        const errCount = logs.filter((l) => l.statusCode >= 400).length;
        errorRatePercent = Number(((errCount / logs.length) * 100).toFixed(1));
      }

      const counts: Record<string, number> = {};
      logs.forEach((l) => { counts[l.endpoint] = (counts[l.endpoint] || 0) + 1; });
      topEndpoints = Object.entries(counts)
        .map(([endpoint, count]) => ({ endpoint, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5);

      recentLogs = logs.slice(0, 20);
    }

    return {
      totalKeys,
      activeKeys,
      revokedKeys,
      totalRequestsLifetime,
      totalRequestsMonth,
      avgLatencyMs,
      errorRatePercent,
      topEndpoints,
      recentLogs,
    };
  }
}

export const developerKeysService = DeveloperKeysService.getInstance();
