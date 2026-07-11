import { env } from '../../config/env.js';
import { AppError } from '../../shared/errors.js';

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  idempotencyKey?: string;
  query?: Record<string, string | undefined>;
}

export class BridgeClient {
  constructor(
    private baseUrl = env.BRIDGE_BASE_URL,
    private apiKey = env.BRIDGE_API_KEY
  ) {}

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (!this.apiKey) {
      throw new AppError(500, 'BRIDGE_API_KEY is required when BRIDGE_MOCK_MODE=false', 'bridge_api_key_missing');
    }

    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value) url.searchParams.set(key, value);
    }

    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'Api-Key': this.apiKey
    };
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;

    const res = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body)
    });

    const text = await res.text();
    const json = text ? safeJson(text) : null;

    if (!res.ok) {
      throw new AppError(res.status, `Bridge API error: ${res.status}`, 'bridge_api_error', json ?? text);
    }

    return json as T;
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
