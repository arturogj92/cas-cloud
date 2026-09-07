import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appSource = readFileSync(fileURLToPath(new URL('../App.tsx', import.meta.url).href), 'utf8');
const storageSource = readFileSync(fileURLToPath(new URL('../src/storage.ts', import.meta.url).href), 'utf8');

test('a full pending queue rejects the new message without dropping the oldest', () => {
  assert.match(appSource, /filter\(\(entry\) => !entry\.confirmed\)\.length >= 24/);
  assert.match(appSource, /Message queue is full/);
  assert.doesNotMatch(appSource, /\.slice\(-24\)/);
  assert.doesNotMatch(storageSource, /\.slice\(-24\)/);
});

test('retry rearms the failed entry in place instead of racing the queue limit', () => {
  const retry = appSource.match(/const retryPending = useCallback[\s\S]*?\n  \}, \[selected\]\);/)?.[0];

  assert.ok(retry);
  assert.match(retry, /id: Crypto\.randomUUID\(\)/);
  assert.match(retry, /queued: true/);
  assert.doesNotMatch(retry, /void send\(/);
});

test('startup sends wait for a writable session and late failures recover both queue identities', () => {
  assert.match(appSource, /runtime\.hosts\?\.some\(\(host\) => host\.phase === 'booting'\)/);
  assert.match(appSource, /session\.state !== 'starting'[\s\S]*?session\.state !== 'stopped'[\s\S]*?session\.hostPhase === 'online'/);
  assert.match(appSource, /session\.state === 'stopped' && session\.clientRequestId/);
  assert.match(appSource, /The session stopped before sending\. Your queued message was restored\./);
  assert.match(appSource, /setNewAgent\(candidate\.session\.agent\)/);
  assert.match(appSource, /setNewProject\(candidate\.session\.cwd\)/);
  assert.match(appSource, /candidate\.entries\.map\(\(entry\) => entry\.text\.trim\(\)\)/);
  assert.match(appSource, /const currentState = client\.getState\(\);[\s\S]*?currentState\.sessions\.find/);
  assert.match(appSource, /currentSession\.hostPhase !== 'online'/);
  assert.match(appSource, /for \(const sessionId of queueIds\) delete next\[sessionId\]/);
  assert.match(appSource, /queueIds\.includes\(window\.history\.state\?\.\[WEB_CHAT_HISTORY_KEY\]\)[\s\S]*?window\.history\.back\(\)/);
});
