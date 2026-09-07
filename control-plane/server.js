const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const cors = require('cors');
const { createMobileConnectRouter } = require('./src/infrastructure/web/routes/mobile-connect');
const { SqliteDeviceStore } = require('./sqlite-device-store');

function secureOrigin(value, name) {
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password
    || (url.protocol !== 'https:' && !(url.protocol === 'http:'
      && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
    throw new Error(`${name} must be an HTTPS origin (HTTP is allowed on loopback)`);
  }
  return value;
}

function createControlPlane({ env = process.env, databasePath = env.CAS_CLOUD_DATABASE || './data/devices.sqlite' } = {}) {
  const accessToken = env.CAS_ACCESS_TOKEN;
  if (!/^[A-Za-z0-9_-]{43,}$/.test(accessToken || '')) {
    throw new Error('CAS_ACCESS_TOKEN must be a random base64url token of at least 32 bytes');
  }
  if (!env.MOBILE_RELAY_SECRET || env.MOBILE_RELAY_SECRET.length < 32) {
    throw new Error('MOBILE_RELAY_SECRET must contain at least 32 characters');
  }
  const relayOrigin = secureOrigin(env.MOBILE_RELAY_URL, 'MOBILE_RELAY_URL');
  const webOrigin = secureOrigin(env.CAS_WEB_ORIGIN, 'CAS_WEB_ORIGIN');
  if (databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(path.resolve(databasePath)), { recursive: true, mode: 0o700 });
  }
  const store = new SqliteDeviceStore(databasePath);
  if (databasePath !== ':memory:') fs.chmodSync(databasePath, 0o600);
  const expected = crypto.createHash('sha256').update(accessToken).digest();
  const app = express();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  app.use(cors({ origin: webOrigin, methods: ['GET', 'POST', 'DELETE', 'OPTIONS'] }));
  app.use(express.json({ limit: '64kb' }));
  app.get('/health', (_req, res) => res.json({ ok: true, service: 'cas-cloud-control-plane' }));
  app.use('/api/mobile', createMobileConnectRouter({
    relayOrigin,
    relaySecret: env.MOBILE_RELAY_SECRET,
    deviceStore: store,
    groqApiKey: env.GROQ_API_KEY,
    authMiddleware(req, res, next) {
      const token = req.headers.authorization?.match(/^Bearer (\S+)$/)?.[1] || '';
      const digest = crypto.createHash('sha256').update(token).digest();
      if (!crypto.timingSafeEqual(digest, expected)) return res.status(401).json({ error: 'Invalid host credential' });
      // ponytail: one trust group per installation; add per-user credentials when multi-tenant hosting is required.
      req.user = { id: 'cas-cloud-owner' };
      return next();
    },
  }));
  app.use((error, _req, res, _next) => {
    const status = error.status >= 400 && error.status < 500 ? error.status : 500;
    res.status(status).json({ error: status === 500 ? 'Control plane request failed' : error.message });
  });
  return { app, store };
}

if (require.main === module) {
  process.umask(0o077);
  const { app, store } = createControlPlane();
  const server = app.listen(Number(process.env.PORT || 8788), process.env.HOST || '127.0.0.1', () => {
    console.log('CAS Cloud control plane is listening');
  });
  const stop = () => server.close(() => { store.close(); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

module.exports = { createControlPlane };
