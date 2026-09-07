import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath, URL } from 'node:url';

const source = readFileSync(fileURLToPath(new URL('../src/push.ts', import.meta.url)), 'utf8');
const runtime = readFileSync(fileURLToPath(new URL('../src/runtime.ts', import.meta.url)), 'utf8');
const storage = readFileSync(fileURLToPath(new URL('../src/storage.ts', import.meta.url)), 'utf8');
const app = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url)), 'utf8');

test('notification setup reuses one permission check and does not reopen an already granted permission', () => {
  assert.match(source, /let notificationPermission: Promise<boolean> \| null = null/);
  assert.match(source, /Notifications\.getPermissionsAsync\(\)/);
  assert.match(source, /current\.granted === true[\s\S]*\? current[\s\S]*: await Notifications\.requestPermissionsAsync\(\)/);
  assert.equal(source.match(/requestPermissionsAsync\(\)/g)?.length, 1);
});

test('startup connects and syncs before notification registration can open system UI', () => {
  const startup = runtime.slice(runtime.indexOf('async start()'), runtime.indexOf('\n  stop()'));
  const welcome = runtime.slice(runtime.indexOf("if (message.kind === 'welcome')"), runtime.indexOf('\n  // Fire-and-forget'));
  assert.doesNotMatch(startup, /prepareLocalNotifications|registerRemotePush/);
  assert.match(welcome, /registerRemotePush/);
});

test('the persisted mobile switch suppresses local alerts and syncs remote push delivery', () => {
  assert.match(storage, /cas\.mobile\.notifications-enabled\.v1/);
  assert.match(storage, /loadMobileNotificationsEnabled/);
  assert.match(storage, /saveMobileNotificationsEnabled/);
  assert.match(source, /if \(!await loadMobileNotificationsEnabled\(\)\) return/);
  assert.match(source, /enabled: false/);
  assert.match(runtime, /setNotificationsEnabled\(enabled: boolean\)/);
  assert.match(app, /accessibilityRole="switch"/);
  assert.match(app, /accessibilityLabel=\{Platform\.OS === 'web' \? 'Desktop notifications' : 'Mobile notifications'\}/);
});
