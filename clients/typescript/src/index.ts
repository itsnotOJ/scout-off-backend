import createClient, { type ClientOptions } from 'openapi-fetch';
import type { paths } from './schema.js';

export type { paths } from './schema.js';

export interface ScoutOffClientOptions extends Omit<ClientOptions, 'baseUrl' | 'headers'> {
  baseUrl: string;
  accessToken?: string;
  headers?: HeadersInit;
}

export function createScoutOffClient(options: ScoutOffClientOptions) {
  const { accessToken, headers, ...clientOptions } = options;
  const requestHeaders = new Headers(headers);
  if (accessToken) requestHeaders.set('Authorization', `Bearer ${accessToken}`);

  return createClient<paths>({
    ...clientOptions,
    headers: requestHeaders,
  });
}

// ─── Signed admin requests (#1511) ────────────────────────────────────────────

/**
 * Signs the canonical request string with the admin wallet and returns the
 * base64 ed25519 signature. Either a raw signature over the message, or a
 * SEP-53 signature (e.g. Freighter `signMessage`) is accepted by the server.
 */
export type AdminRequestSigner = (canonicalRequest: string) => Promise<string>;

export interface AdminSignatureInput {
  method: string;
  /** Request path exactly as sent, without query string, e.g. `/api/admin/fees/withdraw`. */
  path: string;
  /** Exact request body string that will be sent (omit or '' for no body). */
  body?: string;
  signer: AdminRequestSigner;
  /** Unix seconds; defaults to now. */
  timestamp?: number;
  /** Defaults to 16 random bytes, hex encoded. */
  nonce?: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** Build the X-Admin-Signature / X-Admin-Timestamp / X-Admin-Nonce headers for a high-risk admin call. */
export async function createAdminSignatureHeaders(input: AdminSignatureInput): Promise<Record<string, string>> {
  const timestamp = String(input.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = input.nonce ?? toHex(crypto.getRandomValues(new Uint8Array(16)));
  const bodyHash = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.body ?? ''))));
  const canonical = [input.method.toUpperCase(), input.path, bodyHash, timestamp, nonce].join('\n');
  return {
    'X-Admin-Signature': await input.signer(canonical),
    'X-Admin-Timestamp': timestamp,
    'X-Admin-Nonce': nonce,
  };
}
