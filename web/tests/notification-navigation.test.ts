import assert from 'node:assert/strict';
import test from 'node:test';

import { notificationSessionId } from '../src/notification-navigation';
import { hostScopedId } from '../src/host-scope';

test('extracts only a valid session id from a notification response', () => {
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { sessionId: 'session-codex' } } } },
  }), 'session-codex');
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { sessionId: '' } } } },
  }), null);
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { sessionId: 42 } } } },
  }), null);
});

test('scopes a remote notification to the host that sent it', () => {
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { runtimeId: 'runtime-1', sessionId: 'session-codex' } } } },
  }), hostScopedId('runtime-1', 'session-codex'));
  const scoped = hostScopedId('runtime-1', 'session-codex');
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { runtimeId: 'runtime-1', sessionId: scoped } } } },
  }), scoped);
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { runtimeId: '../other-host', sessionId: 'session-codex' } } } },
  }), null);
  assert.equal(notificationSessionId({
    notification: { request: { content: { data: { runtimeId: 'runtime-2', sessionId: scoped } } } },
  }), null);
});
