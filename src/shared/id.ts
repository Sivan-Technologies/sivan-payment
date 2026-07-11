import crypto from 'node:crypto';

export function id(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function idempotencyKey(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

export function nowIso(): string {
  return new Date().toISOString();
}
