/**
 * Single-use nonce store for signed admin requests (#1511).
 *
 * Redis primary (`SET … NX EX`) so a nonce is consumed exactly once across all
 * backend instances; falls back to the `admin_request_nonces` table (unique
 * primary key) when Redis is not configured or a command fails.
 */
import type Redis from 'ioredis';
import { getDriver } from '../db';
import { getRedisClient } from './redis';
import { logger } from '../utils/logger';

type NonceRedis = Pick<Redis, 'set'>;

const REDIS_KEY_PREFIX = 'admin:nonce:';

let redisOverride: NonceRedis | null | undefined;

/** Test hook: inject a Redis-like client (null forces the DB fallback). */
export function setAdminNonceRedisClient(client: NonceRedis | null | undefined): void {
  redisOverride = client;
}

function redis(): NonceRedis | null {
  return redisOverride !== undefined ? redisOverride : getRedisClient();
}

/**
 * Atomically mark `nonce` as used for `ttlSeconds`.
 * Returns true the first time a nonce is seen, false on any reuse.
 */
export async function consumeAdminRequestNonce(nonce: string, ttlSeconds: number): Promise<boolean> {
  const client = redis();
  if (client) {
    try {
      const result = await client.set(`${REDIS_KEY_PREFIX}${nonce}`, '1', 'EX', ttlSeconds, 'NX');
      return result === 'OK';
    } catch (err) {
      logger.warn('[adminRequestNonces] Redis unavailable, falling back to DB', {
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const now = Math.floor(Date.now() / 1000);
  const driver = getDriver();
  await driver.run('DELETE FROM admin_request_nonces WHERE expires_at <= ?', [now]);
  const info = await driver.run(
    'INSERT INTO admin_request_nonces (nonce, expires_at) VALUES (?, ?) ON CONFLICT (nonce) DO NOTHING',
    [nonce, now + ttlSeconds],
  );
  return info.changes > 0;
}
