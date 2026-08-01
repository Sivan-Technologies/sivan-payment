import crypto from 'node:crypto';

/**
 * Privy authorization signatures, for a wallet Sivan is a signer on.
 *
 * Implemented directly rather than via @privy-io/server-auth. The SDK does
 * expose these helpers, but only under `dist/cjs/wallet-api/utils.js`, which
 * its package `exports` map does not publish - reaching them needs an absolute
 * path require that works on a developer machine and breaks the moment the
 * dependency tree is rebuilt. A bad trade for ~40 lines of ECDSA.
 *
 * Verified against the live API: a hand-rolled signature is accepted and the
 * transaction reaches on-chain simulation.
 *
 * WHY THIS EXISTS AT ALL
 *
 * Privy wallets here are USER-OWNED, so app credentials alone cannot move
 * funds - signing without this returns 401 "No valid authorization keys or
 * user signing keys available". Sivan is added as an ADDITIONAL SIGNER, which
 * is a narrower grant than ownership: the user still owns the wallet, and
 * Sivan holds a scoped permission it must prove on every request.
 */

/**
 * RFC 8785 JSON Canonicalization.
 *
 * The signature is computed over canonical JSON, so key order must be
 * deterministic at EVERY level of nesting, not just the top. JSON.stringify's
 * replacer array only sorts the outermost object, which is why a first attempt
 * produced a valid-looking signature that Privy rejected with 401. Undefined
 * values are dropped rather than serialised, matching JSON.stringify.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
}

export interface AuthorizationSignatureInput {
  method: 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Full URL, no trailing slash. Part of the signed payload. */
  url: string;
  body: unknown;
  appId: string;
  /** PKCS#8 PEM. Privy uses P-256; nothing else is accepted. */
  privateKeyPem: string;
  /** Only include when the request actually carries the header. */
  idempotencyKey?: string;
}

/**
 * Sign a request for the `privy-authorization-signature` header.
 *
 * The signed payload must mirror the request EXACTLY - method, url, body, and
 * any privy- prefixed headers. A mismatch anywhere fails as 401, which reads
 * like a permissions problem and is not one.
 */
export function authorizationSignature(input: AuthorizationSignatureInput): string {
  const payload = {
    version: 1,
    method: input.method,
    url: input.url,
    body: input.body,
    headers: {
      'privy-app-id': input.appId,
      ...(input.idempotencyKey ? { 'privy-idempotency-key': input.idempotencyKey } : {}),
    },
  };

  // DER encoding, which is what Privy's own SDK produces. The IEEE P1363 form
  // WebCrypto defaults to is rejected.
  return crypto
    .sign('sha256', Buffer.from(canonicalJson(payload)), {
      key: input.privateKeyPem,
      dsaEncoding: 'der',
    })
    .toString('base64');
}

/**
 * A P-256 keypair in the shapes Privy needs.
 *
 * `publicKeySpki` goes to POST /v1/key_quorums. `privateKeyPem` is the secret
 * that lets Sivan sign - never transmitted, and losing it means every wallet
 * quorum built on it must be replaced.
 */
export function generateAuthorizationKeyPair(): { publicKeySpki: string; privateKeyPem: string } {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    publicKeySpki: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

/**
 * Read the configured signing key, tolerating how env vars mangle newlines.
 *
 * A PEM pasted into a dashboard usually arrives with literal "\n" rather than
 * real newlines, and Node's crypto rejects that with an opaque parse error. A
 * base64-wrapped PEM is also accepted because it survives every transport.
 */
export function loadAuthorizationPrivateKey(raw: string | undefined): string | undefined {
  const value = (raw ?? '').trim();
  if (!value) return undefined;

  if (value.includes('BEGIN')) return value.replace(/\\n/g, '\n');

  try {
    const decoded = Buffer.from(value, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded;
  } catch {
    // Fall through - an unreadable key is reported by the caller, which can
    // name the variable that is wrong.
  }
  return undefined;
}
