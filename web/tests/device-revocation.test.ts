import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyPendingDeviceRevocation, revokeMobileDevice } from '../src/device-revocation';
import type { PendingDeviceRevocation, SavedConnection } from '../src/storage';

const connection: SavedConnection = {
  relayOrigin: 'https://relay.example',
  backendOrigin: 'https://api.example',
  deviceToken: 'device-token',
  refreshToken: 'refresh-secret',
  accessExpiresAt: Date.now() + 60_000,
  runtimeId: 'runtime-1',
  publicKey: 'public-key',
  secretKey: 'secret-key',
  desktopPublicKey: 'desktop-key',
};

test('revokes the server device with its refresh credential', async () => {
  const calls: Array<[string | URL | Request, RequestInit | undefined]> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push([input, init]);
    return { ok: true, status: 204 } as Response;
  };

  assert.equal(await revokeMobileDevice(connection, fetchImpl), true);
  assert.deepEqual(calls, [[
    'https://api.example/api/mobile/device',
    { method: 'DELETE', headers: { Authorization: 'Bearer refresh-secret' } },
  ]]);
});

test('keeps the local pairing when remote revocation is not confirmed', async () => {
  const fetchImpl: typeof fetch = async () => ({ ok: false, status: 503 } as Response);
  assert.equal(await revokeMobileDevice(connection, fetchImpl), false);
});

test('only revokes a pending device after its replacement is durable', () => {
  const pending: PendingDeviceRevocation = {
    id: 'pending-1',
    backendOrigin: connection.backendOrigin,
    refreshToken: connection.refreshToken,
    replacementRuntimeId: 'runtime-2',
  };

  assert.equal(classifyPendingDeviceRevocation(pending, connection), 'discard');
  assert.equal(classifyPendingDeviceRevocation(pending, { ...connection, refreshToken: 'new', runtimeId: 'runtime-2' }), 'revoke');
  assert.equal(classifyPendingDeviceRevocation(pending, null), 'wait');
});
