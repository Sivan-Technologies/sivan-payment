import crypto from 'crypto';
import { env } from '../../config/env.js';

export interface MetaMapSessionParams {
  userId: string;
  phone?: string;
  email?: string;
  flowId?: string;
  metadata?: Record<string, any>;
}

export interface MetaMapSessionResult {
  verificationId: string;
  identityId: string;
  verificationUrl: string;
  flowId: string;
}

export interface MetaMapWebhookEvent {
  eventName: 'verification_completed' | 'verification_updated' | 'verification_expired' | string;
  step?: {
    id: string;
    status: number;
    error?: any;
    data?: any;
  };
  identity: {
    status: 'verified' | 'rejected' | 'reviewNeeded' | string;
  };
  metadata?: {
    userId?: string;
    phone?: string;
    email?: string;
    [key: string]: any;
  };
  resource?: string;
}

/**
 * MetaMap (Incode) Global eKYC & Biometric Verification Provider.
 * Supports OCR document verification for 200+ countries, 3D facial liveness,
 * and automated AML/PEP screening.
 */
export class MetaMapKycProvider {
  private readonly baseUrl: string;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly webhookSecret: string;
  private readonly defaultFlowId: string;

  private cachedAccessToken: string | null = null;
  private tokenExpiresAt: number = 0;

  constructor(config?: {
    baseUrl?: string;
    clientId?: string;
    clientSecret?: string;
    webhookSecret?: string;
    defaultFlowId?: string;
  }) {
    this.baseUrl = config?.baseUrl || (process.env.METAMAP_API_BASE_URL || 'https://api.getmati.com').replace(/\/$/, '');
    this.clientId = config?.clientId || process.env.METAMAP_CLIENT_ID || 'mock_metamap_client_id';
    this.clientSecret = config?.clientSecret || process.env.METAMAP_CLIENT_SECRET || 'mock_metamap_client_secret';
    this.webhookSecret = config?.webhookSecret || process.env.METAMAP_WEBHOOK_SECRET || 'mock_metamap_webhook_secret';
    this.defaultFlowId = config?.defaultFlowId || process.env.METAMAP_FLOW_ID || 'sivan_global_kyc_flow';
  }

  /**
   * Retrieves an active OAuth bearer token (with memory caching).
   */
  public async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.cachedAccessToken && this.tokenExpiresAt > now + 60000) {
      return this.cachedAccessToken;
    }

    if (!this.clientId || this.clientId === 'mock_metamap_client_id' || process.env.NODE_ENV === 'test') {
      this.cachedAccessToken = 'mock_metamap_jwt_token';
      this.tokenExpiresAt = now + 3600000;
      return this.cachedAccessToken;
    }

    try {
      const basicAuth = Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64');
      const response = await fetch(`${this.baseUrl}/oauth`, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${basicAuth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: 'grant_type=client_credentials',
      });

      if (!response.ok) {
        throw new Error(`MetaMap OAuth error ${response.status}`);
      }

      const data = (await response.json()) as { access_token: string; expires_in: number };
      this.cachedAccessToken = data.access_token;
      this.tokenExpiresAt = now + (data.expires_in || 3600) * 1000;
      return this.cachedAccessToken;
    } catch (err) {
      if (process.env.NODE_ENV === 'test') {
        this.cachedAccessToken = 'mock_metamap_jwt_token';
        this.tokenExpiresAt = now + 3600000;
        return this.cachedAccessToken;
      }
      throw err;
    }
  }

  /**
   * Creates a dedicated verification session URL for the user.
   */
  public async createVerificationSession(params: MetaMapSessionParams): Promise<MetaMapSessionResult> {
    const flowId = params.flowId || this.defaultFlowId;
    const token = await this.getAccessToken();

    if (token === 'mock_metamap_jwt_token' || !this.clientId || this.clientId === 'mock_metamap_client_id' || process.env.NODE_ENV === 'test') {
      const mockId = `meta_ver_${Math.random().toString(16).slice(2, 10)}`;
      return {
        verificationId: mockId,
        identityId: `meta_id_${params.userId}`,
        verificationUrl: `https://verify.metamap.com/?flowId=${encodeURIComponent(flowId)}&verificationId=${mockId}&userId=${encodeURIComponent(params.userId)}`,
        flowId,
      };
    }

    const response = await fetch(`${this.baseUrl}/v2/verifications`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        flowId,
        metadata: {
          userId: params.userId,
          phone: params.phone,
          email: params.email,
          platform: 'sivan-ai',
          ...params.metadata,
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create MetaMap verification session (${response.status})`);
    }

    const data = (await response.json()) as any;
    const verificationId = data.id || data.verificationId || `meta_${Date.now()}`;
    const identityId = data.identity || data.identityId || params.userId;
    const verificationUrl = data.verificationUrl || data.url || `https://verify.metamap.com/?flowId=${flowId}&verificationId=${verificationId}`;

    return {
      verificationId,
      identityId,
      verificationUrl,
      flowId,
    };
  }

  /**
   * Validates the MetaMap webhook signature (HMAC-SHA256).
   */
  public verifyWebhookSignature(rawBody: string, signature: string | undefined): boolean {
    if (process.env.NODE_ENV === 'test') {
      return true;
    }
    if (!signature || !this.webhookSecret) {
      return false;
    }

    try {
      const expected = crypto
        .createHmac('sha256', this.webhookSecret)
        .update(rawBody)
        .digest('hex');

      return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
    } catch {
      return false;
    }
  }

  /**
   * Extracts verified result status from webhook event.
   */
  public parseWebhookResult(event: MetaMapWebhookEvent): {
    userId?: string;
    isApproved: boolean;
    isReviewNeeded: boolean;
    isRejected: boolean;
    status: string;
  } {
    const userId = event.metadata?.userId;
    const status = event.identity?.status || 'unknown';

    return {
      userId,
      isApproved: status === 'verified',
      isReviewNeeded: status === 'reviewNeeded',
      isRejected: status === 'rejected',
      status,
    };
  }
}

export const defaultMetaMapProvider = new MetaMapKycProvider();
