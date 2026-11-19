/**
 * Request signing for high-risk admin mutations (#1511).
 *
 * A bearer JWT alone is not enough to move funds or pause contracts: the
 * caller must also sign a canonical description of the request with the
 * Stellar key in the JWT's `sub`:
 *
 *   METHOD \n PATH \n SHA256_HEX(raw body) \n TIMESTAMP \n NONCE
 *
 * sent as `X-Admin-Signature` (base64 ed25519), `X-Admin-Timestamp` (unix
 * seconds, ±60s) and `X-Admin-Nonce` (single-use across instances).
 *
 * The signature may be over the canonical string itself, or over its SEP-53
 * form (sha256("Stellar Signed Message:\n" + canonical)) as produced by
 * wallet `signMessage` APIs.
 *
 * Must run after requireRole('admin'). Only enforced for routes listed in
 * ADMIN_SIGNED_ROUTES while ADMIN_SIGNED_REQUESTS_ENABLED is true.
 */
import crypto from 'crypto';
import { Request, Response, NextFunction } from 'express';
import { Keypair } from '@stellar/stellar-sdk';
import config from '../config';
import { ErrorCode } from '../utils/errorCodes';
import { sendUnauthorized } from '../utils/authError';
import { logger } from '../utils/logger';
import { insertAuditLog } from '../db';
import { consumeAdminRequestNonce } from '../services/adminRequestNonces';

export const ADMIN_SIGNATURE_MAX_SKEW_SECONDS = 60;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const SEP53_PREFIX = 'Stellar Signed Message:\n';

const sha256 = (data: Buffer | string): Buffer => crypto.createHash('sha256').update(data).digest();

/** Build the canonical string the admin must sign. */
export function canonicalAdminRequest(
  method: string,
  path: string,
  body: Buffer | string,
  timestamp: string,
  nonce: string,
): string {
  return [method.toUpperCase(), path, sha256(body).toString('hex'), timestamp, nonce].join('\n');
}

function verifySignature(account: string, canonical: string, signature: Buffer): boolean {
  try {
    const kp = Keypair.fromPublicKey(account);
    return kp.verify(Buffer.from(canonical), signature)
      || kp.verify(sha256(SEP53_PREFIX + canonical), signature);
  } catch {
    return false;
  }
}

function header(req: Request, name: string): string | undefined {
  const value = req.headers[name];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function requireSignedAdminRequest(req: Request, res: Response, next: NextFunction): Promise<void> {
  const routeKey = `${req.method} ${req.route?.path ?? req.path}`;
  if (!config.adminSignedRequestsEnabled || !config.adminSignedRoutes.includes(routeKey)) {
    next();
    return;
  }

  const fail = (message: string, code: ErrorCode, reason: string): void => {
    logger.warn('[admin] signed_request_rejected', { path: req.originalUrl, account: req.account, reason });
    sendUnauthorized(res, message, undefined, code);
  };

  const signatureB64 = header(req, 'x-admin-signature');
  const timestamp = header(req, 'x-admin-timestamp');
  const nonce = header(req, 'x-admin-nonce');
  const account = req.account;
  if (!signatureB64 || !timestamp || !nonce || !account) {
    fail('Signed admin request required', ErrorCode.ADMIN_SIGNATURE_REQUIRED, 'missing_headers');
    return;
  }

  const ts = Number(timestamp);
  if (!/^\d+$/.test(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - ts) > ADMIN_SIGNATURE_MAX_SKEW_SECONDS) {
    fail('Admin request signature has expired', ErrorCode.ADMIN_SIGNATURE_STALE, 'stale_timestamp');
    return;
  }
  if (!NONCE_PATTERN.test(nonce)) {
    fail('Invalid admin request signature', ErrorCode.ADMIN_SIGNATURE_INVALID, 'bad_nonce');
    return;
  }

  const path = req.originalUrl.split('?')[0];
  const body = req.rawBody ?? Buffer.alloc(0);
  const canonical = canonicalAdminRequest(req.method, path, body, timestamp, nonce);
  if (!verifySignature(account, canonical, Buffer.from(signatureB64, 'base64'))) {
    fail('Invalid admin request signature', ErrorCode.ADMIN_SIGNATURE_INVALID, 'bad_signature');
    return;
  }

  // Consume the nonce only after the signature checks out, so unauthenticated
  // callers cannot burn an admin's nonces.
  let fresh: boolean;
  try {
    fresh = await consumeAdminRequestNonce(nonce, ADMIN_SIGNATURE_MAX_SKEW_SECONDS * 2);
  } catch (err) {
    next(err);
    return;
  }
  if (!fresh) {
    fail('Admin request nonce has already been used', ErrorCode.ADMIN_SIGNATURE_REPLAYED, 'nonce_reused');
    return;
  }

  const canonicalHash = sha256(canonical).toString('hex');
  req.adminSignature = { signature: signatureB64, canonicalHash, timestamp: ts, nonce };

  try {
    await insertAuditLog({
      action: 'admin_signed_request',
      adminWallet: account,
      queryParams: { method: req.method, path, signature: signatureB64, canonicalHash, timestamp: ts, nonce },
      eventSource: 'requireSignedAdminRequest',
      createdAt: new Date().toISOString(),
    });
  } catch (err) {
    logger.warn('[admin] signed_request audit write failed', { err: err instanceof Error ? err.message : String(err) });
  }

  next();
}
