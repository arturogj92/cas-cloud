import assert from 'node:assert/strict';
import test from 'node:test';

import { migratePendingSendSessions, selectNextPendingDrain } from '../src/pending-send-queue';
import { hostScopedId } from '../src/host-scope';

const message = (id: string, createdAtMs: number) => ({
  id,
  createdAtMs,
  text: id,
  attachments: [],
  baselineMatches: 0,
  queued: true,
});

test('a restored session adopts its durable creation queue without duplicates', () => {
  const temporary = message('temporary', 1);
  const canonical = message('canonical', 2);
  const current = {
    'create-request': [temporary],
    'real-session': [canonical, temporary],
  };

  const next = migratePendingSendSessions(current, [{
    sessionId: 'real-session',
    clientRequestId: 'create-request',
    state: 'ready',
  }]);

  assert.deepEqual(next, { 'real-session': [temporary, canonical] });
  assert.notEqual(next, current);
});

test('an unrelated snapshot leaves the pending cache untouched', () => {
  const current = { 'create-request': [message('temporary', 1)] };
  assert.equal(migratePendingSendSessions(current, []), current);
});

test('a legacy queue follows its uniquely matching host-scoped session', () => {
  const queued = message('legacy', 1);
  const scoped = hostScopedId('runtime-1', 'session-1');
  assert.deepEqual(migratePendingSendSessions({ 'session-1': [queued] }, [{
    sessionId: scoped,
    clientRequestId: null,
    state: 'ready',
  }]), { [scoped]: [queued] });
});

test('a legacy queue stays put when two hosts share its raw session id', () => {
  const current = { 'session-1': [message('legacy', 1)] };
  assert.equal(migratePendingSendSessions(current, [
    { sessionId: hostScopedId('runtime-1', 'session-1'), clientRequestId: null, state: 'ready' },
    { sessionId: hostScopedId('runtime-2', 'session-1'), clientRequestId: null, state: 'ready' },
  ]), current);
});

test('a legacy queue stays put when more than one host is configured', () => {
  const current = { 'session-1': [message('legacy', 1)] };
  assert.equal(migratePendingSendSessions(current, [{
    sessionId: hostScopedId('runtime-1', 'session-1'),
    clientRequestId: null,
    state: 'ready',
  }], false), current);
});

test('drain waits while a session already has a send in flight', () => {
  const queued = message('second', 2);
  const inFlight = { ...message('first', 1), queued: false };
  const next = selectNextPendingDrain({
    session: [inFlight, queued],
  }, new Set(['session']));
  assert.equal(next, undefined);
});

test('drain picks the oldest queued send once the previous one is delivered', () => {
  const delivered = { ...message('first', 1), queued: false, delivered: true };
  const queued = message('second', 2);
  const next = selectNextPendingDrain({
    session: [delivered, queued],
  }, new Set(['session']));
  assert.equal(next?.entry.id, 'second');
});

test('another session can drain while one session is in flight', () => {
  const inFlight = { ...message('a1', 1), queued: false };
  const other = message('b1', 3);
  const next = selectNextPendingDrain({
    a: [inFlight, message('a2', 2)],
    b: [other],
  }, new Set(['a', 'b']));
  assert.equal(next?.sessionId, 'b');
  assert.equal(next?.entry.id, 'b1');
});

test('a stopped startup leaves its queue available for draft recovery', () => {
  const current = { 'create-request': [message('temporary', 1)] };
  assert.equal(migratePendingSendSessions(current, [{
    sessionId: 'failed-session',
    clientRequestId: 'create-request',
    state: 'stopped',
  }]), current);
});
