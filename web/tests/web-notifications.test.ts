import assert from 'node:assert/strict';
import test from 'node:test';
import {
  requestWebNotificationPermission,
  showWebSessionNotifications,
  subscribeToWebNotificationResponses,
} from '../src/web-notifications';

test('desktop web requests permission and opens the notified session', async () => {
  const originalNotification = globalThis.Notification;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  const shown: FakeNotification[] = [];
  let focused = false;

  class FakeNotification {
    static permission: NotificationPermission = 'default';
    static async requestPermission() {
      FakeNotification.permission = 'granted';
      return 'granted' as NotificationPermission;
    }

    onclick: ((event: Event) => void) | null = null;
    closed = false;

    constructor(public title: string, public options?: NotificationOptions) {
      shown.push(this);
    }

    close() {
      this.closed = true;
    }
  }

  const events = new EventTarget();
  const fakeWindow = Object.assign(events, { focus: () => { focused = true; } });
  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'hidden' } });

  try {
    assert.equal(await requestWebNotificationPermission(), true);
    let opened = '';
    const unsubscribe = subscribeToWebNotificationResponses((sessionId) => { opened = sessionId; });
    assert.equal(showWebSessionNotifications([{ sessionId: 'session-codex', title: 'Codex', body: 'Needs attention' }]), 1);
    assert.equal(shown[0]?.options?.tag, 'cas-session-session-codex');
    shown[0]?.onclick?.(new Event('click'));
    assert.equal(focused, true);
    assert.equal(opened, 'session-codex');
    assert.equal(shown[0]?.closed, true);
    unsubscribe();
  } finally {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: originalNotification });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  }
});

test('desktop web stays quiet while its tab is visible', () => {
  const originalNotification = globalThis.Notification;
  const originalWindow = globalThis.window;
  const originalDocument = globalThis.document;
  let shown = 0;

  class FakeNotification {
    static permission: NotificationPermission = 'granted';
    static requestPermission = async () => 'granted' as NotificationPermission;
    onclick: ((event: Event) => void) | null = null;
    constructor() { shown += 1; }
    close() {}
  }

  Object.defineProperty(globalThis, 'Notification', { configurable: true, value: FakeNotification });
  Object.defineProperty(globalThis, 'window', { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { visibilityState: 'visible' } });

  try {
    assert.equal(showWebSessionNotifications([{ sessionId: 'session-claude', title: 'Claude', body: 'Needs attention' }]), 0);
    assert.equal(shown, 0);
  } finally {
    Object.defineProperty(globalThis, 'Notification', { configurable: true, value: originalNotification });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: originalDocument });
  }
});
