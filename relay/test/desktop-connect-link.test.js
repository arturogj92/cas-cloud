import assert from 'node:assert/strict';
import test from 'node:test';

import worker from '../src/index.js';

const env = {
  MOBILE_RELAY_SECRET: 's'.repeat(32),
  RELAY_QUOTA: {},
};

test('serves a no-store Desktop launcher for a valid one-time pairing code', async () => {
  const response = await worker.fetch(new Request('https://connect.codeagentswarm.com/connect/7K9D-M2QF'), env);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(html, /codeagentswarm:\/\/connect\?code=7K9D-M2QF/);
  assert.match(html, /Open CodeAgentSwarm/);
});

test('rejects an invalid Desktop connection link without entering a Durable Object', async () => {
  const response = await worker.fetch(new Request('https://connect.codeagentswarm.com/connect/not-a-code'), env);
  assert.equal(response.status, 400);
});
