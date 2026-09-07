import assert from 'node:assert/strict';
import test from 'node:test';
import { providerLoginDeviceCode } from '../src/provider-login';

test('extracts a provider device code without treating ordinary output as one', () => {
  assert.equal(providerLoginDeviceCode('Enter code: WDJB-MJHT'), 'WDJB-MJHT');
  assert.equal(providerLoginDeviceCode('Enter code: WDJB-MJHTQ'), 'WDJB-MJHTQ');
  assert.equal(providerLoginDeviceCode('Waiting for authorization…'), null);
});
