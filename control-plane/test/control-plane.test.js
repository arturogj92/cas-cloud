const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes } = require('node:crypto');
const { mkdtempSync, rmSync, statSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const jwt = require('jsonwebtoken');
const { createControlPlane } = require('../server');

test('independent host auth, device pairing, persisted refresh rotation and revocation', async () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'cas-control-plane-'));
  const databasePath = path.join(directory, 'devices.sqlite');
  const env = {
    CAS_ACCESS_TOKEN: randomBytes(32).toString('base64url'),
    MOBILE_RELAY_SECRET: randomBytes(32).toString('base64url'),
    MOBILE_RELAY_URL: 'http://127.0.0.1:8787',
    CAS_WEB_ORIGIN: 'http://localhost:8081',
  };
  let instance;
  let server;
  let origin;
  const start = async () => {
    instance = createControlPlane({ env, databasePath });
    server = await new Promise((resolve) => {
      const listener = instance.app.listen(0, '127.0.0.1', () => resolve(listener));
    });
    origin = `http://127.0.0.1:${server.address().port}`;
  };
  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    instance.store.close();
  };
  const request = (route, body, token = env.CAS_ACCESS_TOKEN, method = 'POST') => fetch(`${origin}/api/mobile/${route}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, Origin: env.CAS_WEB_ORIGIN },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  try {
    await start();
    assert.equal((await request('desktop-ticket', { runtimeId: 'host-1' }, 'wrong')).status, 401);
    assert.equal((await request('desktop-ticket', { runtimeId: '../bad' })).status, 400);
    const ticketResponse = await request('desktop-ticket', { runtimeId: 'host-1', client: 'cas-cloud', version: '0.0.18' });
    assert.equal(ticketResponse.status, 200);
    assert.equal(ticketResponse.headers.get('access-control-allow-origin'), env.CAS_WEB_ORIGIN);
    const ticket = await ticketResponse.json();
    const claims = jwt.verify(ticket.ticket, env.MOBILE_RELAY_SECRET, {
      issuer: 'codeagentswarm', audience: 'codeagentswarm-relay',
    });
    assert.equal(claims.role, 'desktop');
    assert.equal(claims.runtimeId, 'host-1');
    assert.equal(ticket.relayOrigin, env.MOBILE_RELAY_URL);
    const device = { id: 'browser-1', name: 'My browser', publicKey: randomBytes(32).toString('base64url') };
    const credentialsResponse = await request('device-token', { runtimeId: 'host-1', device });
    assert.equal(credentialsResponse.status, 200);
    const credentials = await credentialsResponse.json();
    const deviceClaims = jwt.verify(credentials.deviceToken, env.MOBILE_RELAY_SECRET, {
      issuer: 'codeagentswarm', audience: 'codeagentswarm-mobile-relay',
    });
    assert.equal(deviceClaims.deviceId, device.id);
    assert.equal((await request('devices', null, credentials.deviceToken, 'GET')).status, 401);
    const listed = await (await request('devices', null, env.CAS_ACCESS_TOKEN, 'GET')).json();
    assert.equal(listed.devices.length, 1);
    assert.equal(listed.devices[0].refresh_token_hash, undefined);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);
    await stop();
    await start();
    const refreshedResponse = await request('refresh', { refreshToken: credentials.refreshToken }, '');
    assert.equal(refreshedResponse.status, 200);
    const refreshed = await refreshedResponse.json();
    assert.notEqual(refreshed.refreshToken, credentials.refreshToken);
    const replay = await (await request('refresh', { refreshToken: credentials.refreshToken }, '')).json();
    assert.equal(replay.refreshToken, refreshed.refreshToken);
    assert.equal((await request('device', null, refreshed.refreshToken, 'DELETE')).status, 204);
    assert.equal((await request('refresh', { refreshToken: refreshed.refreshToken }, '')).status, 401);
    assert.equal((await request('refresh', { refreshToken: credentials.refreshToken }, '')).status, 401);
    assert.throws(() => createControlPlane({ env: { ...env, CAS_ACCESS_TOKEN: 'short' }, databasePath: ':memory:' }), /CAS_ACCESS_TOKEN/);
    assert.throws(() => createControlPlane({ env: { ...env, CAS_WEB_ORIGIN: 'http://public.example' }, databasePath: ':memory:' }), /HTTPS/);
  } finally {
    if (server?.listening) await stop();
    rmSync(directory, { recursive: true, force: true });
  }
});
