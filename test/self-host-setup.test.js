const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { parseEnv } = require('node:util');
const { configure } = require('../self-hosting/setup');

test('setup creates consistent private credentials and preserves them on rerun', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cas-setup-'));
  const read = (name) => parseEnv(fs.readFileSync(path.join(root, name), 'utf8'));
  try {
    configure(root);
    const api = read('control-plane/.env');
    const host = read('self-hosting/host.env');
    assert.match(api.CAS_ACCESS_TOKEN, /^[A-Za-z0-9_-]{43}$/);
    assert.notEqual(api.CAS_ACCESS_TOKEN, api.MOBILE_RELAY_SECRET);
    assert.equal(read('relay/.dev.vars').MOBILE_RELAY_SECRET, api.MOBILE_RELAY_SECRET);
    assert.equal(host.CAS_ACCESS_TOKEN, api.CAS_ACCESS_TOKEN);
    assert.equal(host.MOBILE_RELAY_SECRET, undefined);
    assert.deepEqual(read('web/.env.local'), { EXPO_PUBLIC_MOBILE_RELAY_URL: 'http://127.0.0.1:8787' });
    assert.equal(fs.statSync(path.join(root, 'self-hosting/host.env')).mode & 0o777, 0o600);
    configure(root);
    assert.deepEqual(read('control-plane/.env'), api);
    configure(root, 'example.com');
    assert.equal(read('control-plane/.env').CAS_ACCESS_TOKEN, api.CAS_ACCESS_TOKEN);
    assert.equal(read('self-hosting/host.env').CAS_WEB_ORIGIN, 'https://web.example.com');
    assert.throws(() => configure(root, 'example.com\nBAD=value'), /domain/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
