import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appSource = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url).href), 'utf8');
const runtimeSource = readFileSync(fileURLToPath(new URL('../src/runtime.ts', import.meta.url).href), 'utf8');

test('an uncached notification still opens an interactive Chat while reconnecting', () => {
  assert.match(appSource, /const openingSession: StartingSession \| null = startingSession \|\| \(/);
  assert.match(appSource, /selectedId && !selected[\s\S]*?title: 'Opening conversation…'/);
  assert.match(appSource, /const chatLayerVisible = Boolean\(visibleSession \|\| openingSession\)/);
  assert.match(appSource, /const activeChatScreen = openingSession && !visibleSession[\s\S]*?session=\{openingSession\}/);
});

test('attention waits for the selected host and retries when that host reconnects', () => {
  const readEffect = appSource.match(/useEffect\(\(\) => \{\n    if \(!selected\?\.needsAttention[\s\S]*?\n  \}, \[client,[^\n]+\]\);/)?.[0];

  assert.ok(readEffect);
  assert.match(readEffect, /\(selected\.hostPhase \?\? runtime\.phase\) !== 'online'/);
  assert.match(readEffect, /selected\?\.hostPhase/);
});

test('an expired credential reports connecting before waiting for refresh', () => {
  const expiredCredentialBranch = runtimeSource.match(/if \(!this\.pairing && this\.savedConnection && this\.savedConnection\.accessExpiresAt <= Date\.now\(\)\) \{[\s\S]*?\n    \}/)?.[0];

  assert.ok(expiredCredentialBranch);
  assert.match(expiredCredentialBranch, /this\.setState\(\{ \.\.\.this\.state, phase: 'connecting', error: null \}\);[\s\S]*?await this\.refreshAccess\(\)/);
});

test('runtime bursts coalesce into bounded React renders', () => {
  assert.match(appSource, /const RUNTIME_RENDER_COALESCE_MS = 80;/);
  assert.match(appSource, /const liveRuntimeUpdates = coalesceLatest\(setLiveRuntime, RUNTIME_RENDER_COALESCE_MS\);\n    const unsubscribe = client\.subscribe\(liveRuntimeUpdates\.push\);/);
  assert.match(appSource, /unsubscribe\(\);\n      liveRuntimeUpdates\.cancel\(\);/);
  assert.doesNotMatch(appSource, /client\.subscribe\(setLiveRuntime\)/);
});

test('notification taps subscribe once through the latest openSession', () => {
  const notificationEffect = appSource.match(/useEffect\(\(\) => \{\n(?:(?!useEffect)[^])*?subscribeToNotificationResponses\([^]*?\n  \}, \[\]\);/)?.[0];

  assert.ok(notificationEffect, 'the notification subscription effect must not depend on runtime state');
  assert.match(notificationEffect, /openSessionRef\.current\(sessionId, false, 'notification'\)/);
  assert.match(appSource, /consumeContextMenuRequest=\{consumeWebContextMenuRequest\}/);
});

test('the replay cache persists on a debounce and flushes when the app suspends', () => {
  assert.match(runtimeSource, /const PERSIST_DEBOUNCE_MS = 1_500;/);
  assert.match(runtimeSource, /\}, PERSIST_DEBOUNCE_MS\);/);
  const suspend = runtimeSource.match(/setActive\(active: boolean\) \{[\s\S]*?\n  \}/)?.[0];

  assert.ok(suspend);
  assert.match(suspend, /this\.flushPersist\(\);/);
});

test('a reset welcome re-hydrates the open Chat instead of keeping the compact snapshot slice', () => {
  const welcomeBranch = runtimeSource.match(/if \(message\.kind === 'welcome'\) \{\n      const desktop = recordOrNull[\s\S]*?\n    \}\n  \}/)?.[0];

  assert.ok(welcomeBranch);
  assert.match(welcomeBranch, /message\.reset === true && this\.visibleSessionId && this\.subscriptionsSupported[^\n]*hydrateVisibleSession\(this\.visibleSessionId\)/);
});
