import assert from 'node:assert/strict';
import test from 'node:test';
import WebSocket from 'ws';

const relayOrigin = process.env.CAS_RELAY_URL;
const secret = process.env.MOBILE_RELAY_SECRET;
const encoder = new TextEncoder();

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function ticket(claims) {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({
    sub: 'user-1',
    iss: 'codeagentswarm',
    iat: now,
    exp: now + 120,
    ...claims,
  }));
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(`${header}.${payload}`));
  return `${header}.${payload}.${base64url(new Uint8Array(signature))}`;
}

async function connect(runtimeId) {
  const socket = new WebSocket(`${relayOrigin.replace(/^http/, 'ws')}/api/mobile/ws?runtime=${runtimeId}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const queue = [];
  const waiting = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queue.push(message);
  });
  return {
    socket,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for relay message')), 3_000);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    send(message) { socket.send(JSON.stringify(message)); },
  };
}

async function connectPeerGroup(groupId) {
  const socket = new WebSocket(`${relayOrigin.replace(/^http/, 'ws')}/api/mobile/peer-ws?group=${groupId}`);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  const queue = [];
  const waiting = [];
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    const resolve = waiting.shift();
    if (resolve) resolve(message);
    else queue.push(message);
  });
  return {
    socket,
    next() {
      if (queue.length) return Promise.resolve(queue.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Timed out waiting for peer-group message')), 3_000);
        waiting.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
    send(message) { socket.send(JSON.stringify(message)); },
  };
}

test('keeps a real socket usable after non-object JSON before and after authentication', {
  skip: !relayOrigin || !secret,
}, async () => {
  const runtimeId = `invalid-json-${Date.now()}`;
  const client = await connect(runtimeId);
  try {
    client.send(null);
    assert.equal((await client.next()).code, 'invalid_message');
    client.send({
      kind: 'hello.desktop', protocolVersion: 2,
      ticket: await ticket({ aud: 'codeagentswarm-relay', role: 'desktop', runtimeId }),
    });
    assert.equal((await client.next()).role, 'desktop');
    client.send(null);
    assert.equal((await client.next()).code, 'invalid_message');
    client.send({ kind: 'unsupported' });
    assert.equal((await client.next()).code, 'unsupported_message');
    assert.equal(client.socket.readyState, WebSocket.OPEN);
  } finally {
    client.socket.close();
  }
});

test('routes a peer batch inside one account Durable Object', {
  skip: !relayOrigin || !secret,
}, async () => {
  const relayGroupId = 'G'.repeat(43);
  const firstRuntimeId = `group-first-${Date.now()}`;
  const secondRuntimeId = `group-second-${Date.now()}`;
  const first = await connectPeerGroup(relayGroupId);
  first.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: firstRuntimeId,
      relayGroupId, publicKey: 'A'.repeat(43),
    }),
  });
  assert.equal((await first.next()).role, 'peer');

  const second = await connectPeerGroup(relayGroupId);
  second.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: secondRuntimeId,
      relayGroupId, publicKey: 'B'.repeat(43),
    }),
  });
  assert.equal((await second.next()).role, 'peer');
  assert.deepEqual(await first.next(), { kind: 'peer.online', targetRuntimeId: secondRuntimeId });

  const legacyRuntimeId = `group-legacy-${Date.now()}`;
  const legacy = await connect(legacyRuntimeId);
  legacy.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: legacyRuntimeId,
      publicKey: 'L'.repeat(43),
    }),
  });
  assert.equal((await legacy.next()).role, 'desktop');

  const wrongGroup = await connectPeerGroup(relayGroupId);
  wrongGroup.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: 'wrong-group-runtime',
      relayGroupId: 'H'.repeat(43), publicKey: 'W'.repeat(43),
    }),
  });
  assert.equal((await wrongGroup.next()).code, 'invalid_relay_ticket');
  wrongGroup.socket.terminate();

  const foreignOwner = await connectPeerGroup(relayGroupId);
  foreignOwner.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      sub: 'user-2', aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: 'foreign-owner-runtime',
      relayGroupId, publicKey: 'F'.repeat(43),
    }),
  });
  assert.equal((await foreignOwner.next()).code, 'runtime_not_authorized');
  foreignOwner.socket.terminate();

  const boxes = ['C', 'D', 'E'].map((character) => ({
    nonce: character.repeat(32),
    ciphertext: character.repeat(22),
  }));
  first.send({
    kind: 'peer.batch',
    messages: boxes.map((box) => ({ targetRuntimeId: secondRuntimeId, stream: 'to-client', box })),
  });
  for (const box of boxes) {
    assert.deepEqual(await second.next(), {
      kind: 'peer.message',
      sourceRuntimeId: firstRuntimeId,
      sourcePublicKey: 'A'.repeat(43),
      stream: 'to-client',
      box,
    });
  }
  first.send({
    kind: 'peer.message',
    targetRuntimeId: legacyRuntimeId,
    stream: 'to-runtime',
    box: boxes[0],
  });
  assert.deepEqual(await legacy.next(), {
    kind: 'peer.message',
    sourceRuntimeId: firstRuntimeId,
    sourcePublicKey: 'A'.repeat(43),
    stream: 'to-runtime',
    box: boxes[0],
  });

  first.send({
    kind: 'peer.batch',
    messages: Array.from({ length: 65 }, () => ({
      targetRuntimeId: secondRuntimeId,
      stream: 'to-client',
      box: boxes[0],
    })),
  });
  assert.equal((await first.next()).code, 'invalid_peer_message');

  first.send({
    kind: 'peer.message',
    targetRuntimeId: 'offline-runtime',
    stream: 'to-runtime',
    box: boxes[0],
  });
  assert.deepEqual(await first.next(), { kind: 'peer.offline', targetRuntimeId: 'offline-runtime' });

  first.socket.terminate();
  second.socket.terminate();
  legacy.socket.terminate();
});

test('pairs and forwards only opaque encrypted boxes through a real local Durable Object', {
  skip: !relayOrigin || !secret,
}, async () => {
  const runtimeId = 'integration-runtime';
  const desktop = await connect(runtimeId);
  const desktopTicket = await ticket({
    aud: 'codeagentswarm-relay', role: 'desktop', runtimeId, publicKey: 'A'.repeat(43),
    client: 'desktop', version: '2.4.0', channel: 'development', platform: 'darwin',
  });
  desktop.send({ kind: 'hello.desktop', protocolVersion: 2, ticket: desktopTicket });
  const desktopAccepted = await desktop.next();
  assert.equal(desktopAccepted.kind, 'hello.accepted');
  assert.match(desktopAccepted.connection, /^[a-f0-9]{10}$/);

  const attacker = await connect(runtimeId);
  attacker.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      sub: 'user-2', aud: 'codeagentswarm-relay', role: 'desktop', runtimeId,
    }),
  });
  assert.equal((await attacker.next()).code, 'runtime_not_authorized');
  attacker.socket.terminate();

  const peerRuntimeId = 'integration-peer-runtime';
  const peer = await connect(peerRuntimeId);
  peer.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: peerRuntimeId, publicKey: 'Z'.repeat(43),
    }),
  });
  assert.equal((await peer.next()).kind, 'hello.accepted');
  const peerBox = { nonce: 'J'.repeat(32), ciphertext: 'K'.repeat(22) };
  desktop.send({ kind: 'peer.message', targetRuntimeId: peerRuntimeId, stream: 'to-runtime', box: peerBox });
  assert.deepEqual(await peer.next(), {
    kind: 'peer.message',
    sourceRuntimeId: runtimeId,
    sourcePublicKey: 'A'.repeat(43),
    stream: 'to-runtime',
    box: peerBox,
  });
  const responseBoxes = 'MNOPQRSTUVWX'.split('').map((character) => ({
    nonce: `${'L'.repeat(31)}${character}`,
    ciphertext: character.repeat(22),
  }));
  for (const box of responseBoxes) {
    peer.send({ kind: 'peer.message', targetRuntimeId: runtimeId, stream: 'to-client', box });
  }
  for (const box of responseBoxes) {
    assert.deepEqual(await desktop.next(), {
      kind: 'peer.message',
      sourceRuntimeId: peerRuntimeId,
      sourcePublicKey: 'Z'.repeat(43),
      stream: 'to-client',
      box,
    });
  }

  const foreignRuntimeId = 'integration-foreign-runtime';
  const foreign = await connect(foreignRuntimeId);
  foreign.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({
      sub: 'user-2', aud: 'codeagentswarm-relay', role: 'desktop', runtimeId: foreignRuntimeId, publicKey: 'Y'.repeat(43),
    }),
  });
  assert.equal((await foreign.next()).kind, 'hello.accepted');
  desktop.send({ kind: 'peer.message', targetRuntimeId: foreignRuntimeId, stream: 'to-runtime', box: peerBox });
  assert.deepEqual(await desktop.next(), { kind: 'peer.offline', targetRuntimeId: foreignRuntimeId });

  desktop.send({
    kind: 'pair.create',
    requestId: 'request-1',
    desktopPublicKey: 'A'.repeat(43),
    backendOrigin: 'https://api.codeagentswarm.test',
  });
  const created = await desktop.next();
  const pairingLifetimeMs = created.expiresAt - Date.now();
  assert.ok(pairingLifetimeMs > 295_000 && pairingLifetimeMs <= 300_000);
  assert.match(created.pairingCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  const codeResponse = await fetch(`${relayOrigin}/api/mobile/pairing-code/${created.pairingCode.toLowerCase()}`);
  assert.equal(codeResponse.status, 200);
  assert.equal(codeResponse.headers.get('cache-control'), 'no-store');
  const resolved = new URL((await codeResponse.json()).pairingUri);
  assert.equal(resolved.protocol, 'codeagentswarm:');
  assert.equal(resolved.searchParams.get('runtime'), runtimeId);
  assert.equal(resolved.searchParams.get('token'), created.pairingToken);
  assert.equal(resolved.searchParams.get('key'), 'A'.repeat(43));
  assert.equal(resolved.searchParams.get('backend'), 'https://api.codeagentswarm.test');
  const mobile = await connect(runtimeId);
  mobile.send({
    kind: 'hello.pair',
    protocolVersion: 2,
    pairingToken: created.pairingToken,
    device: { id: 'phone-1', name: 'Test phone', publicKey: 'B'.repeat(43) },
  });
  const scanned = await desktop.next();
  assert.equal(scanned.kind, 'pair.scanned');
  assert.equal((await mobile.next()).kind, 'pair.challenge');
  assert.equal((await fetch(`${relayOrigin}/api/mobile/pairing-code/${created.pairingCode}`)).status, 410);

  const deviceToken = await ticket({
    aud: 'codeagentswarm-mobile-relay',
    role: 'mobile',
    runtimeId,
    deviceId: 'phone-1',
    deviceName: 'Test phone',
    publicKey: 'B'.repeat(43),
    tokenVersion: 1,
  });
  const refreshTokenBox = { nonce: 'E'.repeat(32), ciphertext: 'F'.repeat(22) };
  desktop.send({
    kind: 'pair.confirm',
    pairingId: scanned.pairingId,
    accept: true,
    deviceToken,
    refreshTokenBox,
  });
  assert.equal((await desktop.next()).kind, 'mobile.connected');
  assert.equal((await mobile.next()).kind, 'runtime.online');
  const mobileCompleted = await mobile.next();
  assert.equal(mobileCompleted.kind, 'pair.completed');
  assert.match(mobileCompleted.connection, /^[a-f0-9]{10}$/);
  assert.equal(mobileCompleted.deviceToken, deviceToken);
  assert.deepEqual(mobileCompleted.refreshTokenBox, refreshTokenBox);
  assert.equal(typeof mobileCompleted.accessExpiresAt, 'number');
  assert.equal((await desktop.next()).kind, 'pair.completed');

  const box = { nonce: 'C'.repeat(32), ciphertext: 'D'.repeat(22) };
  mobile.send({ kind: 'runtime.message', box });
  assert.deepEqual(await desktop.next(), { kind: 'runtime.message', deviceId: 'phone-1', box });
  desktop.send({ kind: 'runtime.message', deviceId: 'phone-1', box });
  assert.deepEqual(await mobile.next(), { kind: 'runtime.message', box });
  desktop.send({ kind: 'runtime.message', deviceId: 'phone-1', codec: 'deflate', box });
  assert.deepEqual(await mobile.next(), { kind: 'runtime.message', codec: 'deflate', box });
  desktop.send({ kind: 'runtime.message', deviceId: 'phone-1', codec: 'brotli', box });
  assert.deepEqual(await mobile.next(), { kind: 'runtime.message', box });
  const batchBoxes = ['G', 'H', 'I'].map((character) => ({
    nonce: character.repeat(32),
    ciphertext: character.repeat(22),
  }));
  desktop.send({
    kind: 'runtime.batch',
    deviceId: 'phone-1',
    messages: batchBoxes.map((batchBox, index) => ({
      ...(index === 1 ? { codec: 'deflate' } : {}),
      box: batchBox,
    })),
  });
  assert.deepEqual(await mobile.next(), { kind: 'runtime.message', box: batchBoxes[0] });
  assert.deepEqual(await mobile.next(), { kind: 'runtime.message', codec: 'deflate', box: batchBoxes[1] });
  assert.deepEqual(await mobile.next(), { kind: 'runtime.message', box: batchBoxes[2] });
  desktop.send({
    kind: 'runtime.batch',
    deviceId: 'phone-1',
    messages: Array.from({ length: 65 }, () => ({ box })),
  });
  assert.equal((await desktop.next()).code, 'invalid_runtime_message');

  desktop.socket.terminate();
  mobile.socket.terminate();
  peer.socket.terminate();
  foreign.socket.terminate();
});

test('stops an already-open mobile socket when its short access token expires', {
  skip: !relayOrigin || !secret,
}, async () => {
  const runtimeId = `expiry-runtime-${Date.now()}`;
  const desktop = await connect(runtimeId);
  desktop.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({ aud: 'codeagentswarm-relay', role: 'desktop', runtimeId }),
  });
  assert.equal((await desktop.next()).kind, 'hello.accepted');

  const mobile = await connect(runtimeId);
  mobile.send({
    kind: 'hello.mobile',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-mobile-relay',
      role: 'mobile',
      runtimeId,
      deviceId: 'expiring-phone',
      deviceName: 'Expiring phone',
      publicKey: 'G'.repeat(43),
      tokenVersion: 1,
      exp: Math.floor(Date.now() / 1000) + 5,
    }),
  });
  assert.equal((await desktop.next()).kind, 'mobile.connected');
  assert.equal((await mobile.next()).kind, 'runtime.online');
  assert.equal((await mobile.next()).kind, 'hello.accepted');

  await new Promise((resolve) => setTimeout(resolve, 5_200));
  mobile.send({
    kind: 'runtime.message',
    box: { nonce: 'H'.repeat(32), ciphertext: 'I'.repeat(22) },
  });
  assert.equal((await mobile.next()).code, 'mobile_token_expired');

  desktop.socket.terminate();
  mobile.socket.terminate();
});

test('renews an open mobile socket without interrupting relay traffic', {
  skip: !relayOrigin || !secret,
}, async () => {
  const runtimeId = `renew-runtime-${Date.now()}`;
  const deviceId = 'renewing-phone';
  const publicKey = 'R'.repeat(43);
  const desktop = await connect(runtimeId);
  desktop.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({ aud: 'codeagentswarm-relay', role: 'desktop', runtimeId }),
  });
  assert.equal((await desktop.next()).kind, 'hello.accepted');

  const mobile = await connect(runtimeId);
  mobile.send({
    kind: 'hello.mobile',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-mobile-relay',
      role: 'mobile',
      runtimeId,
      deviceId,
      deviceName: 'Renewing phone',
      publicKey,
      tokenVersion: 1,
      exp: Math.floor(Date.now() / 1000) + 2,
    }),
  });
  assert.equal((await desktop.next()).kind, 'mobile.connected');
  assert.equal((await mobile.next()).kind, 'runtime.online');
  assert.equal((await mobile.next()).kind, 'hello.accepted');

  mobile.send({
    kind: 'credential.renew',
    protocolVersion: 2,
    ticket: await ticket({
      aud: 'codeagentswarm-mobile-relay',
      role: 'mobile',
      runtimeId,
      deviceId,
      deviceName: 'Renewing phone',
      publicKey,
      tokenVersion: 1,
      exp: Math.floor(Date.now() / 1000) + 120,
    }),
  });
  const renewed = await mobile.next();
  assert.equal(renewed.kind, 'credential.renewed');
  assert.ok(renewed.accessExpiresAt > Date.now() + 60_000);

  await new Promise((resolve) => setTimeout(resolve, 2_100));
  const box = { nonce: 'S'.repeat(32), ciphertext: 'T'.repeat(22) };
  mobile.send({ kind: 'runtime.message', box });
  assert.deepEqual(await desktop.next(), { kind: 'runtime.message', deviceId, box });

  desktop.socket.terminate();
  mobile.socket.terminate();
});

test('keeps every tab for one paired device connected', {
  skip: !relayOrigin || !secret,
}, async () => {
  const runtimeId = `multi-tab-runtime-${Date.now()}`;
  const deviceId = 'same-browser-device';
  const publicKey = 'J'.repeat(43);
  const desktop = await connect(runtimeId);
  desktop.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({ aud: 'codeagentswarm-relay', role: 'desktop', runtimeId }),
  });
  assert.equal((await desktop.next()).kind, 'hello.accepted');

  const mobileTicket = await ticket({
    aud: 'codeagentswarm-mobile-relay',
    role: 'mobile',
    runtimeId,
    deviceId,
    deviceName: 'Same browser',
    publicKey,
    tokenVersion: 1,
  });
  const first = await connect(runtimeId);
  first.send({ kind: 'hello.mobile', protocolVersion: 2, ticket: mobileTicket });
  assert.equal((await desktop.next()).kind, 'mobile.connected');
  assert.equal((await first.next()).kind, 'runtime.online');
  assert.equal((await first.next()).kind, 'hello.accepted');

  const second = await connect(runtimeId);
  second.send({ kind: 'hello.mobile', protocolVersion: 2, ticket: mobileTicket });
  assert.equal((await second.next()).kind, 'runtime.online');
  assert.equal((await second.next()).kind, 'hello.accepted');

  const firstBox = { nonce: 'K'.repeat(32), ciphertext: 'L'.repeat(22) };
  desktop.send({ kind: 'runtime.message', deviceId, box: firstBox });
  assert.deepEqual(await first.next(), { kind: 'runtime.message', box: firstBox });
  assert.deepEqual(await second.next(), { kind: 'runtime.message', box: firstBox });

  first.socket.terminate();
  await new Promise((resolve) => setTimeout(resolve, 30));
  const secondBox = { nonce: 'M'.repeat(32), ciphertext: 'N'.repeat(22) };
  second.send({ kind: 'runtime.message', box: secondBox });
  assert.deepEqual(await desktop.next(), { kind: 'runtime.message', deviceId, box: secondBox });

  second.socket.terminate();
  assert.deepEqual(await desktop.next(), { kind: 'mobile.disconnected', deviceId });
  desktop.socket.terminate();
});

test('proxies a temporary localhost preview through the connected desktop', {
  skip: !relayOrigin || !secret,
}, async () => {
  const runtimeId = `preview-runtime-${Date.now()}`;
  const shareId = 'S'.repeat(43);
  const desktop = await connect(runtimeId);
  desktop.send({
    kind: 'hello.desktop',
    protocolVersion: 2,
    ticket: await ticket({ aud: 'codeagentswarm-relay', role: 'desktop', runtimeId }),
  });
  assert.equal((await desktop.next()).kind, 'hello.accepted');

  const pending = fetch(`${relayOrigin}/preview/${encodeURIComponent(runtimeId)}/${shareId}/dashboard?tab=live`);
  const request = await desktop.next();
  assert.equal(request.kind, 'preview.request');
  assert.equal(request.shareId, shareId);
  assert.equal(request.path, '/dashboard?tab=live');
  assert.match(request.proxyBase, new RegExp(`/preview/${runtimeId}/${shareId}$`));
  desktop.send({
    kind: 'preview.response',
    requestId: request.requestId,
    status: 200,
    headers: [['content-type', 'text/html; charset=utf-8']],
    bodyBase64: Buffer.from('<h1>Local preview</h1>').toString('base64'),
  });

  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(await response.text(), '<h1>Local preview</h1>');
  desktop.socket.terminate();
});
