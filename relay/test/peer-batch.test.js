import assert from 'node:assert/strict';
import test from 'node:test';

globalThis.WebSocketRequestResponsePair ||= class WebSocketRequestResponsePair {};
const { RuntimeRelay } = await import('../src/index.js');

function socket(role, sent = [], details = {}) {
  let attachment = { role, rateCount: 1, ...details };
  return {
    deserializeAttachment: () => attachment,
    serializeAttachment: (next) => { attachment = next; },
    send: (raw) => sent.push(JSON.parse(raw)),
  };
}

test('rejects non-object JSON without interrupting the socket message queue', async () => {
  for (const role of ['pending', 'peer-pending', 'desktop', 'mobile', 'peer']) {
    let writes = 0;
    const quota = { prepare: () => ({
      bind() { return this; },
      async first() { writes += 1; return { allowed: true }; },
    }) };
    const sent = [];
    const source = socket(role, sent, { accessExpiresAt: Date.now() + 60_000 });
    const relay = new RuntimeRelay({
      setWebSocketAutoResponse() {},
      getWebSockets: () => [source],
    }, { RELAY_QUOTA: quota });
    for (const value of [null, [], 'text', 1, true]) {
      await relay.webSocketMessage(source, JSON.stringify(value));
      assert.equal(sent.at(-1).code, 'invalid_message', role);
    }
    assert.equal(sent.length, 5);
    assert.equal(writes, 2, 'invalid inputs keep the existing quota reservation bounds');
    await relay.webSocketMessage(source, '{');
    assert.equal(sent.at(-1).code, 'invalid_json', 'subsequent messages still run');
  }
});

test('preserves socket message order while quota writes are pending', async () => {
  const sent = [];
  const target = socket('peer', sent, { runtimeId: 'target-runtime', userId: 'user-1' });
  const pendingQuotaWrites = [];
  const quota = {
    prepare() {
      return {
        bind() { return this; },
        first: () => new Promise((resolve) => pendingQuotaWrites.push(resolve)),
      };
    },
  };
  const relay = new RuntimeRelay({
    setWebSocketAutoResponse() {},
    getWebSockets: () => [target],
  }, { RELAY_QUOTA: quota });
  const source = socket('peer', [], {
    userId: 'user-1',
    runtimeId: 'source-runtime',
    publicKey: 'S'.repeat(43),
  });
  const boxes = ['A', 'B'].map((value) => ({
    nonce: value.repeat(32),
    ciphertext: value.repeat(22),
  }));
  const messages = boxes.map((box) => JSON.stringify({
    kind: 'peer.message',
    targetRuntimeId: 'target-runtime',
    stream: 'to-client',
    box,
  }));

  const first = relay.webSocketMessage(source, messages[0]);
  await Promise.resolve();
  const second = relay.webSocketMessage(source, messages[1]);
  await Promise.resolve();
  assert.equal(pendingQuotaWrites.length, 1);

  pendingQuotaWrites.shift()({ allowed: true });
  await new Promise(setImmediate);
  assert.equal(pendingQuotaWrites.length, 1);
  pendingQuotaWrites.shift()({ allowed: true });
  await Promise.all([first, second]);

  assert.deepEqual(sent.map((message) => message.box), boxes);
});

test('reserves websocket quota instead of writing D1 for every message', async () => {
  let quotaWrites = 0;
  const quota = {
    prepare() {
      return {
        bind() { return this; },
        async first() {
          quotaWrites += 1;
          return { allowed: true };
        },
      };
    },
  };
  const sent = [];
  const target = socket('peer', sent, { runtimeId: 'target-runtime', userId: 'user-1' });
  const relayState = {
    setWebSocketAutoResponse() {},
    getWebSockets: () => [target],
  };
  const relayEnv = { RELAY_QUOTA: quota };
  let relay = new RuntimeRelay(relayState, relayEnv);
  const source = socket('peer', [], {
    userId: 'user-1',
    runtimeId: 'source-runtime',
    publicKey: 'S'.repeat(43),
  });
  const message = JSON.stringify({
    kind: 'peer.message',
    targetRuntimeId: 'target-runtime',
    stream: 'to-client',
    box: { nonce: 'A'.repeat(32), ciphertext: 'B'.repeat(22) },
  });

  for (let index = 0; index < 201; index += 1) {
    if (index === 2) relay = new RuntimeRelay(relayState, relayEnv);
    await relay.processWebSocketMessage(source, message);
  }

  assert.equal(quotaWrites, 6);
  assert.equal(sent.length, 201);
});

test('starts with an exact reservation after the UTC quota period changes', async () => {
  let quotaWrites = 0;
  const quota = {
    prepare() {
      return {
        bind() { return this; },
        async first() {
          quotaWrites += 1;
          return { allowed: true };
        },
      };
    },
  };
  const target = socket('peer', [], { runtimeId: 'target-runtime', userId: 'user-1' });
  const relay = new RuntimeRelay({
    setWebSocketAutoResponse() {},
    getWebSockets: () => [target],
  }, { RELAY_QUOTA: quota });
  const source = socket('peer', [], {
    userId: 'user-1',
    runtimeId: 'source-runtime',
    publicKey: 'S'.repeat(43),
    quotaDay: '2000-01-01',
    quotaMonth: '2000-01',
    quotaReservation: 100,
    quotaRemaining: 99,
  });

  await relay.processWebSocketMessage(source, JSON.stringify({
    kind: 'peer.message',
    targetRuntimeId: 'target-runtime',
    stream: 'to-client',
    box: { nonce: 'A'.repeat(32), ciphertext: 'B'.repeat(22) },
  }));

  const attachment = source.deserializeAttachment();
  assert.equal(quotaWrites, 1);
  assert.equal(attachment.quotaReservation, 1);
  assert.equal(attachment.quotaRemaining, 0);
  assert.notEqual(attachment.quotaDay, '2000-01-01');
});

test('keeps peer fallback batches together through the target Durable Object', async () => {
  const sent = [];
  const desktop = socket('desktop', sent);
  const state = {
    setWebSocketAutoResponse() {},
    getWebSockets: () => [desktop],
    storage: { get: async () => 'user-1' },
  };
  const relay = new RuntimeRelay(state, {});
  const boxes = ['A', 'B', 'C'].map((value) => ({
    nonce: value.repeat(32),
    ciphertext: value.repeat(22),
  }));

  const response = await relay.fetch(new Request('https://relay.internal/_peer/batch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      userId: 'user-1',
      sourceRuntimeId: 'source-runtime',
      sourcePublicKey: 'S'.repeat(43),
      messages: boxes.map((box) => ({ stream: 'to-client', box })),
    }),
  }));
  assert.equal(response.status, 202);
  assert.deepEqual(sent.map((message) => message.box), boxes);

  const groupSocket = socket('peer');
  const deliveries = [];
  relay.state.getWebSockets = () => [];
  relay.deliverPeerToRuntime = async (_source, messages) => {
    deliveries.push(messages);
    return new Response(null, { status: 202 });
  };
  await relay.relayPeerGroup(groupSocket, {
    userId: 'user-1',
    runtimeId: 'source-runtime',
    publicKey: 'S'.repeat(43),
    relayGroupId: 'G'.repeat(43),
  }, {
    kind: 'peer.batch',
    messages: boxes.map((box) => ({
      targetRuntimeId: 'target-runtime',
      stream: 'to-client',
      box,
    })),
  });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].length, 3);
});

test('backs off repeated fallback requests while a peer runtime is offline', async () => {
  let targetRequests = 0;
  let targetStatus = 503;
  const quota = {
    prepare(sql) {
      return {
        bind() { return this; },
        async first() {
          if (sql.includes('SELECT retry_at')) return null;
          return { day: '2026-09-01', day_requests: 1, day_units: 20, month: '2026-09', month_units: 20 };
        },
      };
    },
  };
  const relay = new RuntimeRelay({
    setWebSocketAutoResponse() {},
    getWebSockets: () => [],
  }, {
    RELAY_QUOTA: quota,
    RUNTIMES: {
      idFromName: (runtimeId) => runtimeId,
      get: () => ({
        fetch: async () => {
          targetRequests += 1;
          return new Response(null, { status: targetStatus });
        },
      }),
    },
  });
  const state = { userId: 'user-1', runtimeId: 'source-runtime', publicKey: 'S'.repeat(43) };
  const message = {
    targetRuntimeId: 'offline-runtime',
    stream: 'to-runtime',
    box: { nonce: 'A'.repeat(32), ciphertext: 'B'.repeat(22) },
  };

  const responses = await Promise.all(Array.from({ length: 20 }, () => (
    relay.deliverPeerToRuntime(state, message)
  )));
  assert.equal(targetRequests, 1);
  assert.equal(responses.filter((response) => response?.status === 503).length, 1);

  relay.peerFallbackBackoffs.get('offline-runtime').retryAt = 0;
  targetStatus = 202;
  assert.equal((await relay.deliverPeerToRuntime(state, message)).status, 202);
  assert.equal(targetRequests, 2);
  assert.equal(relay.peerFallbackBackoffs.has('offline-runtime'), false);
});
