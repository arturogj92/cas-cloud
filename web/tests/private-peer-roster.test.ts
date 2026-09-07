import assert from 'node:assert/strict';
import test from 'node:test';

import { privatePeerRoster, tokenOwnerId } from '../src/host-scope';

test('introduces every host paired to this Mobile/Web installation on the same private relay', () => {
  const mac = { runtimeId: 'mac', publicKey: 'M'.repeat(43), relayOrigin: 'https://relay.example.com', ownerId: 'arturo', name: 'Mac' };
  const cloud = { runtimeId: 'cloud', publicKey: 'C'.repeat(43), relayOrigin: 'https://relay.example.com', ownerId: 'arturo', name: 'CAS Cloud' };
  const foreignRelay = { runtimeId: 'other', publicKey: 'O'.repeat(43), relayOrigin: 'https://other.example.com', ownerId: 'arturo', name: 'Other' };
  const foreignOwner = { runtimeId: 'foreign', publicKey: 'F'.repeat(43), relayOrigin: mac.relayOrigin, ownerId: 'someone-else', name: 'Foreign' };

  assert.deepEqual(privatePeerRoster(mac, [mac, cloud, foreignRelay, foreignOwner]), [{
    runtimeId: 'cloud', publicKey: cloud.publicKey, name: 'CAS Cloud',
  }]);
  assert.deepEqual(privatePeerRoster(cloud, [mac, cloud]), [{
    runtimeId: 'mac', publicKey: mac.publicKey, name: 'Mac',
  }]);
});

test('reads the signed account subject used to isolate local host groups', () => {
  const payload = Buffer.from(JSON.stringify({ sub: 'account-1' })).toString('base64url');
  assert.equal(tokenOwnerId(`header.${payload}.signature`), 'account-1');
  assert.equal(tokenOwnerId('invalid'), null);
});
