import assert from 'node:assert/strict';
import test from 'node:test';

import { RuntimeRelay } from '../src/index.js';
import { verifyRelayTicket } from '../src/ticket.js';

const encoder = new TextEncoder();
const base64url = (value) => Buffer.from(value).toString('base64url');

async function sign(claims, secret) {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify(claims));
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

test('accepts scoped relay tickets and rejects tampering', async () => {
  const secret = 'relay-ticket-secret-long-enough-for-tests';
  const now = Math.floor(Date.now() / 1000);
  const token = await sign({
    sub: 'user-1',
    role: 'desktop',
    runtimeId: 'runtime-1',
    iss: 'codeagentswarm',
    aud: 'codeagentswarm-relay',
    iat: now,
    exp: now + 120,
  }, secret);

  assert.deepEqual(await verifyRelayTicket(token, secret, now), {
    sub: 'user-1',
    role: 'desktop',
    runtimeId: 'runtime-1',
    iss: 'codeagentswarm',
    aud: 'codeagentswarm-relay',
    iat: now,
    exp: now + 120,
  });
  const [header, payload, signature] = token.split('.');
  const tampered = `${header}.${payload}.${signature.startsWith('A') ? 'B' : 'A'}${signature.slice(1)}`;
  await assert.rejects(() => verifyRelayTicket(tampered, secret, now), /ticket/);
});

test('logs a bounded per-connection summary without relay payloads', async () => {
  globalThis.WebSocketRequestResponsePair = class WebSocketRequestResponsePair {};
  const attachment = {
    role: 'desktop',
    runtimeId: 'runtime-secret-1234567890',
    connectionId: 'trace-1234',
    client: 'cas-cloud',
    version: '0.4.0',
    channel: 'production',
    platform: 'linux',
    openedAt: Date.now() - 25,
    messageCount: 8,
    messageBytes: 4096,
    runtimeMessages: 6,
    peerMessages: 2,
    peerDelivered: 1,
    peerFailed: 1,
  };
  const socket = { deserializeAttachment: () => attachment };
  const relay = new RuntimeRelay({
    setWebSocketAutoResponse() {},
    getWebSockets: () => [socket],
    storage: { delete: async () => {} },
  }, {});
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(line);
  try {
    await relay.webSocketClose(socket, 1000, '', true);
  } finally {
    console.log = originalLog;
    delete globalThis.WebSocketRequestResponsePair;
  }

  const summary = JSON.parse(lines.at(-1));
  assert.equal(summary.event, 'connection.closed');
  assert.equal(summary.client, 'cas-cloud');
  assert.match(summary.runtime, /^[a-f0-9]{10}$/);
  assert.equal(summary.messages, 8);
  assert.equal(summary.bytes, 4096);
  assert.equal(summary.peerDelivered, 1);
  assert.equal(summary.peerFailed, 1);
  assert.ok(summary.durationMs >= 25);
  assert.equal(JSON.stringify(summary).includes('runtime-secret'), false);
  assert.equal(JSON.stringify(summary).includes('1234567890'), false);
});
