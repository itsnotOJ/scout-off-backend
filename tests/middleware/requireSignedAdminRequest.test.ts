/**
 * Signed admin requests (#1511).
 */
import crypto from 'crypto';
import express, { Request } from 'express';
import request from 'supertest';
import { Keypair } from '@stellar/stellar-sdk';
import config from '../../src/config';
import * as db from '../../src/db';
import { requireSignedAdminRequest, canonicalAdminRequest } from '../../src/middleware/requireSignedAdminRequest';
import { consumeAdminRequestNonce, setAdminNonceRedisClient } from '../../src/services/adminRequestNonces';

const admin = Keypair.random();
const PATH = '/api/admin/fees/withdraw';

/** Minimal Redis stand-in with SET … EX … NX semantics, shareable between "instances". */
function fakeRedis() {
  const keys = new Set<string>();
  return {
    set: jest.fn(async (key: string, _v: string, _ex: string, _ttl: number, nx: string) => {
      if (nx === 'NX' && keys.has(key)) return null;
      keys.add(key);
      return 'OK';
    }),
  };
}

function buildApp() {
  const app = express();
  app.use(express.json({ verify: (req, _res, buf) => { (req as Request).rawBody = buf; } }));
  const router = express.Router();
  router.post('/fees/withdraw', (req, _res, next) => { req.account = admin.publicKey(); next(); }, requireSignedAdminRequest,
    (req, res) => { res.json({ ok: true, adminSignature: req.adminSignature }); });
  app.use('/api/admin', router);
  return app;
}

function signedHeaders(body: string, opts: { signer?: Keypair; timestamp?: number; nonce?: string; path?: string } = {}) {
  const timestamp = String(opts.timestamp ?? Math.floor(Date.now() / 1000));
  const nonce = opts.nonce ?? crypto.randomBytes(16).toString('hex');
  const canonical = canonicalAdminRequest('POST', opts.path ?? PATH, body, timestamp, nonce);
  return {
    'Content-Type': 'application/json',
    'X-Admin-Signature': Buffer.from((opts.signer ?? admin).sign(Buffer.from(canonical))).toString('base64'),
    'X-Admin-Timestamp': timestamp,
    'X-Admin-Nonce': nonce,
  };
}

describe('requireSignedAdminRequest', () => {
  const body = JSON.stringify({ recipient: 'GXYZ', amount: '10' });
  let redis: ReturnType<typeof fakeRedis>;

  beforeEach(() => {
    config.adminSignedRequestsEnabled = true;
    redis = fakeRedis();
    setAdminNonceRedisClient(redis);
    jest.spyOn(db, 'insertAuditLog').mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    config.adminSignedRequestsEnabled = false;
    setAdminNonceRedisClient(undefined);
    jest.restoreAllMocks();
  });

  it('accepts a valid signature and records signature metadata in the audit log', async () => {
    const res = await request(buildApp()).post(PATH).set(signedHeaders(body)).send(body);

    expect(res.status).toBe(200);
    expect(res.body.adminSignature.canonicalHash).toMatch(/^[0-9a-f]{64}$/);
    expect(db.insertAuditLog).toHaveBeenCalledWith(expect.objectContaining({
      action: 'admin_signed_request',
      adminWallet: admin.publicKey(),
      queryParams: expect.objectContaining({ path: PATH, signature: expect.any(String), canonicalHash: res.body.adminSignature.canonicalHash }),
    }));
  });

  it('accepts a SEP-53 (wallet signMessage) signature', async () => {
    const headers = signedHeaders(body);
    const canonical = canonicalAdminRequest('POST', PATH, body, headers['X-Admin-Timestamp'], headers['X-Admin-Nonce']);
    const digest = crypto.createHash('sha256').update(`Stellar Signed Message:\n${canonical}`).digest();
    headers['X-Admin-Signature'] = Buffer.from(admin.sign(digest)).toString('base64');

    expect((await request(buildApp()).post(PATH).set(headers).send(body)).status).toBe(200);
  });

  it('rejects a request without signature headers', async () => {
    const res = await request(buildApp()).post(PATH).set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_SIGNATURE_REQUIRED');
  });

  it('rejects a signature from a different key than the JWT account', async () => {
    const res = await request(buildApp()).post(PATH).set(signedHeaders(body, { signer: Keypair.random() })).send(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_SIGNATURE_INVALID');
  });

  it('rejects a stale timestamp', async () => {
    const res = await request(buildApp()).post(PATH)
      .set(signedHeaders(body, { timestamp: Math.floor(Date.now() / 1000) - 120 })).send(body);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_SIGNATURE_STALE');
  });

  it('rejects a reused nonce', async () => {
    const app = buildApp();
    const headers = signedHeaders(body);
    expect((await request(app).post(PATH).set(headers).send(body)).status).toBe(200);
    const replay = await request(app).post(PATH).set(headers).send(body);
    expect(replay.status).toBe(401);
    expect(replay.body.code).toBe('ADMIN_SIGNATURE_REPLAYED');
  });

  it('rejects body tampering', async () => {
    const res = await request(buildApp()).post(PATH).set(signedHeaders(body))
      .send(JSON.stringify({ recipient: 'GATTACKER', amount: '10' }));
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('ADMIN_SIGNATURE_INVALID');
  });

  it('rejects a signature made for a different path', async () => {
    const res = await request(buildApp()).post(PATH).set(signedHeaders(body, { path: '/api/admin/fees' })).send(body);
    expect(res.status).toBe(401);
  });

  it('enforces single-use nonces across instances sharing Redis', async () => {
    const headers = signedHeaders(body);
    expect((await request(buildApp()).post(PATH).set(headers).send(body)).status).toBe(200);
    expect((await request(buildApp()).post(PATH).set(headers).send(body)).status).toBe(401);
    expect(redis.set).toHaveBeenCalledWith(expect.stringContaining(headers['X-Admin-Nonce']), '1', 'EX', 120, 'NX');
  });

  it('is skipped for routes not in ADMIN_SIGNED_ROUTES and when disabled', async () => {
    const saved = config.adminSignedRoutes;
    config.adminSignedRoutes = ['POST /contract/pause'];
    try {
      expect((await request(buildApp()).post(PATH).set('Content-Type', 'application/json').send(body)).status).toBe(200);
    } finally {
      config.adminSignedRoutes = saved;
    }
    config.adminSignedRequestsEnabled = false;
    expect((await request(buildApp()).post(PATH).set('Content-Type', 'application/json').send(body)).status).toBe(200);
  });

  it('protects fee withdrawal, fee config, pause/unpause and multisig approval by default', () => {
    expect(config.adminSignedRoutes).toEqual(expect.arrayContaining([
      'POST /fees/withdraw', 'POST /fees/config', 'POST /contract/pause', 'POST /contract/unpause', 'POST /actions/:id/approve',
    ]));
  });
});

describe('consumeAdminRequestNonce DB fallback', () => {
  afterEach(() => setAdminNonceRedisClient(undefined));

  it('falls back to the database when Redis is unavailable', async () => {
    setAdminNonceRedisClient({ set: jest.fn().mockRejectedValue(new Error('down')) } as never);
    const nonce = crypto.randomBytes(16).toString('hex');
    await expect(consumeAdminRequestNonce(nonce, 120)).resolves.toBe(true);
    await expect(consumeAdminRequestNonce(nonce, 120)).resolves.toBe(false);
  });
});
